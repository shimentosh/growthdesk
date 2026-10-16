import { Injectable, Logger } from "@nestjs/common";
import { DEFAULT_LEAD_ROUTING, LeadRoutingInput, leastLoaded, nextInTurn, routeFor, type LeadRoutingT, type RoutingAssignT, type RoutingFacts } from "@growthdesk/shared";
import { PrismaService } from "../prisma/prisma.service.js";
import { ActivityService } from "../crm/activity.service.js";
import { AuditService } from "../core/audit.service.js";
import { NotificationsService } from "../notifications/notifications.service.js";
import { TeamsService } from "../teams/teams.service.js";
import { runAs } from "../common/actor.js";
import { ws, type RequestContext } from "../common/context.js";
import { badRequest, notFound } from "../common/errors.js";

/** Which events can bring a new, unowned contact: routing runs for their subjects a few seconds later. */
export const ROUTING_EVENTS = new Set(["contact.created", "lead.imported", "list.subscribed"]);
/** Long enough for the request that created the contact to finish adding it to lists. */
export const ROUTING_DELAY_MS = 5_000;

const FALLBACK = "fallback";

/**
 * Lead routing (packages/shared/src/lead-routing.ts for the rules): every
 * new unowned contact gets an owner by the workspace's rules. Stored in
 * Workspace.settings.leadRouting. Each assignment is on the contact's
 * timeline as "Lead routing · <rule>" (the system acting), and each new
 * owner gets one notification per batch.
 */
@Injectable()
export class LeadRoutingService {
  private readonly log = new Logger("lead-routing");

  constructor(
    private readonly prisma: PrismaService,
    private readonly activity: ActivityService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly teams: TeamsService,
  ) {}

  private read(settings: unknown): LeadRoutingT {
    const raw = (settings as { leadRouting?: unknown } | null)?.leadRouting;
    const parsed = raw ? LeadRoutingInput.safeParse(raw) : null;
    return parsed?.success ? parsed.data : DEFAULT_LEAD_ROUTING;
  }

  async get(ctx: RequestContext) {
    const w = ws(ctx);
    const row = await this.prisma.db.workspace.findUniqueOrThrow({ where: { id: w.id }, select: { settings: true } });
    return this.read(row.settings);
  }

  async save(ctx: RequestContext, input: LeadRoutingT) {
    const w = ws(ctx);
    const ids = new Set([...input.rules.flatMap((r) => r.assign.userIds), ...(input.fallback?.userIds ?? [])]);
    const teamIds = new Set([...input.rules.map((r) => r.assign.teamId), input.fallback?.teamId].filter((t): t is string => Boolean(t)));
    if (teamIds.size && (await this.prisma.db.team.count({ where: { workspaceId: w.id, id: { in: [...teamIds] } } })) !== teamIds.size) {
      throw badRequest("A rule names a team that is not in this workspace", { rules: "Unknown team" });
    }
    if (new Set(input.rules.map((r) => r.id)).size !== input.rules.length) throw badRequest("Each rule needs its own id");
    if (ids.size) {
      const members = await this.prisma.db.membership.findMany({ where: { workspaceId: w.id, userId: { in: [...ids] } }, select: { userId: true, role: true } });
      const ok = new Set(members.filter((m) => m.role !== "viewer").map((m) => m.userId));
      const bad = [...ids].filter((id) => !ok.has(id));
      if (bad.length) throw badRequest("Leads can only be routed to members who can own records (not viewers)", { rules: "Unknown or viewer member" });
    }
    const row = await this.prisma.db.workspace.findUniqueOrThrow({ where: { id: w.id }, select: { settings: true } });
    await this.prisma.db.workspace.update({ where: { id: w.id }, data: { settings: { ...((row.settings as object) ?? {}), leadRouting: input } as never } });
    await this.audit.record(ctx, { action: "workspace.lead_routing_changed", targetType: "workspace", targetId: w.id, metadata: { enabled: input.enabled, rules: input.rules.length, fallback: Boolean(input.fallback) } });
    return input;
  }

  /** Facts the rules read, for many contacts at once. */
  private async facts(workspaceId: string, ids: string[]) {
    const [contacts, lists] = await Promise.all([
      this.prisma.db.contact.findMany({
        where: { workspaceId, id: { in: ids } },
        select: { id: true, ownerId: true, deletedAt: true, archivedAt: true, leadSource: true, country: true, fullName: true, firstName: true, lastName: true, email: true, tags: { select: { tag: { select: { name: true } } } } },
      }),
      this.prisma.db.listMembership.findMany({ where: { workspaceId, contactId: { in: ids }, status: { in: ["subscribed", "pending"] } }, select: { contactId: true, list: { select: { name: true } } } }),
    ]);
    const listsOf = new Map<string, string[]>();
    for (const m of lists) listsOf.set(m.contactId, [...(listsOf.get(m.contactId) ?? []), m.list.name]);
    return contacts.map((c) => ({
      contact: c,
      facts: { leadSource: c.leadSource ?? "", country: c.country ?? "", tags: c.tags.map((t) => t.tag.name), lists: listsOf.get(c.id) ?? [] } satisfies RoutingFacts,
    }));
  }

