import { Injectable } from "@nestjs/common";
import type { RecordVisibilityT, TeamFocusInputT, TeamInputT } from "@growthdesk/shared";
import { PrismaService } from "../prisma/prisma.service.js";
import { AuditService } from "../core/audit.service.js";
import { NotificationsService } from "../notifications/notifications.service.js";
import { holds, ws, type RequestContext } from "../common/context.js";
import { badRequest, conflict, forbidden, notFound } from "../common/errors.js";
import { visibilityOf } from "../common/visibility.js";

/**
 * Teams and the workspace's record visibility (common/visibility.ts). The
 * list carries each team's workload — open leads, open deals, open tasks —
 * so a manager sees at a glance where work piles up.
 */
@Injectable()
export class TeamsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  async list(ctx: RequestContext) {
    const w = ws(ctx);
    const [teams, row] = await Promise.all([
      this.prisma.db.team.findMany({ where: { workspaceId: w.id }, include: { members: { select: { userId: true } } }, orderBy: { name: "asc" } }),
      this.prisma.db.workspace.findUniqueOrThrow({ where: { id: w.id }, select: { settings: true } }),
    ]);
    const userIds = [...new Set(teams.flatMap((t) => [...t.members.map((m) => m.userId), ...(t.leadUserId ? [t.leadUserId] : [])]))];
    const [users, leads, deals, tasks] = await Promise.all([
      this.prisma.db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true, email: true, title: true, outOfOfficeUntil: true } }),
      this.prisma.db.contact.groupBy({ by: ["ownerId"], where: { workspaceId: w.id, ownerId: { in: userIds }, deletedAt: null, archivedAt: null, lifecycleStage: { in: ["lead", "sales"] } }, _count: { _all: true } }),
      this.prisma.db.deal.groupBy({ by: ["ownerId"], where: { workspaceId: w.id, ownerId: { in: userIds }, deletedAt: null, status: "open" }, _count: { _all: true } }),
      this.prisma.db.task.groupBy({ by: ["assigneeId"], where: { workspaceId: w.id, assigneeId: { in: userIds }, status: "open" }, _count: { _all: true } }),
    ]);
    const user = new Map(users.map((u) => [u.id, u]));
    const count = (rows: { _count: { _all: number } }[], key: (r: never) => string | null) => new Map(rows.map((r) => [key(r as never), r._count._all]));
    const leadN = count(leads, (r: { ownerId: string | null }) => r.ownerId);
    const dealN = count(deals, (r: { ownerId: string | null }) => r.ownerId);
    const taskN = count(tasks, (r: { assigneeId: string | null }) => r.assigneeId);
    return {
      recordVisibility: visibilityOf(row.settings),
      teams: teams.map((t) => {
        const ids = t.members.map((m) => m.userId);
        const sum = (m: Map<string | null, number>) => ids.reduce((n, id) => n + (m.get(id) ?? 0), 0);
        return {
          id: t.id,
          name: t.name,
          description: t.description,
          color: t.color,
          lead: t.leadUserId ? { id: t.leadUserId, name: user.get(t.leadUserId)?.name ?? "" } : null,
          members: ids.map((id) => {
            const u = user.get(id);
            return { userId: id, name: u?.name ?? "", email: u?.email ?? "", title: u?.title ?? "", away: Boolean(u?.outOfOfficeUntil && u.outOfOfficeUntil > new Date()), openLeads: leadN.get(id) ?? 0, openDeals: dealN.get(id) ?? 0, openTasks: taskN.get(id) ?? 0 };
          }),
          workload: { openLeads: sum(leadN), openDeals: sum(dealN), openTasks: sum(taskN) },
        };
      }),
    };
  }

  private async checkMembers(workspaceId: string, input: TeamInputT) {
    const ids = [...new Set(input.memberIds)];
    if (ids.length) {
      const found = await this.prisma.db.membership.count({ where: { workspaceId, userId: { in: ids } } });
      if (found !== ids.length) throw badRequest("Every team member must be a member of this workspace", { memberIds: "Unknown member" });
    }
    if (input.leadUserId && !ids.includes(input.leadUserId)) throw badRequest("The team lead must be one of its members", { leadUserId: "Not in the team" });
    return ids;
  }

  async create(ctx: RequestContext, input: TeamInputT) {
    const w = ws(ctx);
    const ids = await this.checkMembers(w.id, input);
    if (await this.prisma.db.team.findFirst({ where: { workspaceId: w.id, name: { equals: input.name, mode: "insensitive" } } })) throw conflict(`There is already a team called ${input.name}`, { name: "Taken" });
    const team = await this.prisma.db.$transaction(async (tx) => {
      const t = await tx.team.create({ data: { workspaceId: w.id, name: input.name, description: input.description ?? "", color: input.color, leadUserId: input.leadUserId ?? null } });
      if (ids.length) await tx.teamMember.createMany({ data: ids.map((userId) => ({ teamId: t.id, workspaceId: w.id, userId })) });
      return t;
    });
    await this.audit.record(ctx, { action: "team.created", targetType: "team", targetId: team.id, metadata: { name: team.name, members: ids.length } });
    return { id: team.id };
  }

  async update(ctx: RequestContext, id: string, input: TeamInputT) {
    const w = ws(ctx);
    const team = await this.prisma.db.team.findFirst({ where: { id, workspaceId: w.id } });
    if (!team) throw notFound("That team");
    const ids = await this.checkMembers(w.id, input);
    const clash = await this.prisma.db.team.findFirst({ where: { workspaceId: w.id, id: { not: id }, name: { equals: input.name, mode: "insensitive" } } });
    if (clash) throw conflict(`There is already a team called ${input.name}`, { name: "Taken" });
    await this.prisma.db.$transaction(async (tx) => {
      await tx.team.update({ where: { id, workspaceId: w.id }, data: { name: input.name, description: input.description ?? "", color: input.color, leadUserId: input.leadUserId ?? null } });
      await tx.teamMember.deleteMany({ where: { workspaceId: w.id, teamId: id, userId: { notIn: ids } } });
      if (ids.length) await tx.teamMember.createMany({ data: ids.map((userId) => ({ teamId: id, workspaceId: w.id, userId })), skipDuplicates: true });
    });
    await this.audit.record(ctx, { action: "team.updated", targetType: "team", targetId: id, metadata: { name: input.name, members: ids.length } });
    return { id };
  }

  async remove(ctx: RequestContext, id: string) {
    const w = ws(ctx);
    const team = await this.prisma.db.team.findFirst({ where: { id, workspaceId: w.id } });
    if (!team) throw notFound("That team");
    await this.prisma.db.team.delete({ where: { id, workspaceId: w.id } });
    await this.audit.record(ctx, { action: "team.deleted", targetType: "team", targetId: id, metadata: { name: team.name } });
    return { deleted: true };
  }

  async setVisibility(ctx: RequestContext, recordVisibility: RecordVisibilityT) {
    const w = ws(ctx);
    const row = await this.prisma.db.workspace.findUniqueOrThrow({ where: { id: w.id }, select: { settings: true } });
    const before = visibilityOf(row.settings);
    await this.prisma.db.workspace.update({ where: { id: w.id }, data: { settings: { ...((row.settings as object) ?? {}), recordVisibility } as never } });
    if (before !== recordVisibility) await this.audit.record(ctx, { action: "workspace.record_visibility_changed", targetType: "workspace", targetId: w.id, metadata: { from: before, to: recordVisibility } });
    return { recordVisibility };
  }

  /**
   * The focus notes a person sees on Home: the workspace's, then one per team
   * they are in. Managers (analytics.team) see every team's too.
   */
  async focus(ctx: RequestContext) {
    const w = ws(ctx);
    const meId = ctx.identity?.userId ?? null;
    const all = holds(ctx, "analytics.team");
    const [row, teams] = await Promise.all([
      this.prisma.db.workspace.findUniqueOrThrow({ where: { id: w.id }, select: { settings: true } }),
      this.prisma.db.team.findMany({ where: { workspaceId: w.id, ...(all ? {} : { members: { some: { userId: meId ?? "00000000-0000-0000-0000-000000000000" } } }) }, select: { id: true, name: true, color: true, leadUserId: true }, orderBy: { name: "asc" } }),
    ]);
    const stored = focusOf(row.settings);
    return {
      workspace: stored.workspace ?? null,
      teams: teams.map((t) => ({ teamId: t.id, name: t.name, color: t.color, canEdit: all || t.leadUserId === meId, focus: stored.teams?.[t.id] ?? null })),
      canEditWorkspace: all,
    };
  }

  /** Pins (or clears) a focus note. Workspace-wide needs analytics.team; a team's, analytics.team or being its lead. */
  async setFocus(ctx: RequestContext, input: TeamFocusInputT) {
    const w = ws(ctx);
    const meId = ctx.identity?.userId ?? null;
    let team: { id: string; name: string; leadUserId: string | null } | null = null;
    if (input.teamId) {
      team = await this.prisma.db.team.findFirst({ where: { id: input.teamId, workspaceId: w.id }, select: { id: true, name: true, leadUserId: true } });
      if (!team) throw notFound("That team");
      if (!holds(ctx, "analytics.team") && (!meId || team.leadUserId !== meId)) throw forbidden("Only managers or the team's lead can set its focus");
    } else if (!holds(ctx, "analytics.team")) throw forbidden("Only managers can set the workspace's focus");
    const author = meId ? await this.prisma.db.user.findUnique({ where: { id: meId }, select: { name: true, email: true } }) : null;
    const note: FocusNote | null = input.text ? { text: input.text, updatedAt: new Date().toISOString(), byId: meId, byName: author?.name || author?.email || "" } : null;

    const row = await this.prisma.db.workspace.findUniqueOrThrow({ where: { id: w.id }, select: { settings: true } });
    const settings = (row.settings as Record<string, unknown>) ?? {};
    const stored = focusOf(settings);
    const teams = { ...(stored.teams ?? {}) };
    if (team) {
      if (note) teams[team.id] = note;
      else delete teams[team.id];
    }
    const next: StoredFocus = { workspace: team ? (stored.workspace ?? null) : note, teams };
    await this.prisma.db.workspace.update({ where: { id: w.id }, data: { settings: { ...settings, focus: next } as never } });
    await this.audit.record(ctx, { action: note ? "focus.set" : "focus.cleared", targetType: team ? "team" : "workspace", targetId: team?.id ?? w.id, metadata: { team: team?.name ?? null, length: input.text.length } });

    if (note && input.notify) {
      const to = team
        ? (await this.prisma.db.teamMember.findMany({ where: { workspaceId: w.id, teamId: team.id }, select: { userId: true } })).map((m) => m.userId)
        : (await this.prisma.db.membership.findMany({ where: { workspaceId: w.id, deactivatedAt: null }, select: { userId: true } })).map((m) => m.userId);
      await this.notifications.notify(
        w.id,
        to.filter((id) => id !== meId),
        { type: "focus", title: `${note.byName || "A manager"} set ${team ? `${team.name}'s` : "this week's"} focus`, body: note.text.slice(0, 280), link: "/" },
      );
    }
    return this.focus(ctx);
  }

  /** The members of a team (for routing pools and filters), in a stable order. */
  async memberIds(workspaceId: string, teamId: string): Promise<string[]> {
    const rows = await this.prisma.db.teamMember.findMany({ where: { workspaceId, teamId }, select: { userId: true }, orderBy: { createdAt: "asc" } });
    return rows.map((r) => r.userId);
  }
}

type FocusNote = { text: string; updatedAt: string; byId: string | null; byName: string };
type StoredFocus = { workspace?: FocusNote | null; teams?: Record<string, FocusNote> };
const focusOf = (settings: unknown): StoredFocus => {
  const f = (settings as { focus?: StoredFocus } | null)?.focus;
  return f && typeof f === "object" ? f : {};
};
