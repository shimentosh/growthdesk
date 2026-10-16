import { Injectable } from "@nestjs/common";
import {
  dealInPeriod,
  localDay,
  periodBounds,
  rollUpTeam,
  summarizeForecast,
  weightedValue,
  type ForecastQueryT,
  type PeriodQueryT,
  type SalesTargetInputT,
} from "@growthdesk/shared";
import type { Prisma } from "../generated/prisma/client.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { AuditService } from "../core/audit.service.js";
import { badRequest, notFound } from "../common/errors.js";
import { actorId, holds, ownershipScope, ws, type RequestContext } from "../common/context.js";

/*
 * Sales targets (quotas) and the forecast for a month or quarter in the
 * workspace's time zone. The arithmetic lives in packages/shared/src/forecast.ts
 * (summarizeForecast); this file only gathers the rows.
 *
 * Visibility: the forecast needs deals.read. Someone holding records.view_all
 * or analytics.team sees every owner, the workspace's target and each team's
 * roll-up; anyone else sees what ownershipScope lets them see elsewhere (their
 * deals, unowned ones, their team's under team visibility) and their own
 * targets, and the total is the sum of those.
 *
 * Targets belong to a rep (userId), a team (teamId) or the whole workspace
 * (neither). A team's figures are its members' (TeamMember; a person can be in
 * several teams), except that a deactivated member's open pipeline is left out
 * — nobody is working it — while their wins still count.
 *
 * SalesTarget has no unique key (userId/teamId are null for the workspace, and
 * NULLs never collide in Postgres), so "one target per owner, period and
 * metric" is kept here: upsert takes a transaction-scoped advisory lock on
 * that key first.
 */

const dealSelect = {
  id: true,
  name: true,
  ownerId: true,
  value: true,
  currency: true,
  status: true,
  forecastCategory: true,
  expectedCloseDate: true,
  closedAt: true,
  stage: { select: { id: true, name: true, probability: true, color: true, kind: true } },
  owner: { select: { id: true, name: true } },
  contact: { select: { id: true, fullName: true } },
  company: { select: { id: true, name: true } },
} satisfies Prisma.DealSelect;

/** A Postgres DATE column holds a calendar day; Prisma reads and writes it as UTC midnight. */
const dateOnly = (day: string) => new Date(`${day}T00:00:00.000Z`);

