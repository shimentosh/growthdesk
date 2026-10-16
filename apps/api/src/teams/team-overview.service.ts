import { Injectable } from "@nestjs/common";
import { Prisma } from "../generated/prisma/client.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { ws, type RequestContext } from "../common/context.js";
import { notFound } from "../common/errors.js";

const DAY = 86_400_000;
/** A lead nobody has touched for this long is stale. */
export const STALE_DAYS = 14;
/** Speed to lead looks at leads that arrived in this window. */
export const SPEED_WINDOW_DAYS = 30;
/** What counts as reaching out to a lead: a person (or an AI agent for them) emailing, calling or booking. */
const TOUCH = Prisma.sql`(a.type IN ('email.sent', 'meeting.booked') OR a.type LIKE 'call.%') AND a."actorType" IN ('user', 'ai_agent')`;

export type OverviewAlert = {
  key: string;
  severity: "high" | "medium" | "low";
  count: number;
  title: string;
  hint: string;
  /** A path under /w/:id. */
  href: string;
  userId?: string;
};

type Counts = Map<string, number>;
const n = (m: Counts, k: string) => m.get(k) ?? 0;

/**
 * The manager's view of the team right now: who carries what, where work is
 * slipping (overdue tasks, stale leads, replies waiting, deals with no next
 * step), how fast new leads get a first touch, and alerts that point at the
 * filtered list to fix them. Everything is grouped in the database, so it
 * costs the same for five people or five hundred.
 *
 * Who is in it: active members who can own work (not viewers, not paused),
 * or the members of one team. Paused people show up only as an alert while
 * they still own open work.
 */
@Injectable()
export class TeamOverviewService {
  constructor(private readonly prisma: PrismaService) {}