  /**
   * Inbox routing: an open conversation nobody is assigned to goes to its
   * contact's owner (when that owner can still work: a member, not paused or
   * a viewer). By conversation ids (a reply came in) or by contact (it just
   * got an owner). Logged on the contact's timeline as the system.
   */
  async assignConversations(workspaceId: string, conversationIds: string[] | null, contactId?: string) {
    const rows = await this.prisma.db.conversation.findMany({
      where: { workspaceId, assigneeId: null, status: "open", contactId: contactId ?? { not: null }, ...(conversationIds ? { id: { in: conversationIds } } : {}) },
      select: { id: true, subject: true, displayName: true, handle: true, contact: { select: { id: true, ownerId: true } } },
      take: 200,
    });
    let assigned = 0;
    for (const c of rows) {
      const owner = c.contact?.ownerId;
      if (!owner || !c.contact) continue;
      const m = await this.prisma.db.membership.findUnique({ where: { workspaceId_userId: { workspaceId, userId: owner } }, select: { role: true, deactivatedAt: true, user: { select: { outOfOfficeUntil: true } } } });
      // An owner who is paused or away does not get it: it stays unassigned, in the team's queue.
      if (!m || m.role === "viewer" || m.deactivatedAt || (m.user.outOfOfficeUntil && m.user.outOfOfficeUntil > new Date())) continue;
      await runAs({ type: "system", name: "Inbox routing", ref: "routing:inbox" }, async () => {
        const res = await this.prisma.db.conversation.updateMany({ where: { workspaceId, id: c.id, assigneeId: null }, data: { assigneeId: owner } });
        if (!res.count) return;
        assigned++;
        const user = await this.prisma.db.user.findUnique({ where: { id: owner }, select: { name: true } });
        await this.activity.log({ workspaceId, contactId: c.contact!.id, type: "conversation.assigned", summary: `Conversation given to ${user?.name ?? "the contact's owner"} (contact owner): ${c.subject || c.displayName || c.handle || "conversation"}`, data: { conversationId: c.id, assigneeId: owner } });
      });
    }
    return { assigned };
  }

  /** Which rule would take this contact, and whom it would pick now (nothing is changed). */
  async test(ctx: RequestContext, contactId: string) {
    const w = ws(ctx);
    const cfg = await this.get(ctx);
    const [row] = await this.facts(w.id, [contactId]);
    if (!row) throw notFound("That contact");
    const hit = routeFor(cfg, row.facts);
    if (!hit) return { facts: row.facts, rule: null, fallback: false, ownerId: null, ownerName: null };
    const pool = await this.pool(w.id, hit.assign);
    const owner = await this.pick(w.id, hit.rule?.id ?? FALLBACK, hit.assign.mode, pool, new Map());
    const user = owner ? await this.prisma.db.user.findUnique({ where: { id: owner }, select: { name: true } }) : null;
    return { facts: row.facts, rule: hit.rule ? { id: hit.rule.id, name: hit.rule.name } : null, fallback: !hit.rule, ownerId: owner, ownerName: user?.name ?? null };
  }

  /** The members of a pool — the named people, or the team's members as it is now — who can still own records, in the pool's order. */
  private async pool(workspaceId: string, assign: RoutingAssignT) {
    const named = assign.teamId ? await this.teams.memberIds(workspaceId, assign.teamId) : assign.userIds;
    // Nobody absent gets new work: paused members and people marked away (outOfOfficeUntil in the future) are skipped.
    const members = await this.prisma.db.membership.findMany({
      where: {
        workspaceId,
        userId: { in: named },
        role: { not: "viewer" },
        deactivatedAt: null,
        user: { OR: [{ outOfOfficeUntil: null }, { outOfOfficeUntil: { lte: new Date() } }] },
      },
      select: { userId: true },
    });
    const ok = new Set(members.map((m) => m.userId));
    return named.filter((u) => ok.has(u));
  }

  /** Last person this rule (or the fallback) routed to, from the timeline — so turns survive restarts. */
  private async lastRouted(workspaceId: string, ruleId: string): Promise<string | null> {
    const last = await this.prisma.db.activity.findFirst({ where: { workspaceId, actorRef: `routing:${ruleId}`, type: "contact.assigned" }, orderBy: { occurredAt: "desc" }, select: { data: true } });
    const owner = (last?.data as { ownerId?: unknown } | null)?.ownerId;
    return typeof owner === "string" ? owner : null;
  }

