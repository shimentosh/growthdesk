import { Injectable } from "@nestjs/common";
import { resolveRange, type AnalyticsPipelineQueryT, type AnalyticsRangeQueryT, type ResolvedRange } from "@growthdesk/shared";
import { Prisma } from "../generated/prisma/client.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { EntitlementsService } from "../billing/entitlements.service.js";
import { notFound } from "../common/errors.js";
import { ownershipScope, ws, type RequestContext } from "../common/context.js";
import { denseSeries, rate, total, type DayRow } from "./series.js";

/*
 * Workspace reports, computed from the rows themselves on every request —
 * Message / StepExecution / Enrollment for outreach, Deal / DealStageChange
 * for the pipeline, Task / Meeting / Call for activity. No counters are
 * cached, so a report always agrees with the records behind it.
 *
 * Definitions (the web copy repeats them; keep the two in step):
 *   - Sent: outbound messages whose sentAt falls in the range (any channel).
 *     Bounced / opened / clicked / delivery receipts are counted over those
 *     same messages (cohort), so their rates never exceed 100%.
 *   - Reply rate: of the conversations messaged in the range, the share with a
 *     human reply (not an auto-reply) after the first message in the range.
 *   - Replies: human inbound messages received in the range in a conversation
 *     we had written to before — a cold inbound message is not a reply.
 *   - Opens are a weak signal (image proxies and privacy features fire and
 *     block them); the UI labels them so.
 *   - Value won counts only deals in the workspace currency; other currencies
 *     are listed separately rather than converted at an invented rate.
 *
 * Every query is grouped in SQL (one round trip per figure family, all in
 * parallel) — nothing loops over rows or campaigns. Raw SQL is not seen by
 * the tenant guard, so every statement names the workspace explicitly,
 * including on joined tables.
 *
 * Visibility: without records.view_all the figures cover what the person may
 * see elsewhere — conversations assigned to them or unassigned (the inbox
 * rule), their own or unowned deals, meetings and contacts, tasks assigned to
 * them or nobody, their own calls. The team leaderboard is the exception: it
 * is aggregate-only and is exactly what analytics.team grants.
 */

type Range = ResolvedRange;

/** Bounds and bucketing for one request, as SQL fragments. Columns are `timestamp(3)` holding UTC. */
function sqlRange(r: Range) {
  const start = Prisma.sql`(${r.start.toISOString()}::timestamptz AT TIME ZONE 'UTC')`;
  const end = Prisma.sql`(${r.end.toISOString()}::timestamptz AT TIME ZONE 'UTC')`;
  return {
    start,
    end,
    /** `col` in [start, end). */
    within: (col: string) => Prisma.sql`(${Prisma.raw(col)} >= ${start} AND ${Prisma.raw(col)} < ${end})`,
    /** The local calendar day of a stored instant in the workspace's zone. */
    day: (col: string) => Prisma.sql`to_char((${Prisma.raw(col)} AT TIME ZONE 'UTC') AT TIME ZONE ${r.timeZone}::text, 'YYYY-MM-DD')`,
  };
}

type ChannelDayRow = { day: string; channel: string; sent: number; delivered: number; bounced: number; opened: number; clicked: number };
type ClosedRow = { day: string; status: "won" | "lost"; currency: string; n: number; value: number; secs: number };

const round2 = (n: number) => Math.round(n * 100) / 100;