  async overview(ctx: RequestContext, q: { teamId?: string }, now = new Date()) {
    const w = ws(ctx);
    const db = this.prisma.db;
    const wid = w.id;
    let teamIds: string[] | null = null;
    if (q.teamId) {
      const team = await db.team.findFirst({ where: { id: q.teamId, workspaceId: wid }, select: { id: true, members: { select: { userId: true } } } });
      if (!team) throw notFound("That team");
      teamIds = team.members.map((m) => m.userId);
    }
    const memberships = await db.membership.findMany({
      where: { workspaceId: wid, ...(teamIds ? { userId: { in: teamIds } } : {}) },
      select: { role: true, deactivatedAt: true, user: { select: { id: true, name: true, email: true, title: true, outOfOfficeUntil: true } } },
    });
    const active = memberships.filter((m) => !m.deactivatedAt && m.role !== "viewer");
    const paused = memberships.filter((m) => m.deactivatedAt);
    const ids = active.map((m) => m.user.id);
    const pausedIds = paused.map((m) => m.user.id);
    const owners = [...ids, ...pausedIds];
    const staleCut = new Date(now.getTime() - STALE_DAYS * DAY);
    const dayAgo = new Date(now.getTime() - DAY);
    const since = new Date(now.getTime() - SPEED_WINDOW_DAYS * DAY);
    const openLead = { deletedAt: null, archivedAt: null, lifecycleStage: { in: ["lead", "sales"] as ("lead" | "sales")[] } };

    const [leads, deals, tasks, overdue, stale, waiting, noNextStep, speed, unowned] = await Promise.all([
      db.contact.groupBy({ by: ["ownerId"], where: { workspaceId: wid, ownerId: { in: owners }, ...openLead }, _count: { _all: true } }),
      db.deal.groupBy({ by: ["ownerId", "currency"], where: { workspaceId: wid, ownerId: { in: owners }, deletedAt: null, status: "open" }, _count: { _all: true }, _sum: { value: true } }),
      db.task.groupBy({ by: ["assigneeId"], where: { workspaceId: wid, assigneeId: { in: owners }, status: "open" }, _count: { _all: true } }),
      db.task.groupBy({ by: ["assigneeId"], where: { workspaceId: wid, assigneeId: { in: ids }, status: "open", dueAt: { lt: now } }, _count: { _all: true } }),
      db.$queryRaw<{ userId: string; n: number }[]>`
        SELECT c."ownerId" AS "userId", count(*)::int AS n
        FROM "Contact" c
        WHERE c."workspaceId" = ${wid}::uuid AND c."ownerId" = ANY(${ids}::uuid[])
          AND c."deletedAt" IS NULL AND c."archivedAt" IS NULL AND c."lifecycleStage" IN ('lead', 'sales')
          AND c."createdAt" < ${staleCut}
          AND NOT EXISTS (
            SELECT 1 FROM "Activity" a
            WHERE a."workspaceId" = ${wid}::uuid AND a."contactId" = c.id AND a."occurredAt" >= ${staleCut} AND a."occurredAt" <= ${now}
          )
        GROUP BY 1`,
      // Waiting on a reply: open, not snoozed, the last inbound not yet answered. Whose: the assignee, else the contact's owner.
      db.$queryRaw<{ userId: string | null; n: number; old: number }[]>`
        SELECT COALESCE(cv."assigneeId", ct."ownerId") AS "userId", count(*)::int AS n,
               count(*) FILTER (WHERE cv."lastInboundAt" < ${dayAgo})::int AS old
        FROM "Conversation" cv
        LEFT JOIN "Contact" ct ON ct.id = cv."contactId" AND ct."workspaceId" = ${wid}::uuid
        WHERE cv."workspaceId" = ${wid}::uuid AND cv.status = 'open' AND cv.unread
          AND (cv."snoozedUntil" IS NULL OR cv."snoozedUntil" <= ${now})
        GROUP BY 1`,
      db.$queryRaw<{ userId: string; n: number }[]>`
        SELECT d."ownerId" AS "userId", count(*)::int AS n
        FROM "Deal" d
        WHERE d."workspaceId" = ${wid}::uuid AND d."ownerId" = ANY(${ids}::uuid[]) AND d."deletedAt" IS NULL AND d.status = 'open'
          AND d."nextStep" = ''
          AND NOT EXISTS (SELECT 1 FROM "Task" t WHERE t."workspaceId" = ${wid}::uuid AND t."dealId" = d.id AND t.status = 'open')
        GROUP BY 1`,
      // Speed to lead: minutes from a lead arriving to its owner's first touch (the median), and leads a day old with none.
      db.$queryRaw<{ userId: string | null; median: number | null; touched: number; untouched: number }[]>`
        WITH arrived AS (
          SELECT c.id, c."ownerId", c."createdAt",
                 (SELECT min(a."occurredAt") FROM "Activity" a
                  WHERE a."workspaceId" = ${wid}::uuid AND a."contactId" = c.id AND a."occurredAt" >= c."createdAt" AND a."occurredAt" <= ${now}
                    AND ${TOUCH}) AS first
          FROM "Contact" c
          WHERE c."workspaceId" = ${wid}::uuid AND c."ownerId" = ANY(${ids}::uuid[]) AND c."deletedAt" IS NULL
            AND c."lifecycleStage" IN ('lead', 'sales') AND c."createdAt" >= ${since} AND c."createdAt" <= ${now}
        )
        SELECT "ownerId" AS "userId",
               (percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM first - "createdAt") / 60) FILTER (WHERE first IS NOT NULL))::float AS median,
               count(*) FILTER (WHERE first IS NOT NULL)::int AS touched,
               count(*) FILTER (WHERE first IS NULL AND "createdAt" < ${dayAgo})::int AS untouched
        FROM arrived
        GROUP BY ROLLUP ("ownerId")`,
      db.contact.count({ where: { workspaceId: wid, ownerId: null, ...openLead } }),
    ]);

    const count = <T extends { _count: { _all: number } }>(rows: T[], key: (r: T) => string | null): Counts => {
      const m: Counts = new Map();
      for (const r of rows) {
        const k = key(r);
        if (k) m.set(k, (m.get(k) ?? 0) + r._count._all);
      }
      return m;
    };
    const raw = (rows: { userId: string | null; n: number }[]): Counts => new Map(rows.filter((r) => r.userId).map((r) => [r.userId as string, r.n]));
    const leadN = count(leads, (r) => r.ownerId);
    const dealN = count(deals, (r) => r.ownerId);
    const taskN = count(tasks, (r) => r.assigneeId);
    const overdueN = count(overdue, (r) => r.assigneeId);
    const staleN = raw(stale);
    const waitingN = raw(waiting);
    const waitingOld: Counts = new Map(waiting.filter((r) => r.userId).map((r) => [r.userId as string, r.old]));
    const nextN = raw(noNextStep);
    const valueN: Counts = new Map();
    for (const d of deals) if (d.ownerId && d.currency === w.currency) valueN.set(d.ownerId, (valueN.get(d.ownerId) ?? 0) + Number(d._sum.value ?? 0));
    const speedOf = new Map(speed.filter((r) => r.userId).map((r) => [r.userId as string, r]));
    const speedAll = speed.find((r) => !r.userId);
    const nobody = waiting.find((r) => !r.userId);

    const avg = ids.length ? ids.reduce((s, id) => s + n(leadN, id) + n(dealN, id), 0) / ids.length : 0;
    const people = active
      .map((m) => {
        const id = m.user.id;
        const away = Boolean(m.user.outOfOfficeUntil && m.user.outOfOfficeUntil > now);
        const open = n(leadN, id) + n(dealN, id);
        const sp = speedOf.get(id);
        return {
          userId: id,
          name: m.user.name,
          email: m.user.email,
          title: m.user.title,
          role: m.role,
          away,
          awayUntil: away ? m.user.outOfOfficeUntil : null,
          openLeads: n(leadN, id),
          openDeals: n(dealN, id),
          openDealValue: n(valueN, id),
          openTasks: n(taskN, id),
          overdueTasks: n(overdueN, id),
          staleLeads: n(staleN, id),
          waitingReplies: n(waitingN, id),
          waitingOver24h: n(waitingOld, id),
          dealsNoNextStep: n(nextN, id),
          speedToLeadMinutes: sp?.median == null ? null : Math.round(sp.median),
          untouchedLeads: sp?.untouched ?? 0,
          load: (ids.length > 1 && open >= 5 && open > avg * 1.5 ? "heavy" : ids.length > 1 && open < avg * 0.5 ? "light" : "normal") as "heavy" | "light" | "normal",
        };
      })
      // The ones needing a look first: slipping work, then the heaviest load.
      .sort((a, b) => b.overdueTasks + b.waitingOver24h + b.staleLeads - (a.overdueTasks + a.waitingOver24h + a.staleLeads) || b.openLeads + b.openDeals - (a.openLeads + a.openDeals) || a.name.localeCompare(b.name));

    const sum = (k: keyof (typeof people)[number]) => people.reduce((s, p) => s + (typeof p[k] === "number" ? (p[k] as number) : 0), 0);
    const totals = {
      people: people.length,
      away: people.filter((p) => p.away).length,
      openLeads: sum("openLeads"),
      openDeals: sum("openDeals"),
      openDealValue: sum("openDealValue"),
      openTasks: sum("openTasks"),
      overdueTasks: sum("overdueTasks"),
      staleLeads: sum("staleLeads"),
      waitingReplies: sum("waitingReplies"),
      waitingOver24h: sum("waitingOver24h"),
      dealsNoNextStep: sum("dealsNoNextStep"),
      untouchedLeads: sum("untouchedLeads"),
      speedToLeadMinutes: speedAll?.median == null ? null : Math.round(speedAll.median),
      unownedLeads: unowned,
      unassignedReplies: nobody?.n ?? 0,
    };

    const alerts: OverviewAlert[] = [];
    const plural = (k: number, one: string, many = `${one}s`) => `${k} ${k === 1 ? one : many}`;
    if (totals.unassignedReplies) alerts.push({ key: "unassigned_replies", severity: "high", count: totals.unassignedReplies, title: `${plural(totals.unassignedReplies, "reply", "replies")} with nobody to answer`, hint: "No assignee and no contact owner. Assign them, or set up lead routing so they land with someone.", href: "/inbox" });
    if (totals.waitingOver24h) alerts.push({ key: "waiting_24h", severity: "high", count: totals.waitingOver24h, title: `${plural(totals.waitingOver24h, "reply", "replies")} waiting over a day`, hint: "A customer wrote and has not heard back for 24 hours.", href: "/inbox" });
    if (totals.unownedLeads) alerts.push({ key: "unowned_leads", severity: "medium", count: totals.unownedLeads, title: `${plural(totals.unownedLeads, "lead")} with no owner`, hint: "Nobody is responsible for them. Assign them in bulk, or let lead routing do it.", href: "/leads?owner=none" });
    if (totals.untouchedLeads) alerts.push({ key: "untouched_leads", severity: "medium", count: totals.untouchedLeads, title: `${plural(totals.untouchedLeads, "new lead")} not contacted after a day`, hint: `No email, call or booking since they arrived (last ${SPEED_WINDOW_DAYS} days).`, href: "/leads" });
    if (totals.overdueTasks) alerts.push({ key: "overdue_tasks", severity: "medium", count: totals.overdueTasks, title: `${plural(totals.overdueTasks, "overdue task")}`, hint: "Follow-ups past their due date.", href: "/tasks" });
    if (totals.staleLeads) alerts.push({ key: "stale_leads", severity: "low", count: totals.staleLeads, title: `${plural(totals.staleLeads, "lead")} untouched for ${STALE_DAYS} days`, hint: "Owned, still open, and nothing has happened on them.", href: "/leads?noNextAction=1" });
    if (totals.dealsNoNextStep) alerts.push({ key: "no_next_step", severity: "low", count: totals.dealsNoNextStep, title: `${plural(totals.dealsNoNextStep, "open deal")} with no next step`, hint: "No next step written and no open task.", href: "/deals" });
    for (const p of people) {
      if (p.away && p.waitingReplies + p.openLeads > 0)
        alerts.push({ key: "away_with_work", severity: "medium", count: p.waitingReplies + p.openLeads, userId: p.userId, title: `${p.name || p.email} is away with ${plural(p.openLeads, "open lead")} and ${plural(p.waitingReplies, "waiting reply", "waiting replies")}`, hint: "New leads and replies skip them while they are away; what they already have waits.", href: `/leads?owner=${p.userId}` });
      if (p.load === "heavy") alerts.push({ key: "heavy_load", severity: "low", count: p.openLeads + p.openDeals, userId: p.userId, title: `${p.name || p.email} carries ${p.openLeads + p.openDeals} open leads and deals`, hint: `Well above the team average of ${Math.round(avg)}. Consider routing new leads elsewhere.`, href: `/leads?owner=${p.userId}` });
    }
    for (const m of paused) {
      const left = n(leadN, m.user.id) + n(dealN, m.user.id) + n(taskN, m.user.id) + n(waitingN, m.user.id);
      if (left) alerts.push({ key: "paused_with_work", severity: "high", count: left, userId: m.user.id, title: `${m.user.name || m.user.email} is paused but still owns ${plural(left, "open record")}`, hint: "Nobody is working these. Hand them over from Settings → Members.", href: "/settings/members" });
    }
    const rank = { high: 0, medium: 1, low: 2 } as const;
    alerts.sort((a, b) => rank[a.severity] - rank[b.severity] || b.count - a.count);

    return { generatedAt: now, teamId: q.teamId ?? null, currency: w.currency, staleDays: STALE_DAYS, speedWindowDays: SPEED_WINDOW_DAYS, totals, people, alerts };
  }
}