@Injectable()
export class ForecastService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Everyone's figures (and the team target) or only what this person may see. */
  private seesTeam(ctx: RequestContext) {
    return holds(ctx, "records.view_all") || holds(ctx, "analytics.team");
  }

  private period(ctx: RequestContext, q: PeriodQueryT) {
    const w = ws(ctx);
    return periodBounds(q.periodType, q.periodStart ?? localDay(new Date(), w.timezone), w.timezone);
  }

  // ─── Targets ───────────────────────────────────────────────────────────────

  async targets(ctx: RequestContext, q: PeriodQueryT) {
    const w = ws(ctx);
    const p = this.period(ctx, q);
    const rows = await this.prisma.db.salesTarget.findMany({ where: { workspaceId: w.id, periodType: p.type, periodStart: dateOnly(p.from) }, orderBy: [{ metric: "asc" }, { createdAt: "asc" }] });
    const [users, teams] = await Promise.all([
      this.prisma.db.user.findMany({ where: { id: { in: rows.map((r) => r.userId).filter((v): v is string => Boolean(v)) } }, select: { id: true, name: true } }),
      this.prisma.db.team.findMany({ where: { workspaceId: w.id }, select: { id: true, name: true, color: true }, orderBy: { name: "asc" } }),
    ]);
    const name = new Map(users.map((u) => [u.id, u]));
    const team = new Map(teams.map((t) => [t.id, t]));
    return {
      period: { type: p.type, label: p.label, from: p.from, to: p.to, timeZone: p.timeZone },
      currency: w.currency,
      items: rows.map((r) => ({ ...this.targetDto(r), user: r.userId ? (name.get(r.userId) ?? null) : null, team: r.teamId ? (team.get(r.teamId) ?? null) : null })),
      teams,
    };
  }

  private targetDto(r: { id: string; userId: string | null; teamId: string | null; periodType: string; periodStart: Date; metric: string; target: Prisma.Decimal; currency: string; updatedAt: Date }) {
    return { id: r.id, userId: r.userId, teamId: r.teamId, periodType: r.periodType, periodStart: r.periodStart.toISOString().slice(0, 10), metric: r.metric, target: Number(r.target), currency: r.currency, updatedAt: r.updatedAt };
  }

  async setTarget(ctx: RequestContext, input: SalesTargetInputT) {
    const w = ws(ctx);
    const p = periodBounds(input.periodType, input.periodStart, w.timezone);
    // Money is single-currency (forecast.ts): a revenue target in another currency could never be compared.
    const currency = input.currency ?? w.currency;
    if (input.metric === "revenue_won" && currency !== w.currency) throw badRequest(`Revenue targets are in the workspace currency (${w.currency}).`, { currency: `Use ${w.currency}` });
    if (input.metric !== "revenue_won" && !Number.isInteger(input.target)) throw badRequest("A count target is a whole number.", { target: "Use a whole number" });
    const row = await this.prisma.db.$transaction(async (tx) => {
      if (input.userId && !(await tx.membership.findUnique({ where: { workspaceId_userId: { workspaceId: w.id, userId: input.userId } } }))) throw badRequest("Targets are for members of this workspace", { userId: "Not a member" });
      if (input.teamId && !(await tx.team.findFirst({ where: { id: input.teamId, workspaceId: w.id }, select: { id: true } }))) throw badRequest("That team is not in this workspace", { teamId: "Unknown team" });
      const key = { workspaceId: w.id, userId: input.userId, teamId: input.teamId, periodType: p.type, periodStart: dateOnly(p.from), metric: input.metric };
      const owner = input.userId ? `user:${input.userId}` : input.teamId ? `team:${input.teamId}` : "workspace";
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`sales-target:${w.id}:${owner}:${p.type}:${p.from}:${input.metric}`}))`;
      const existing = await tx.salesTarget.findFirst({ where: key, select: { id: true } });
      if (existing) return tx.salesTarget.update({ where: { id: existing.id, workspaceId: w.id }, data: { target: input.target, currency } });
      return tx.salesTarget.create({ data: { ...key, target: input.target, currency, createdById: actorId(ctx) } });
    });
    await this.audit.record(ctx, { action: "target.set", targetType: "sales_target", targetId: row.id, metadata: { userId: input.userId, teamId: input.teamId, period: `${p.type}:${p.from}`, metric: input.metric, target: input.target, currency } });
    return this.targetDto(row);
  }

  async deleteTarget(ctx: RequestContext, id: string) {
    const w = ws(ctx);
    const row = await this.prisma.db.salesTarget.findFirst({ where: { id, workspaceId: w.id } });
    if (!row) throw notFound("That target");
    await this.prisma.db.salesTarget.delete({ where: { id, workspaceId: w.id } });
    await this.audit.record(ctx, { action: "target.deleted", targetType: "sales_target", targetId: id, metadata: { userId: row.userId, teamId: row.teamId, period: `${row.periodType}:${row.periodStart.toISOString().slice(0, 10)}`, metric: row.metric } });
  }

  // ─── Forecast ──────────────────────────────────────────────────────────────

  async forecast(ctx: RequestContext, q: ForecastQueryT) {
    const w = ws(ctx);
    const p = this.period(ctx, q);
    const team = this.seesTeam(ctx);
    const me = ctx.identity?.userId ?? null;
    const ownerId = q.ownerId === "me" ? me : q.ownerId || null;
    // Without the team view, ownershipScope narrows deals and meetings the way every other list is narrowed.
    const scope = team ? {} : ownershipScope(ctx);
    const visible = team ? null : new Set(ctx.workspace?.visibleUserIds ?? (me ? [me] : []));
    const byOwner = ownerId ? { ownerId } : {};
    const db = this.prisma.db;

    const [filterTeam, inactive] = await Promise.all([
      q.teamId ? db.team.findFirst({ where: { id: q.teamId, workspaceId: w.id }, select: { id: true, name: true, color: true } }) : null,
      db.membership.findMany({ where: { workspaceId: w.id, deactivatedAt: { not: null } }, select: { userId: true } }),
    ]);
    if (q.teamId && !filterTeam) throw notFound("That team");
    const deactivated = new Set(inactive.map((m) => m.userId));
    const teamMembers = filterTeam ? (await db.teamMember.findMany({ where: { workspaceId: w.id, teamId: filterTeam.id }, select: { userId: true } })).map((m) => m.userId) : null;
    const byTeam = teamMembers ? [{ ownerId: { in: teamMembers } }] : [];

    const [rows, meetings, targets] = await Promise.all([
      db.deal.findMany({
        where: {
          workspaceId: w.id,
          deletedAt: null,
          ...byOwner,
          AND: [
            scope as Prisma.DealWhereInput,
            ...byTeam,
            { OR: [{ status: "won", closedAt: { gte: p.start, lt: p.end } }, { status: "open", expectedCloseDate: { gte: dateOnly(p.from), lte: dateOnly(p.to) } }] },
          ],
        },
        select: dealSelect,
        orderBy: [{ expectedCloseDate: "asc" }, { value: "desc" }],
        take: 5000,
      }),
      db.meeting.groupBy({
        by: ["ownerId"],
        where: { workspaceId: w.id, status: { not: "canceled" }, createdAt: { gte: p.start, lt: p.end }, ...byOwner, AND: [scope as Prisma.MeetingWhereInput, ...byTeam] },
        _count: { _all: true },
      }),
      db.salesTarget.findMany({ where: { workspaceId: w.id, periodType: p.type, periodStart: dateOnly(p.from) } }),
    ]);
    // A team's live pipeline leaves out deactivated members' open deals; their wins stay.
    const deals = teamMembers ? rows.filter((d) => !(d.status === "open" && d.ownerId && deactivated.has(d.ownerId))) : rows;

    const shownTargets = targets.filter((t) => {
      if (t.teamId) return team || t.teamId === q.teamId;
      if (t.userId === null) return team && !ownerId && !q.teamId;
      if (visible && !visible.has(t.userId)) return false;
      if (ownerId && t.userId !== ownerId) return false;
      return !teamMembers || teamMembers.includes(t.userId);
    });
    const summary = summarizeForecast({
      currency: w.currency,
      period: p,
      deals: deals.map((d) => ({ ...d, value: Number(d.value), probability: d.stage.probability })),
      targets: shownTargets.map((t) => ({ userId: t.userId, teamId: t.teamId, metric: t.metric, target: Number(t.target), currency: t.currency })),
      meetings: meetings.map((m) => ({ ownerId: m.ownerId, count: m._count._all })),
      owners: ownerId ? [ownerId] : (teamMembers ?? []).filter((id) => !deactivated.has(id)),
      teamTargets: team && !ownerId && !q.teamId,
      totalTeamId: ownerId ? null : (q.teamId ?? null),
    });

    // Each team's roll-up, for someone who sees everyone and is not looking at one person or one team already.
    const teams =
      team && !ownerId && !q.teamId
        ? await db.team.findMany({ where: { workspaceId: w.id }, select: { id: true, name: true, color: true, members: { select: { userId: true } } }, orderBy: { name: "asc" } })
        : [];
    const teamRows = teams.map((t) => ({
      team: { id: t.id, name: t.name, color: t.color },
      memberIds: t.members.map((m) => m.userId),
      ...rollUpTeam({
        owners: summary.owners,
        memberIds: t.members.map((m) => m.userId),
        deactivated,
        targets: shownTargets.filter((x) => x.teamId === t.id && (x.metric !== "revenue_won" || x.currency === w.currency)).map((x) => ({ metric: x.metric, target: Number(x.target) })),
      }),
    }));

    const ids = summary.owners.map((o) => o.ownerId).filter((v): v is string => Boolean(v));
    const users = await db.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
    const name = new Map(users.map((u) => [u.id, u.name]));
    const owners = summary.owners
      .map((o) => ({ ...o, owner: o.ownerId ? { id: o.ownerId, name: name.get(o.ownerId) ?? "Former member" } : null, deactivated: Boolean(o.ownerId && deactivated.has(o.ownerId)) }))
      .sort((a, b) => Number(a.ownerId === null) - Number(b.ownerId === null) || b.won - a.won || b.projected - a.projected || (a.owner?.name ?? "").localeCompare(b.owner?.name ?? ""));

    return {
      period: { type: p.type, label: p.label, from: p.from, to: p.to, timeZone: p.timeZone },
      currency: w.currency,
      scope: team ? ("all" as const) : ("own" as const),
      ownerId,
      team: filterTeam,
      total: summary.total,
      owners,
      teams: teamRows,
      otherCurrencies: summary.otherCurrencies,
      ignoredTargets: summary.ignoredTargets,
      deals: deals.map((d) => {
        const value = Number(d.value);
        const open = dealInPeriod(d, p) === "open";
        return {
          id: d.id,
          name: d.name,
          owner: d.owner,
          contact: d.contact,
          company: d.company,
          stage: d.stage,
          value,
          currency: d.currency,
          status: d.status,
          forecastCategory: d.forecastCategory,
          expectedCloseDate: d.expectedCloseDate,
          closedAt: d.closedAt,
          /** In the workspace currency and open (not omitted): value × stage probability; else null. */
          weighted: open && d.currency === w.currency && d.forecastCategory !== "omitted" ? weightedValue(value, d.stage.probability) : null,
        };
      }),
    };
  }
}
