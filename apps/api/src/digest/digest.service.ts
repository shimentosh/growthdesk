import { Inject, Injectable, Logger } from "@nestjs/common";
import { Prisma } from "../generated/prisma/client.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { MailService } from "../core/mail.service.js";
import { AuditService } from "../core/audit.service.js";
import { NotificationsService } from "../notifications/notifications.service.js";
import { ws, type RequestContext } from "../common/context.js";
import { ACTOR_TYPES, type ActorType } from "../common/actor.js";
import {
  digestLinks,
  digestPeriod,
  isDue,
  isEmptyDigest,
  nextSendAt,
  readDigestSettings,
  renderDigest,
  STALE_LEAD_DAYS,
  WAITING_HOURS,
  zoneOf,
  type DigestData,
  type DigestFrequency,
  type DigestSettings,
  type DigestSettingsInputT,
} from "./digest.policy.js";

/** The clock the digest reads; tests replace `now`. */
export const DIGEST_CLOCK = Symbol("DIGEST_CLOCK");
export type DigestClock = { now: () => Date };

/** Who gets the digest. */
export const DIGEST_ROLES = ["owner", "admin", "manager"] as const;

type WorkspaceRow = { id: string; name: string; timezone: string; currency: string; settings: unknown };

const DAY = 86_400_000;

/*
 * The daily (or weekly) digest: what the team did, for owners, admins and
 * managers, by email and in the bell (docs in digest.policy.ts).
 *
 * Once only: the sweep builds a due digest, then claims the period with a
 * compare-and-set on Workspace.settings.digest.lastSentAt (the UPDATE only
 * matches while lastSentAt still holds the value the sweep read), and sends
 * only if that claim changed the row. Two workers racing on one workspace
 * both build, one claims, one sends. The claim is written with jsonb_set, so
 * it touches nothing else in settings.
 */