  /** `turns` carries each rule's last pick through a batch; `load` the balanced counts. */
  private async pick(workspaceId: string, ruleId: string, mode: RoutingAssignT["mode"], pool: string[], turns: Map<string, string | null>, load?: Map<string, number>) {
    if (!pool.length) return null;
    if (mode === "user") return pool[0]!;
    if (mode === "balanced") {
      let counts = load;
      if (!counts) {
        const rows = await this.prisma.db.contact.groupBy({ by: ["ownerId"], where: { workspaceId, ownerId: { in: pool }, deletedAt: null, archivedAt: null, lifecycleStage: { in: ["lead", "sales"] } }, _count: { _all: true } });
        counts = new Map(rows.map((r) => [r.ownerId!, r._count._all]));
      }
      return leastLoaded(pool, counts);
    }
    if (!turns.has(ruleId)) turns.set(ruleId, await this.lastRouted(workspaceId, ruleId));
    return nextInTurn(pool, turns.get(ruleId) ?? null);
  }

  /**
   * Routes these contacts if the workspace routes leads and they are still
   * new, unowned and active. Safe to run twice: an owned contact is left alone.
   */
  async route(workspaceId: string, contactIds: string[]) {
    const ids = [...new Set(contactIds)];
    if (!ids.length) return { routed: 0 };
    const w = await this.prisma.db.workspace.findUnique({ where: { id: workspaceId }, select: { settings: true, status: true } });
    if (!w || w.status === "suspended") return { routed: 0 };
    const cfg = this.read(w.settings);
    if (!cfg.enabled) return { routed: 0 };

    const rows = (await this.facts(workspaceId, ids)).filter((r) => !r.contact.ownerId && !r.contact.deletedAt && !r.contact.archivedAt);
    const turns = new Map<string, string | null>();
    const loads = new Map<string, Map<string, number>>();
    const pools = new Map<string, string[]>();
    const handed = new Map<string, { names: string[]; ids: string[] }>();
    let routed = 0;

    for (const { contact, facts } of rows) {
      const hit = routeFor(cfg, facts);
      if (!hit) continue;
      const ruleId = hit.rule?.id ?? FALLBACK;
      if (!pools.has(ruleId)) pools.set(ruleId, await this.pool(workspaceId, hit.assign));
      const pool = pools.get(ruleId)!;
      let load = loads.get(ruleId);
      if (hit.assign.mode === "balanced" && !load) {
        const rows2 = await this.prisma.db.contact.groupBy({ by: ["ownerId"], where: { workspaceId, ownerId: { in: pool }, deletedAt: null, archivedAt: null, lifecycleStage: { in: ["lead", "sales"] } }, _count: { _all: true } });
        load = new Map(rows2.map((r) => [r.ownerId!, r._count._all]));
        loads.set(ruleId, load);
      }
      const owner = await this.pick(workspaceId, ruleId, hit.assign.mode, pool, turns, load);
      if (!owner) continue;
      const ruleName = hit.rule?.name ?? "Fallback";
      const done = await runAs({ type: "system", name: `Lead routing · ${ruleName}`, ref: `routing:${ruleId}` }, async () =>
        this.prisma.db.$transaction(async (tx) => {
          // Only if still unowned: a person (or a workflow) may have claimed it meanwhile.
          const res = await tx.contact.updateMany({ where: { workspaceId, id: contact.id, ownerId: null }, data: { ownerId: owner } });
          if (!res.count) return false;
          const user = await tx.user.findUnique({ where: { id: owner }, select: { name: true } });
          await this.activity.log({ workspaceId, contactId: contact.id, type: "contact.assigned", summary: `Routed to ${user?.name ?? "a teammate"} (${hit.rule ? `rule: ${ruleName}` : "fallback"})`, data: { ownerId: owner, ruleId, ruleName } }, tx);
          return true;
        }),
      );
      if (!done) continue;
      routed++;
      // Their conversations so far (an inbound message often created the contact) go with them.
      await this.assignConversations(workspaceId, null, contact.id);
      turns.set(ruleId, owner);
      if (load) load.set(owner, (load.get(owner) ?? 0) + 1);
      const name = contact.fullName || [contact.firstName, contact.lastName].filter(Boolean).join(" ") || contact.email || "A new lead";
      const h = handed.get(owner) ?? { names: [], ids: [] };
      h.names.push(name);
      h.ids.push(contact.id);
      handed.set(owner, h);
    }

    for (const [owner, h] of handed) {
      const one = h.ids.length === 1;
      await this.notifications.notify(workspaceId, [owner], {
        type: "contact.assigned",
        title: one ? `New lead for you: ${h.names[0]}` : `${h.ids.length} new leads for you`,
        body: one ? "Routed to you by lead routing" : h.names.slice(0, 3).join(", ") + (h.names.length > 3 ? "…" : ""),
        link: one ? `/w/${workspaceId}/contacts/${h.ids[0]}` : `/w/${workspaceId}/leads?owner=me`,
      });
    }
    if (routed) this.log.log(`workspace ${workspaceId}: routed ${routed} lead(s)`);
    return { routed };
  }
}