@Injectable()
export class AnalyticsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly entitlements: EntitlementsService,
  ) {}

  /** The signed-in person's id when their figures are limited to their own records, else null. */
  private restrictedTo(ctx: RequestContext): string | null {
    return Object.keys(ownershipScope(ctx)).length ? (ctx.identity?.userId ?? null) : null;
  }

  /** "Mine or nobody's" on a column, or nothing for a role that sees everything. */
  private own(col: string, uid: string | null): Prisma.Sql {
    return uid ? Prisma.sql`AND (${Prisma.raw(col)} = ${uid}::uuid OR ${Prisma.raw(col)} IS NULL)` : Prisma.empty;
  }

  /** Messages are visible through their conversation (assigned to me or unassigned). */
  private convScope(alias: string, workspaceId: string, uid: string | null): { join: Prisma.Sql; where: Prisma.Sql } {
    if (!uid) return { join: Prisma.empty, where: Prisma.empty };
    return {
      join: Prisma.sql`JOIN "Conversation" cv ON cv.id = ${Prisma.raw(`${alias}."conversationId"`)} AND cv."workspaceId" = ${workspaceId}::uuid`,
      where: this.own(`cv."assigneeId"`, uid),
    };
  }

  private rangeDto(r: Range, currency: string, uid: string | null) {
    return { from: r.from, to: r.to, days: r.days, timeZone: r.timeZone, currency, scope: uid ? ("own" as const) : ("all" as const) };
  }

  // ─── Overview: outreach, pipeline and activity KPIs with a daily series ─────

  async overview(ctx: RequestContext, q: AnalyticsRangeQueryT) {
    const w = ws(ctx);
    const r = resolveRange(q, w.timezone);
    const s = sqlRange(r);
    const uid = this.restrictedTo(ctx);
    const wid = w.id;
    const out = this.convScope("m", wid, uid);
    const inb = this.convScope("r", wid, uid);
    const db = this.prisma.db;
    const at = { gte: r.start, lt: r.end };

    const [sends, threads, replyDays, unsubscribes, createdDays, closed, taskDays, meetingDays, meetingsHeld, callDays, callsConnected] = await Promise.all([
      // Outbound messages sent in the range, by local day and channel, with what happened to them.
      db.$queryRaw<ChannelDayRow[]>`
        SELECT ${s.day(`m."sentAt"`)} AS day, m.channel::text AS channel,
               count(*)::int AS sent,
               count(*) FILTER (WHERE m."deliveredAt" IS NOT NULL OR m."readAt" IS NOT NULL OR m.status IN ('delivered', 'read'))::int AS delivered,
               count(*) FILTER (WHERE m."bouncedAt" IS NOT NULL OR m.status = 'bounced')::int AS bounced,
               count(*) FILTER (WHERE m."openedAt" IS NOT NULL)::int AS opened,
               count(*) FILTER (WHERE m."clickedAt" IS NOT NULL)::int AS clicked
        FROM "Message" m ${out.join}
        WHERE m."workspaceId" = ${wid}::uuid AND m.direction = 'outbound' AND ${s.within(`m."sentAt"`)}
          AND m."createdAt" < ${s.end} ${out.where}
        GROUP BY 1, 2`,
      // Conversations written to in the range, and how many answered after the first of those messages.
      db.$queryRaw<{ contacted: number; replied: number }[]>`
        WITH firsts AS (
          SELECT m."conversationId" AS id, min(m."sentAt") AS first_sent
          FROM "Message" m ${out.join}
          WHERE m."workspaceId" = ${wid}::uuid AND m.direction = 'outbound' AND ${s.within(`m."sentAt"`)}
            AND m."createdAt" < ${s.end} ${out.where}
          GROUP BY m."conversationId"
        )
        SELECT count(*)::int AS contacted,
               count(*) FILTER (WHERE EXISTS (
                 SELECT 1 FROM "Message" r
                 WHERE r."workspaceId" = ${wid}::uuid AND r."conversationId" = f.id AND r.direction = 'inbound'
                   AND NOT r."isAutoReply" AND r."createdAt" > f.first_sent
               ))::int AS replied
        FROM firsts f`,
      // Human replies received in the range (to a conversation we had already written to).
      db.$queryRaw<DayRow[]>`
        SELECT ${s.day(`r."createdAt"`)} AS day, count(*)::int AS n
        FROM "Message" r ${inb.join}
        WHERE r."workspaceId" = ${wid}::uuid AND r.direction = 'inbound' AND NOT r."isAutoReply" AND ${s.within(`r."createdAt"`)} ${inb.where}
          AND EXISTS (
            SELECT 1 FROM "Message" o
            WHERE o."workspaceId" = ${wid}::uuid AND o."conversationId" = r."conversationId" AND o.direction = 'outbound' AND o."sentAt" < r."createdAt"
          )
        GROUP BY 1`,
      db.contact.count({ where: { workspaceId: wid, unsubscribedAt: at, ...(ownershipScope(ctx) as Prisma.ContactWhereInput) } }),
      db.$queryRaw<DayRow[]>`
        SELECT ${s.day(`d."createdAt"`)} AS day, count(*)::int AS n
        FROM "Deal" d
        WHERE d."workspaceId" = ${wid}::uuid AND d."deletedAt" IS NULL AND ${s.within(`d."createdAt"`)} ${this.own(`d."ownerId"`, uid)}
        GROUP BY 1`,
      db.$queryRaw<ClosedRow[]>`
        SELECT ${s.day(`d."closedAt"`)} AS day, d.status::text AS status, d.currency,
               count(*)::int AS n,
               COALESCE(sum(d.value), 0)::float8 AS value,
               COALESCE(sum(EXTRACT(EPOCH FROM (d."closedAt" - d."createdAt"))), 0)::float8 AS secs
        FROM "Deal" d
        WHERE d."workspaceId" = ${wid}::uuid AND d."deletedAt" IS NULL AND d.status IN ('won', 'lost') AND ${s.within(`d."closedAt"`)} ${this.own(`d."ownerId"`, uid)}
        GROUP BY 1, 2, 3`,
      db.$queryRaw<DayRow[]>`
        SELECT ${s.day(`t."completedAt"`)} AS day, count(*)::int AS n
        FROM "Task" t
        WHERE t."workspaceId" = ${wid}::uuid AND t.status = 'done' AND ${s.within(`t."completedAt"`)} ${this.own(`t."assigneeId"`, uid)}
        GROUP BY 1`,
      // Booked = created in the range and not since canceled.
      db.$queryRaw<DayRow[]>`
        SELECT ${s.day(`mt."createdAt"`)} AS day, count(*)::int AS n
        FROM "Meeting" mt
        WHERE mt."workspaceId" = ${wid}::uuid AND mt.status <> 'canceled' AND ${s.within(`mt."createdAt"`)} ${this.own(`mt."ownerId"`, uid)}
        GROUP BY 1`,
      db.meeting.count({ where: { workspaceId: wid, status: "completed", startsAt: at, ...(ownershipScope(ctx) as Prisma.MeetingWhereInput) } }),
      db.$queryRaw<DayRow[]>`
        SELECT ${s.day(`c."createdAt"`)} AS day, count(*)::int AS n
        FROM "Call" c
        WHERE c."workspaceId" = ${wid}::uuid AND ${s.within(`c."createdAt"`)} ${this.own(`c."userId"`, uid)}
        GROUP BY 1`,
      db.call.count({ where: { workspaceId: wid, status: "completed", createdAt: at, ...(uid ? { OR: [{ userId: uid }, { userId: null }] } : {}) } }),
    ]);

    // Outreach totals, by channel and overall.
    const byChannel: Record<string, number> = {};
    const o = { sent: 0, delivered: 0, bounced: 0, opened: 0, clicked: 0 };
    const sentDays: DayRow[] = [];
    const bouncedDays: DayRow[] = [];
    for (const row of sends) {
      byChannel[row.channel] = (byChannel[row.channel] ?? 0) + row.sent;
      o.sent += row.sent;
      o.delivered += row.delivered;
      o.bounced += row.bounced;
      o.opened += row.opened;
      o.clicked += row.clicked;
      sentDays.push({ day: row.day, n: row.sent });
      bouncedDays.push({ day: row.day, n: row.bounced });
    }
    const t = threads[0] ?? { contacted: 0, replied: 0 };

    // Pipeline: won/lost by day; value only in the workspace currency.
    const wonDays: DayRow[] = [];
    const valueDays: DayRow[] = [];
    const other = new Map<string, { value: number; deals: number }>();
    let won = 0;
    let lost = 0;
    let valueWon = 0;
    let wonSecs = 0;
    for (const row of closed) {
      if (row.status === "lost") {
        lost += row.n;
        continue;
      }
      won += row.n;
      wonSecs += row.secs;
      wonDays.push({ day: row.day, n: row.n });
      if (row.currency === w.currency) {
        valueWon += row.value;
        valueDays.push({ day: row.day, n: row.value });
      } else {
        const prev = other.get(row.currency) ?? { value: 0, deals: 0 };
        other.set(row.currency, { value: prev.value + row.value, deals: prev.deals + row.n });
      }
    }

    const series = denseSeries(r, {
      sent: sentDays,
      bounced: bouncedDays,
      replies: replyDays,
      dealsCreated: createdDays,
      dealsWon: wonDays,
      valueWon: valueDays,
      tasksCompleted: taskDays,
      meetingsBooked: meetingDays,
      callsLogged: callDays,
    }).map((p) => ({ ...p, valueWon: round2(p.valueWon) }));

    return {
      range: this.rangeDto(r, w.currency, uid),
      outreach: {
        sent: o.sent,
        byChannel,
        delivered: o.delivered,
        bounced: o.bounced,
        bounceRate: rate(o.bounced, o.sent),
        opened: o.opened,
        openRate: rate(o.opened, o.sent),
        clicked: o.clicked,
        clickRate: rate(o.clicked, o.sent),
        contacted: t.contacted,
        replied: t.replied,
        replyRate: rate(t.replied, t.contacted),
        replies: total(replyDays),
        unsubscribes,
      },
      pipeline: {
        created: total(createdDays),
        won,
        lost,
        winRate: rate(won, won + lost),
        valueWon: round2(valueWon),
        otherCurrencies: [...other.entries()].map(([currency, v]) => ({ currency, value: round2(v.value), deals: v.deals })).sort((a, b) => b.value - a.value),
        avgDaysToClose: won ? Math.round((wonSecs / won / 86_400) * 10) / 10 : null,
      },
      activity: {
        tasksCompleted: total(taskDays),
        meetingsBooked: total(meetingDays),
        meetingsHeld,
        callsLogged: total(callDays),
        callsConnected,
      },
      series,
    };
  }

  // ─── Campaign comparison and the by-step view ───────────────────────────────

  async campaigns(ctx: RequestContext, q: AnalyticsRangeQueryT) {
    const w = ws(ctx);
    const r = resolveRange(q, w.timezone);
    const s = sqlRange(r);
    const uid = this.restrictedTo(ctx);
    const wid = w.id;
    const out = this.convScope("m", wid, uid);
    const db = this.prisma.db;

    const [messages, cohorts, deals, steps] = await Promise.all([
      db.$queryRaw<{ id: string; sent: number; bounced: number; opened: number; clicked: number }[]>`
        SELECT m."campaignId" AS id,
               count(*)::int AS sent,
               count(*) FILTER (WHERE m."bouncedAt" IS NOT NULL OR m.status = 'bounced')::int AS bounced,
               count(*) FILTER (WHERE m."openedAt" IS NOT NULL)::int AS opened,
               count(*) FILTER (WHERE m."clickedAt" IS NOT NULL)::int AS clicked
        FROM "Message" m ${out.join}
        WHERE m."workspaceId" = ${wid}::uuid AND m.direction = 'outbound' AND m."campaignId" IS NOT NULL
          AND ${s.within(`m."sentAt"`)} AND m."createdAt" < ${s.end} ${out.where}
        GROUP BY 1`,
      // People messaged in the range, and how many replied / unsubscribed after their first message in it.
      db.$queryRaw<{ id: string; contacted: number; replied: number; unsubscribed: number }[]>`
        WITH firsts AS (
          SELECT m."enrollmentId" AS id, min(m."sentAt") AS first_sent
          FROM "Message" m ${out.join}
          WHERE m."workspaceId" = ${wid}::uuid AND m.direction = 'outbound' AND m."enrollmentId" IS NOT NULL
            AND ${s.within(`m."sentAt"`)} AND m."createdAt" < ${s.end} ${out.where}
          GROUP BY 1
        )
        SELECT e."campaignId" AS id,
               count(*)::int AS contacted,
               count(*) FILTER (WHERE e."repliedAt" >= f.first_sent)::int AS replied,
               count(*) FILTER (WHERE ct."unsubscribedAt" >= f.first_sent)::int AS unsubscribed
        FROM firsts f
        JOIN "Enrollment" e ON e.id = f.id AND e."workspaceId" = ${wid}::uuid
        JOIN "Contact" ct ON ct.id = e."contactId" AND ct."workspaceId" = ${wid}::uuid
        GROUP BY 1`,
      db.deal.groupBy({
        by: ["sourceCampaignId"],
        where: { workspaceId: wid, deletedAt: null, sourceCampaignId: { not: null }, createdAt: { gte: r.start, lt: r.end }, ...(ownershipScope(ctx) as Prisma.DealWhereInput) },
        _count: { _all: true },
      }),
      /*
       * By step number across every campaign: first touch against follow-ups.
       * A reply is credited to the last step sent before it (the next send of
       * the same enrollment closes the window), using the whole send history
       * of the enrollments that had a send in the range.
       */
      db.$queryRaw<{ position: number; sent: number; replied: number; bounced: number; opened: number; clicked: number }[]>`
        WITH sends AS (
          SELECT se.position, se."enrollmentId", m."sentAt", m."bouncedAt", m.status, m."openedAt", m."clickedAt",
                 lead(m."sentAt") OVER (PARTITION BY se."enrollmentId" ORDER BY m."sentAt") AS next_sent
          FROM "StepExecution" se
          JOIN "Message" m ON m.id = se."messageId" AND m."workspaceId" = ${wid}::uuid
          ${out.join}
          WHERE se."workspaceId" = ${wid}::uuid AND m."sentAt" IS NOT NULL ${out.where}
            AND se."enrollmentId" IN (
              SELECT m2."enrollmentId" FROM "Message" m2
              WHERE m2."workspaceId" = ${wid}::uuid AND m2.direction = 'outbound' AND m2."enrollmentId" IS NOT NULL
                AND ${s.within(`m2."sentAt"`)} AND m2."createdAt" < ${s.end}
            )
        )
        SELECT x.position,
               count(*)::int AS sent,
               count(*) FILTER (WHERE e."repliedAt" >= x."sentAt" AND (x.next_sent IS NULL OR e."repliedAt" < x.next_sent))::int AS replied,
               count(*) FILTER (WHERE x."bouncedAt" IS NOT NULL OR x.status = 'bounced')::int AS bounced,
               count(*) FILTER (WHERE x."openedAt" IS NOT NULL)::int AS opened,
               count(*) FILTER (WHERE x."clickedAt" IS NOT NULL)::int AS clicked
        FROM sends x
        JOIN "Enrollment" e ON e.id = x."enrollmentId" AND e."workspaceId" = ${wid}::uuid
        WHERE ${s.within(`x."sentAt"`)}
        GROUP BY 1
        ORDER BY 1`,
    ]);

    const ids = [...new Set([...messages.map((m) => m.id), ...cohorts.map((c) => c.id), ...deals.map((d) => d.sourceCampaignId!)])];
    // Deleted campaigns still sent what they sent; they stay in the report, marked.
    const meta = ids.length
      ? await db.campaign.findMany({ where: { workspaceId: wid, id: { in: ids } }, select: { id: true, name: true, status: true, settings: true, deletedAt: true } })
      : [];
    const msg = new Map(messages.map((m) => [m.id, m]));
    const coh = new Map(cohorts.map((c) => [c.id, c]));
    const dl = new Map(deals.map((d) => [d.sourceCampaignId, d._count._all]));

    const campaigns = meta
      .map((c) => {
        const m = msg.get(c.id);
        const k = coh.get(c.id);
        const settings = (c.settings ?? {}) as { trackOpens?: boolean; trackClicks?: boolean };
        const sent = m?.sent ?? 0;
        const contacted = k?.contacted ?? 0;
        return {
          id: c.id,
          name: c.name,
          status: c.status,
          deleted: c.deletedAt !== null,
          // Whether tracking is on now; opens and clicks read "—" when it is off.
          trackOpens: settings.trackOpens !== false,
          trackClicks: settings.trackClicks !== false,
          sent,
          contacted,
          replied: k?.replied ?? 0,
          replyRate: rate(k?.replied ?? 0, contacted),
          bounced: m?.bounced ?? 0,
          bounceRate: rate(m?.bounced ?? 0, sent),
          opened: m?.opened ?? 0,
          clicked: m?.clicked ?? 0,
          unsubscribed: k?.unsubscribed ?? 0,
          deals: dl.get(c.id) ?? 0,
        };
      })
      .sort((a, b) => b.sent - a.sent || a.name.localeCompare(b.name));

    return {
      range: this.rangeDto(r, w.currency, uid),
      campaigns,
      steps: steps.map((x) => ({ ...x, replyRate: rate(x.replied, x.sent), bounceRate: rate(x.bounced, x.sent) })),
    };
  }

  // ─── Pipeline funnel ────────────────────────────────────────────────────────

  /**
   * Deals created in the range in one pipeline, and how far each has got so
   * far: a deal "reached" a stage when its stage history (DealStageChange) or
   * its current stage is at that stage or a later one. Lost stages are not
   * steps of the funnel; lost deals are counted beside it.
   */
  async pipeline(ctx: RequestContext, q: AnalyticsPipelineQueryT) {
    const w = ws(ctx);
    const r = resolveRange(q, w.timezone);
    const s = sqlRange(r);
    const uid = this.restrictedTo(ctx);
    const wid = w.id;
    const pipelines = await this.prisma.db.pipeline.findMany({
      where: { workspaceId: wid, archivedAt: null },
      include: { stages: { orderBy: { position: "asc" } } },
      orderBy: [{ isDefault: "desc" }, { position: "asc" }],
    });
    const pipeline = q.pipelineId ? pipelines.find((p) => p.id === q.pipelineId) : pipelines[0];
    if (q.pipelineId && !pipeline) throw notFound("That pipeline");
    const list = pipelines.map((p) => ({ id: p.id, name: p.name, isDefault: p.isDefault }));
    if (!pipeline) return { range: this.rangeDto(r, w.currency, uid), pipelines: list, pipelineId: null, cohort: 0, open: 0, won: 0, lost: 0, stages: [] };

    const rows = await this.prisma.db.$queryRaw<{ maxpos: number | null; status: "open" | "won" | "lost"; n: number }[]>`
      WITH cohort AS (
        SELECT d.id, d."stageId", d.status
        FROM "Deal" d
        WHERE d."workspaceId" = ${wid}::uuid AND d."pipelineId" = ${pipeline.id}::uuid AND d."deletedAt" IS NULL
          AND ${s.within(`d."createdAt"`)} ${this.own(`d."ownerId"`, uid)}
      ),
      touched AS (
        SELECT c.id AS deal, c.status, c."stageId" AS stage FROM cohort c
        UNION ALL
        SELECT h."dealId", c.status, h."toStageId" FROM "DealStageChange" h JOIN cohort c ON c.id = h."dealId"
        WHERE h."workspaceId" = ${wid}::uuid
      ),
      reached AS (
        SELECT t.deal, t.status, max(st.position) FILTER (WHERE st.kind <> 'lost') AS maxpos
        FROM touched t
        JOIN "PipelineStage" st ON st.id = t.stage AND st."workspaceId" = ${wid}::uuid AND st."pipelineId" = ${pipeline.id}::uuid
        GROUP BY t.deal, t.status
      )
      SELECT maxpos, status::text AS status, count(*)::int AS n FROM reached GROUP BY 1, 2`;

    const cohort = rows.reduce((a, x) => a + x.n, 0);
    const byStatus = (st: string) => rows.filter((x) => x.status === st).reduce((a, x) => a + x.n, 0);
    const funnel = pipeline.stages.filter((st) => st.kind !== "lost");
    let previous: number | null = null;
    const stages = funnel.map((st, i) => {
      // Every deal in the cohort entered the pipeline, so the first step is the whole cohort.
      const reached = i === 0 ? cohort : rows.filter((x) => x.maxpos !== null && x.maxpos >= st.position).reduce((a, x) => a + x.n, 0);
      const step = { stageId: st.id, name: st.name, kind: st.kind, color: st.color, reached, conversion: previous === null ? null : rate(reached, previous) };
      previous = reached;
      return step;
    });

    return {
      range: this.rangeDto(r, w.currency, uid),
      pipelines: list,
      pipelineId: pipeline.id,
      cohort,
      open: byStatus("open"),
      won: byStatus("won"),
      lost: byStatus("lost"),
      stages,
    };
  }

  // ─── Lead sources ───────────────────────────────────────────────────────────

  /**
   * The contacts created in the range, grouped by where they came from
   * (contact.leadSource, trimmed; case ignored, "" = not recorded). For each:
   * how many, how many are qualified now, how many have a deal, how many have
   * won one, and the value of their won deals — in the workspace currency
   * only, like every value here. A cohort: a lead from the range whose deal
   * closed later still counts as won.
   */
  async sources(ctx: RequestContext, q: AnalyticsRangeQueryT) {
    const w = ws(ctx);
    const r = resolveRange(q, w.timezone);
    const s = sqlRange(r);
    const uid = this.restrictedTo(ctx);
    const wid = w.id;
    const rows = await this.prisma.db.$queryRaw<{ source: string; leads: number; qualified: number; with_deal: number; won: number; won_value: number }[]>`
      WITH cohort AS (
        SELECT c.id, lower(trim(c."leadSource")) AS key, trim(c."leadSource") AS source, c.qualification::text AS qualification
        FROM "Contact" c
        WHERE c."workspaceId" = ${wid}::uuid AND c."deletedAt" IS NULL AND c."mergedIntoId" IS NULL
          AND ${s.within(`c."createdAt"`)} ${this.own(`c."ownerId"`, uid)}
      ),
      deals AS (
        SELECT d."contactId" AS contact,
          bool_or(d.status::text = 'won') AS won,
          coalesce(sum(d.value) FILTER (WHERE d.status::text = 'won' AND d.currency = ${w.currency}), 0) AS won_value
        FROM "Deal" d JOIN cohort k ON k.id = d."contactId"
        WHERE d."workspaceId" = ${wid}::uuid AND d."deletedAt" IS NULL ${this.own(`d."ownerId"`, uid)}
        GROUP BY d."contactId"
      )
      SELECT min(k.source) AS source,
        count(*)::int AS leads,
        (count(*) FILTER (WHERE k.qualification = 'qualified'))::int AS qualified,
        count(dl.contact)::int AS with_deal,
        (count(*) FILTER (WHERE dl.won))::int AS won,
        coalesce(sum(dl.won_value), 0)::float8 AS won_value
      FROM cohort k LEFT JOIN deals dl ON dl.contact = k.id
      GROUP BY k.key
      ORDER BY 2 DESC, 1`;

    const sources = rows.map((x) => ({
      source: x.source,
      leads: x.leads,
      qualified: x.qualified,
      withDeal: x.with_deal,
      won: x.won,
      wonValue: round2(x.won_value),
      qualifiedRate: rate(x.qualified, x.leads),
      winRate: rate(x.won, x.leads),
    }));
    const sum = (k: "leads" | "qualified" | "withDeal" | "won" | "wonValue") => sources.reduce((a, x) => a + x[k], 0);
    return {
      range: this.rangeDto(r, w.currency, uid),
      sources,
      totals: { leads: sum("leads"), qualified: sum("qualified"), withDeal: sum("withDeal"), won: sum("won"), wonValue: round2(sum("wonValue")) },
    };
  }

  // ─── Team leaderboard ───────────────────────────────────────────────────────

  /**
   * Per member, for the range. Attribution: a message to whoever wrote it, or
   * the campaign's owner for a campaign send; a reply to the conversation's
   * assignee, else the campaign's owner; meetings and deals to their owner;
   * tasks to whoever completed them; calls to whoever placed or logged them.
   * Activity by people who have since left the workspace is not listed.
   */
  async team(ctx: RequestContext, q: AnalyticsRangeQueryT) {
    const w = ws(ctx);
    await this.entitlements.assertFeature(w.billingAccountId, "advancedReporting");
    const r = resolveRange(q, w.timezone);
    const s = sqlRange(r);
    const wid = w.id;
    const db = this.prisma.db;
    const at = { gte: r.start, lt: r.end };

    const [members, sent, replies, meetings, calls, tasks, created, won] = await Promise.all([
      db.membership.findMany({ where: { workspaceId: wid }, select: { role: true, user: { select: { id: true, name: true, email: true } } } }),
      db.$queryRaw<{ userId: string | null; n: number }[]>`
        SELECT COALESCE(m."authorId", c."ownerId") AS "userId", count(*)::int AS n
        FROM "Message" m
        LEFT JOIN "Campaign" c ON c.id = m."campaignId" AND c."workspaceId" = ${wid}::uuid
        WHERE m."workspaceId" = ${wid}::uuid AND m.direction = 'outbound' AND ${s.within(`m."sentAt"`)} AND m."createdAt" < ${s.end}
        GROUP BY 1`,
      db.$queryRaw<{ userId: string | null; n: number }[]>`
        SELECT COALESCE(cv."assigneeId", c."ownerId") AS "userId", count(*)::int AS n
        FROM "Message" r
        JOIN "Conversation" cv ON cv.id = r."conversationId" AND cv."workspaceId" = ${wid}::uuid
        LEFT JOIN "Campaign" c ON c.id = cv."campaignId" AND c."workspaceId" = ${wid}::uuid
        WHERE r."workspaceId" = ${wid}::uuid AND r.direction = 'inbound' AND NOT r."isAutoReply" AND ${s.within(`r."createdAt"`)}
          AND EXISTS (
            SELECT 1 FROM "Message" o
            WHERE o."workspaceId" = ${wid}::uuid AND o."conversationId" = r."conversationId" AND o.direction = 'outbound' AND o."sentAt" < r."createdAt"
          )
        GROUP BY 1`,
      db.meeting.groupBy({ by: ["ownerId"], where: { workspaceId: wid, status: { not: "canceled" }, createdAt: at }, _count: { _all: true } }),
      db.call.groupBy({ by: ["userId", "status"], where: { workspaceId: wid, createdAt: at }, _count: { _all: true } }),
      db.task.groupBy({ by: ["completedById"], where: { workspaceId: wid, status: "done", completedAt: at }, _count: { _all: true } }),
      db.deal.groupBy({ by: ["ownerId"], where: { workspaceId: wid, deletedAt: null, createdAt: at }, _count: { _all: true } }),
      db.deal.groupBy({ by: ["ownerId", "currency"], where: { workspaceId: wid, deletedAt: null, status: "won", closedAt: at }, _count: { _all: true }, _sum: { value: true } }),
    ]);

    const count = <T extends { _count: { _all: number } }>(rows: T[], key: (row: T) => string | null) => {
      const m = new Map<string, number>();
      for (const row of rows) {
        const k = key(row);
        if (k) m.set(k, (m.get(k) ?? 0) + row._count._all);
      }
      return m;
    };
    const fromRaw = (rows: { userId: string | null; n: number }[]) => new Map(rows.filter((x) => x.userId).map((x) => [x.userId as string, x.n]));
    const sentBy = fromRaw(sent);
    const repliesBy = fromRaw(replies);
    const meetingsBy = count(meetings, (x) => x.ownerId);
    const callsBy = count(calls, (x) => x.userId);
    const connectedBy = count(
      calls.filter((x) => x.status === "completed"),
      (x) => x.userId,
    );
    const tasksBy = count(tasks, (x) => x.completedById);
    const createdBy = count(created, (x) => x.ownerId);
    const wonBy = count(won, (x) => x.ownerId);
    const valueBy = new Map<string, number>();
    for (const row of won) {
      if (row.ownerId && row.currency === w.currency) valueBy.set(row.ownerId, (valueBy.get(row.ownerId) ?? 0) + Number(row._sum.value ?? 0));
    }

    const rows = members
      .map((m) => {
        const id = m.user.id;
        return {
          userId: id,
          name: m.user.name,
          email: m.user.email,
          role: m.role,
          sent: sentBy.get(id) ?? 0,
          replies: repliesBy.get(id) ?? 0,
          meetingsBooked: meetingsBy.get(id) ?? 0,
          callsLogged: callsBy.get(id) ?? 0,
          callsConnected: connectedBy.get(id) ?? 0,
          tasksCompleted: tasksBy.get(id) ?? 0,
          dealsCreated: createdBy.get(id) ?? 0,
          dealsWon: wonBy.get(id) ?? 0,
          valueWon: round2(valueBy.get(id) ?? 0),
        };
      })
      .sort((a, b) => b.valueWon - a.valueWon || b.dealsWon - a.dealsWon || b.replies - a.replies || b.sent - a.sent || a.name.localeCompare(b.name));

    return { range: this.rangeDto(r, w.currency, null), members: rows };
  }
}