@Injectable()
export class DigestService {
  private readonly log = new Logger("digest");

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditService,
    @Inject(DIGEST_CLOCK) private readonly clock: DigestClock,
  ) {}

  now(): Date {
    return this.clock.now();
  }

  // ─── API ──────────────────────────────────────────────────────────────────

  async settings(ctx: RequestContext) {
    const w = ws(ctx);
    const row = await this.prisma.db.workspace.findUniqueOrThrow({ where: { id: w.id }, select: { settings: true, timezone: true } });
    return this.settingsDto(readDigestSettings(row.settings), row.timezone);
  }

  async saveSettings(ctx: RequestContext, input: DigestSettingsInputT) {
    const w = ws(ctx);
    const patch: Record<string, unknown> = {};
    if (input.enabled !== undefined) patch.enabled = input.enabled;
    if (input.frequency !== undefined) patch.frequency = input.frequency;
    if (input.hour !== undefined) patch.hour = input.hour;
    // Only settings.digest changes (merged), so a concurrent save of another setting is not lost.
    await this.prisma.unscoped.$executeRaw`
      UPDATE "Workspace"
      SET settings = jsonb_set(
        CASE WHEN jsonb_typeof(settings) = 'object' THEN settings ELSE '{}'::jsonb END,
        '{digest}',
        (CASE WHEN jsonb_typeof(settings->'digest') = 'object' THEN settings->'digest' ELSE '{}'::jsonb END) || ${JSON.stringify(patch)}::jsonb,
        true),
        "updatedAt" = now()
      WHERE id = ${w.id}::uuid`;
    await this.audit.record(ctx, { action: "workspace.digest_changed", targetType: "workspace", targetId: w.id, metadata: patch });
    return this.settings(ctx);
  }

  async preview(ctx: RequestContext, frequency?: DigestFrequency) {
    const w = ws(ctx);
    const row = await this.prisma.db.workspace.findUniqueOrThrow({ where: { id: w.id }, select: { id: true, name: true, timezone: true, currency: true, settings: true } });
    const now = this.now();
    const data = await this.build(row, frequency ?? readDigestSettings(row.settings).frequency, now);
    const rendered = renderDigest(data, (p) => this.mail.link(p));
    return { data, title: rendered.title, body: rendered.body, inApp: rendered.inApp };
  }

  private settingsDto(s: DigestSettings, timezone: string) {
    const tz = zoneOf(timezone);
    return { enabled: s.enabled, frequency: s.frequency, hour: s.hour, lastSentAt: s.lastSentAt, timezone: tz, nextSendAt: nextSendAt(s, this.now(), tz)?.toISOString() ?? null };
  }

  // ─── Building ─────────────────────────────────────────────────────────────

  async build(w: WorkspaceRow, frequency: DigestFrequency, now: Date): Promise<DigestData> {
    const tz = zoneOf(w.timezone);
    const period = digestPeriod(frequency, now, tz);
    const range = { gte: period.start, lt: period.end };
    const db = this.prisma.db;
    const wid = w.id;
    const liveContact = { workspaceId: wid, deletedAt: null, mergedIntoId: null } satisfies Prisma.ContactWhereInput;
    const staleCutoff = new Date(now.getTime() - STALE_LEAD_DAYS * DAY);
    const waitingCutoff = new Date(now.getTime() - WAITING_HOURS * 3_600_000);

    const [created, sources, unownedNow, won, lost, newDeals, byType, own, forThem, overdue, overdueBy, waiting, stale, noNextStep] = await Promise.all([
      db.contact.count({ where: { ...liveContact, createdAt: range } }),
      db.contact.groupBy({ by: ["leadSource"], where: { ...liveContact, createdAt: range }, _count: { _all: true } }),
      db.contact.count({ where: { ...liveContact, createdAt: range, ownerId: null } }),
      db.deal.groupBy({ by: ["currency"], where: { workspaceId: wid, deletedAt: null, status: "won", closedAt: range }, _count: { _all: true }, _sum: { value: true } }),
      db.deal.count({ where: { workspaceId: wid, deletedAt: null, status: "lost", closedAt: range } }),
      db.deal.count({ where: { workspaceId: wid, deletedAt: null, createdAt: range } }),
      db.activity.groupBy({ by: ["actorType"], where: { workspaceId: wid, occurredAt: range }, _count: { _all: true } }),
      db.activity.groupBy({ by: ["actorId"], where: { workspaceId: wid, occurredAt: range, actorType: "user", actorId: { not: null } }, _count: { _all: true } }),
      db.activity.groupBy({ by: ["onBehalfOfId"], where: { workspaceId: wid, occurredAt: range, actorType: "ai_agent", onBehalfOfId: { not: null } }, _count: { _all: true } }),
      db.task.count({ where: { workspaceId: wid, status: "open", dueAt: { lt: now } } }),
      db.task.groupBy({ by: ["assigneeId"], where: { workspaceId: wid, status: "open", dueAt: { lt: now }, assigneeId: { not: null } }, _count: { _all: true } }),
      db.conversation.count({
        where: {
          workspaceId: wid,
          status: "open",
          unread: true,
          lastInboundAt: { lt: waitingCutoff },
          OR: [{ snoozedUntil: null }, { snoozedUntil: { lte: now } }],
        },
      }),
      db.contact.count({
        where: {
          ...liveContact,
          archivedAt: null,
          lifecycleStage: { in: ["lead", "sales"] },
          createdAt: { lt: staleCutoff },
          activities: { none: { occurredAt: { gte: staleCutoff } } },
        },
      }),
      db.deal.count({ where: { workspaceId: wid, deletedAt: null, status: "open", tasks: { none: { status: "open" } } } }),
    ]);

    const byActorType = Object.fromEntries(ACTOR_TYPES.map((t) => [t, 0])) as Record<ActorType, number>;
    for (const g of byType) if ((ACTOR_TYPES as readonly string[]).includes(g.actorType)) byActorType[g.actorType as ActorType] += g._count._all;
    const total = Object.values(byActorType).reduce((a, b) => a + b, 0);

    const people = new Map<string, { own: number; byAi: number }>();
    for (const g of own) people.set(g.actorId!, { own: g._count._all, byAi: 0 });
    for (const g of forThem) {
      const p = people.get(g.onBehalfOfId!) ?? { own: 0, byAi: 0 };
      p.byAi += g._count._all;
      people.set(g.onBehalfOfId!, p);
    }
    const topPeopleIds = [...people.entries()]
      .sort((a, b) => b[1].own + b[1].byAi - (a[1].own + a[1].byAi))
      .slice(0, 5)
      .map(([id]) => id);
    const topOverdue = overdueBy
      .map((g) => ({ userId: g.assigneeId!, count: g._count._all }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 3);
    const userIds = [...new Set([...topPeopleIds, ...topOverdue.map((o) => o.userId)])];
    const users = userIds.length ? await db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true, email: true } }) : [];
    const user = new Map(users.map((u) => [u.id, u]));

    const inCurrency = won.find((g) => g.currency === w.currency);
    const wonCount = won.reduce((a, g) => a + g._count._all, 0);

    const data: Omit<DigestData, "empty"> = {
      workspace: { id: w.id, name: w.name, timezone: tz, currency: w.currency },
      period: { ...period, start: period.start.toISOString(), end: period.end.toISOString() },
      leads: {
        created,
        topSources: sources
          .map((s) => ({ source: s.leadSource.trim() || "Unknown", count: s._count._all }))
          .sort((a, b) => b.count - a.count || a.source.localeCompare(b.source))
          .slice(0, 3),
        unownedNow,
      },
      deals: {
        won: wonCount,
        wonValue: Number(inCurrency?._sum.value ?? 0),
        wonOtherCurrency: wonCount - (inCurrency?._count._all ?? 0),
        lost,
        created: newDeals,
      },
      activity: {
        total,
        byActorType,
        topPeople: topPeopleIds.map((id) => {
          const p = people.get(id)!;
          return { userId: id, name: user.get(id)?.name ?? "", email: user.get(id)?.email ?? "", own: p.own, byAi: p.byAi, total: p.own + p.byAi };
        }),
        aiActions: byActorType.ai_agent,
      },
      attention: {
        overdueTasks: { total: overdue, top: topOverdue.map((o) => ({ ...o, name: user.get(o.userId)?.name ?? "", email: user.get(o.userId)?.email ?? "" })) },
        waitingConversations: waiting,
        staleLeads: stale,
        dealsWithoutNextStep: noNextStep,
      },
      links: digestLinks(w.id),
    };
    return { ...data, empty: isEmptyDigest(data) };
  }

  // ─── Sending ──────────────────────────────────────────────────────────────

  /** Owners, admins and managers who can still sign in. */
  async recipients(workspaceId: string) {
    const rows = await this.prisma.db.membership.findMany({
      where: { workspaceId, role: { in: [...DIGEST_ROLES] }, deactivatedAt: null, user: { suspendedAt: null, closedAt: null } },
      select: { userId: true, user: { select: { email: true } } },
    });
    return rows.map((r) => ({ userId: r.userId, email: r.user.email }));
  }

  /**
   * Records `sentAt` as lastSentAt if it still holds `previous`. true = this
   * caller won the period and should send.
   */
  async claim(workspaceId: string, previous: string | null, sentAt: Date): Promise<boolean> {
    // Unscoped: Workspace is not a tenant row; the compare-and-set is on one workspace by id.
    const changed = await this.prisma.unscoped.$executeRaw`
      UPDATE "Workspace"
      SET settings = jsonb_set(
        CASE WHEN jsonb_typeof(settings) = 'object' THEN settings ELSE '{}'::jsonb END,
        '{digest}',
        (CASE WHEN jsonb_typeof(settings->'digest') = 'object' THEN settings->'digest' ELSE '{}'::jsonb END) || jsonb_build_object('lastSentAt', ${sentAt.toISOString()}::text),
        true)
      WHERE id = ${workspaceId}::uuid
        AND status = 'active'
        AND "deletedAt" IS NULL
        AND (settings->'digest'->>'lastSentAt') IS NOT DISTINCT FROM ${previous}::text`;
    return changed === 1;
  }

  /** One workspace: if its digest is due, build, claim and send it. */
  async runOne(w: WorkspaceRow & { status?: string }, now: Date): Promise<"sent" | "empty" | "not_due" | "taken"> {
    const s = readDigestSettings(w.settings);
    if (w.status && w.status !== "active") return "not_due";
    if (!isDue(s, now, w.timezone)) return "not_due";
    const data = await this.build(w, s.frequency, now);
    // The raw value as stored (readDigestSettings drops a malformed one; the compare must see what is there).
    const raw = ((w.settings as { digest?: { lastSentAt?: unknown } } | null)?.digest?.lastSentAt ?? null) as unknown;
    const previous = typeof raw === "string" ? raw : raw === null ? null : JSON.stringify(raw);
    // A period with nothing in it is recorded too, so the sweep does not rebuild it every 15 minutes.
    if (!(await this.claim(w.id, previous, now))) return "taken";
    if (data.empty) return "empty";
    const rendered = renderDigest(data, (p) => this.mail.link(p));
    const people = await this.recipients(w.id);
    for (const p of people) await this.mail.notification(p.email, rendered.title, rendered.body, data.links.activity);
    await this.notifications.notify(
      w.id,
      people.map((p) => p.userId),
      { type: "digest", title: rendered.title, body: rendered.inApp, link: data.links.activity },
    );
    this.log.log(`digest ${s.frequency} for ${w.id} sent to ${people.length}`);
    return "sent";
  }

  /** The 15-minute sweep: every active workspace whose digest is due. */
  async runDue(now: Date = this.now()) {
    const out = { sent: 0, empty: 0, taken: 0, failed: 0 };
    let cursor: string | undefined;
    for (;;) {
      // Unscoped by necessity: the sweep finds due digests across every workspace; each build re-scopes by workspace id.
      const page = await this.prisma.unscoped.workspace.findMany({
        where: { status: "active", deletedAt: null, ...(cursor ? { id: { gt: cursor } } : {}) },
        select: { id: true, name: true, timezone: true, currency: true, settings: true, status: true },
        orderBy: { id: "asc" },
        take: 500,
      });
      if (!page.length) break;
      cursor = page[page.length - 1]!.id;
      for (const w of page) {
        try {
          const r = await this.runOne(w, now);
          if (r === "sent" || r === "empty" || r === "taken") out[r] += 1;
        } catch (e) {
          out.failed += 1;
          this.log.error(`digest for ${w.id} failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      if (page.length < 500) break;
    }
    return out;
  }
}
