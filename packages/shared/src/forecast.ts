import { z } from "zod";
import { addLocalDays, localDateParam, startOfLocalDay } from "./analytics.js";
import { isValidTimeZone } from "./schedule.js";

/*
 * Forecast, quotas and stale deals: the API inputs and the pure rules both
 * sides read (apps/api/src/forecast, the /forecast page, the deal board).
 *
 * Periods are calendar months and quarters in the WORKSPACE's time zone, the
 * way reports are (analytics.ts): "October 2026" is the same 31 days for the
 * whole team. A period is named by its type and its first local day
 * ("quarter" + "2026-10-01"); any day inside it names it too, and is snapped.
 *
 * What lands in a period:
 *   - Won: deals won with closedAt inside the period's instants [start, end).
 *   - Open: open deals whose expected close date (a plain calendar date, no
 *     zone) falls between the period's first and last local day — split by
 *     the owner's forecast category. Omitted deals are listed but not summed.
 *   - Weighted pipeline: each open, not-omitted deal's value × its stage's
 *     probability.
 *
 * Money is single-currency: only deals (and revenue targets) in the
 * workspace's currency are summed. Deals in other currencies are listed
 * separately, never converted at an invented rate.
 */

export const FORECAST_CATEGORIES = ["pipeline", "best_case", "commit", "omitted"] as const;
export type ForecastCategory = (typeof FORECAST_CATEGORIES)[number];
export const FORECAST_CATEGORY_LABELS: Record<ForecastCategory, string> = { commit: "Commit", best_case: "Best case", pipeline: "Pipeline", omitted: "Omitted" };
/** The order the forecast lists categories in: most certain first. */
export const FORECAST_CATEGORY_ORDER: readonly ForecastCategory[] = ["commit", "best_case", "pipeline", "omitted"];

export const PERIOD_TYPES = ["month", "quarter"] as const;
export type PeriodType = (typeof PERIOD_TYPES)[number];

export const TARGET_METRICS = ["revenue_won", "deals_won", "meetings_booked"] as const;
export type TargetMetric = (typeof TARGET_METRICS)[number];
export const TARGET_METRIC_LABELS: Record<TargetMetric, string> = { revenue_won: "Revenue won", deals_won: "Deals won", meetings_booked: "Meetings booked" };

// ─── Inputs ──────────────────────────────────────────────────────────────────

/**
 * PUT /targets: one target for one metric in one period. Upserts. Whose it is:
 * a rep (userId), a team (teamId), or — with neither — the whole workspace.
 */
export const SalesTargetInput = z
  .object({
    userId: z.string().uuid().nullable().default(null),
    teamId: z.string().uuid().nullable().default(null),
    periodType: z.enum(PERIOD_TYPES),
    /** Any day in the period; stored as the period's first day. */
    periodStart: localDateParam,
    metric: z.enum(TARGET_METRICS).default("revenue_won"),
    target: z.number().min(0).max(1e12),
    /** Revenue targets are in the workspace currency (the default); another is refused. */
    currency: z.string().length(3).toUpperCase().optional(),
  })
  .refine((v) => !(v.userId && v.teamId), { message: "A target is for a person or a team, not both", path: ["teamId"] });
export type SalesTargetInputT = z.infer<typeof SalesTargetInput>;

/** `?periodType=month|quarter&periodStart=YYYY-MM-DD` (default: the current month in the workspace's zone). */
export const PeriodQuery = z.object({ periodType: z.enum(PERIOD_TYPES).default("month"), periodStart: localDateParam.optional() });
export type PeriodQueryT = z.infer<typeof PeriodQuery>;

/** GET /forecast: a period, optionally narrowed to one owner ("me" or a user id) and/or one team's members. */
export const ForecastQuery = PeriodQuery.extend({ ownerId: z.string().max(40).optional(), teamId: z.string().uuid().optional() });
export type ForecastQueryT = z.infer<typeof ForecastQuery>;

// ─── Periods ─────────────────────────────────────────────────────────────────

const pad = (n: number) => String(n).padStart(2, "0");
const firstOf = (year: number, month: number) => `${year}-${pad(month)}-01`;
const ym = (day: string) => day.split("-").map(Number) as [number, number, number];

/** The first day of the month or quarter `day` falls in. */
export function periodStartOf(type: PeriodType, day: string): string {
  const [y, m] = ym(day);
  return firstOf(y, type === "month" ? m : Math.floor((m - 1) / 3) * 3 + 1);
}

/** The period `n` periods after (negative: before) the one starting on `start`. */
export function shiftPeriod(type: PeriodType, start: string, n: number): string {
  const [y, m] = ym(periodStartOf(type, start));
  const index = y * 12 + (m - 1) + n * (type === "month" ? 1 : 3);
  return firstOf(Math.floor(index / 12), (index % 12) + 1);
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "October 2026" / "Q4 2026". */
export function periodLabel(type: PeriodType, start: string): string {
  const [y, m] = ym(periodStartOf(type, start));
  return type === "month" ? `${MONTHS[m - 1]} ${y}` : `Q${Math.floor((m - 1) / 3) + 1} ${y}`;
}

export type ForecastPeriod = {
  type: PeriodType;
  label: string;
  /** First local day, inclusive (also the period's key). */
  from: string;
  /** Last local day, inclusive. */
  to: string;
  timeZone: string;
  /** The instant `from` begins in `timeZone`. */
  start: Date;
  /** The instant the next period begins (exclusive end). */
  end: Date;
};

/** A month or quarter as local days and as the UTC instants it spans in the zone (DST settled by startOfLocalDay). */
export function periodBounds(type: PeriodType, day: string, timeZone: string): ForecastPeriod {
  const tz = isValidTimeZone(timeZone) ? timeZone : "UTC";
  const from = periodStartOf(type, day);
  const next = shiftPeriod(type, from, 1);
  return { type, label: periodLabel(type, from), from, to: addLocalDays(next, -1), timeZone: tz, start: startOfLocalDay(from, tz), end: startOfLocalDay(next, tz) };
}

export const FORECAST_PERIOD_PRESETS = [
  { key: "this_month", label: "This month", type: "month", offset: 0 },
  { key: "next_month", label: "Next month", type: "month", offset: 1 },
  { key: "last_month", label: "Last month", type: "month", offset: -1 },
  { key: "this_quarter", label: "This quarter", type: "quarter", offset: 0 },
  { key: "next_quarter", label: "Next quarter", type: "quarter", offset: 1 },
  { key: "last_quarter", label: "Last quarter", type: "quarter", offset: -1 },
] as const;
export type ForecastPeriodPreset = (typeof FORECAST_PERIOD_PRESETS)[number]["key"];

/** A preset as a period, given today's local date in the workspace's zone. */
export function presetPeriod(key: ForecastPeriodPreset, today: string): { periodType: PeriodType; periodStart: string } {
  const p = FORECAST_PERIOD_PRESETS.find((x) => x.key === key) ?? FORECAST_PERIOD_PRESETS[0];
  return { periodType: p.type, periodStart: shiftPeriod(p.type, periodStartOf(p.type, today), p.offset) };
}

// ─── The forecast ────────────────────────────────────────────────────────────

export type ForecastDealIn = {
  id: string;
  ownerId: string | null;
  value: number;
  currency: string;
  status: "open" | "won" | "lost";
  forecastCategory: string;
  /** The stage's win probability, 0–100. */
  probability: number;
  /** "YYYY-MM-DD" (a Postgres DATE), or an ISO instant at UTC midnight. */
  expectedCloseDate: string | Date | null;
  closedAt: string | Date | null;
};

/** userId: a rep's; teamId: a team's; neither: the workspace's. */
export type ForecastTargetIn = { userId: string | null; teamId?: string | null; metric: string; target: number; currency: string };

const round2 = (n: number) => Math.round(n * 100) / 100;
const dayOf = (v: string | Date | null): string | null => (v === null ? null : typeof v === "string" ? v.slice(0, 10) : v.toISOString().slice(0, 10));
const categoryOf = (c: string): ForecastCategory => ((FORECAST_CATEGORIES as readonly string[]).includes(c) ? (c as ForecastCategory) : "pipeline");

/** Why a deal belongs to the period: won inside it, or open and expected to close inside it. Null: it does not. */
export function dealInPeriod(d: Pick<ForecastDealIn, "status" | "expectedCloseDate" | "closedAt">, p: Pick<ForecastPeriod, "from" | "to" | "start" | "end">): "won" | "open" | null {
  if (d.status === "won") {
    if (!d.closedAt) return null;
    const t = new Date(d.closedAt).getTime();
    return t >= p.start.getTime() && t < p.end.getTime() ? "won" : null;
  }
  if (d.status !== "open") return null;
  const day = dayOf(d.expectedCloseDate);
  return day !== null && day >= p.from && day <= p.to ? "open" : null;
}

/** value × probability, to the cent. */
export const weightedValue = (value: number, probability: number) => round2((value * Math.min(Math.max(probability, 0), 100)) / 100);

export type ForecastFigures = {
  /** Revenue target (workspace currency); null when none is set. */
  target: number | null;
  won: number;
  commit: number;
  bestCase: number;
  pipeline: number;
  /** Open deals marked omitted: shown, never summed into the others. */
  omitted: number;
  /** Σ value × stage probability over open, not-omitted deals. */
  weighted: number;
  /** won + commit: what the owner says will land. */
  projected: number;
  /** won + commit + best case: the upside. */
  upside: number;
  /** target − won (negative: the target is beaten); null without a target. */
  gap: number | null;
  /** won ÷ target (1 = 100%); null without a positive target. */
  attainment: number | null;
  /** Open, not-omitted pipeline ÷ the gap still to win; null when nothing is left to win. */
  coverage: number | null;
  dealsWon: number;
  dealsWonTarget: number | null;
  meetingsBooked: number;
  meetingsBookedTarget: number | null;
  openDeals: number;
};

export type ForecastOtherCurrency = { currency: string; won: number; open: number; deals: number };

export type ForecastSummary = {
  total: ForecastFigures;
  /** One row per owner (null = unowned) with anything in the period, plus everyone in `owners`. */
  owners: (ForecastFigures & { ownerId: string | null })[];
  /** Deals in the period in other currencies: counted in deal counts, not in money. */
  otherCurrencies: ForecastOtherCurrency[];
  /** Revenue targets in another currency, which the forecast cannot compare against. */
  ignoredTargets: number;
};

const emptyCounts = () => ({ won: 0, commit: 0, bestCase: 0, pipeline: 0, omitted: 0, weighted: 0, dealsWon: 0, openDeals: 0 });
type Counts = ReturnType<typeof emptyCounts>;

function figures(c: Counts, targets: { revenue: number | null; deals: number | null; meetings: number | null }, meetingsBooked: number): ForecastFigures {
  const won = round2(c.won);
  const gap = targets.revenue === null ? null : round2(targets.revenue - won);
  const open = round2(c.commit + c.bestCase + c.pipeline);
  return {
    target: targets.revenue,
    won,
    commit: round2(c.commit),
    bestCase: round2(c.bestCase),
    pipeline: round2(c.pipeline),
    omitted: round2(c.omitted),
    weighted: round2(c.weighted),
    projected: round2(won + c.commit),
    upside: round2(won + c.commit + c.bestCase),
    gap,
    attainment: targets.revenue && targets.revenue > 0 ? won / targets.revenue : null,
    coverage: gap !== null && gap > 0 ? open / gap : null,
    dealsWon: c.dealsWon,
    dealsWonTarget: targets.deals,
    meetingsBooked,
    meetingsBookedTarget: targets.meetings,
    openDeals: c.openDeals,
  };
}

/**
 * The forecast for one period. `deals` may hold anything (it is filtered with
 * dealInPeriod); `meetings` are counts already limited to the period.
 * The total's target for a metric is an explicit one — the workspace's
 * (userId and teamId null) when `teamTargets` allows it, or with `totalTeamId`
 * that team's — else the sum of the owners' targets, else null.
 */
export function summarizeForecast(input: {
  currency: string;
  period: Pick<ForecastPeriod, "from" | "to" | "start" | "end">;
  deals: ForecastDealIn[];
  targets: ForecastTargetIn[];
  meetings?: { ownerId: string | null; count: number }[];
  /** Owners to list even with nothing in the period. */
  owners?: string[];
  /** Use the workspace-level target for the total. Default true. */
  teamTargets?: boolean;
  /** Measure the total against this team's target instead (the forecast narrowed to one team). */
  totalTeamId?: string | null;
}): ForecastSummary {
  const total = emptyCounts();
  const byOwner = new Map<string | null, Counts>();
  const other = new Map<string, ForecastOtherCurrency>();
  const row = (id: string | null) => byOwner.get(id) ?? byOwner.set(id, emptyCounts()).get(id)!;
  for (const id of input.owners ?? []) row(id);

  for (const d of input.deals) {
    const where = dealInPeriod(d, input.period);
    if (!where) continue;
    const r = row(d.ownerId);
    if (where === "won") {
      total.dealsWon += 1;
      r.dealsWon += 1;
    }
    const category = categoryOf(d.forecastCategory);
    if (where === "open" && category !== "omitted") {
      total.openDeals += 1;
      r.openDeals += 1;
    }
    if (d.currency !== input.currency) {
      const o = other.get(d.currency) ?? other.set(d.currency, { currency: d.currency, won: 0, open: 0, deals: 0 }).get(d.currency)!;
      o.deals += 1;
      if (where === "won") o.won = round2(o.won + d.value);
      else if (category !== "omitted") o.open = round2(o.open + d.value);
      continue;
    }
    for (const c of [total, r]) {
      if (where === "won") c.won += d.value;
      else if (category === "omitted") c.omitted += d.value;
      else {
        if (category === "commit") c.commit += d.value;
        else if (category === "best_case") c.bestCase += d.value;
        else c.pipeline += d.value;
        c.weighted += weightedValue(d.value, d.probability);
      }
    }
  }

  let ignoredTargets = 0;
  const targetOf = new Map<string, number>();
  for (const t of input.targets) {
    if (t.metric === "revenue_won" && t.currency !== input.currency) {
      ignoredTargets += 1;
      continue;
    }
    // A team's target only measures the total when the forecast is narrowed to that team.
    if (t.teamId && t.teamId !== input.totalTeamId) continue;
    if (t.userId !== null) row(t.userId);
    const key = t.teamId ? `team:${t.teamId}|${t.metric}` : `${t.userId ?? ""}|${t.metric}`;
    targetOf.set(key, (targetOf.get(key) ?? 0) + t.target);
  }
  const meetingsOf = new Map<string | null, number>();
  for (const m of input.meetings ?? []) {
    row(m.ownerId);
    meetingsOf.set(m.ownerId, (meetingsOf.get(m.ownerId) ?? 0) + m.count);
  }

  const ownerTarget = (id: string | null, metric: TargetMetric) => (id === null ? null : (targetOf.get(`${id}|${metric}`) ?? null));
  const teamTarget = (metric: TargetMetric) => {
    const team = input.totalTeamId ? targetOf.get(`team:${input.totalTeamId}|${metric}`) : input.teamTargets === false ? undefined : targetOf.get(`|${metric}`);
    if (team !== undefined) return team;
    const owned = [...byOwner.keys()].map((id) => ownerTarget(id, metric)).filter((v): v is number => v !== null);
    return owned.length ? round2(owned.reduce((a, b) => a + b, 0)) : null;
  };
  const owners = [...byOwner.entries()].map(([ownerId, c]) => ({
    ownerId,
    ...figures(c, { revenue: ownerTarget(ownerId, "revenue_won"), deals: ownerTarget(ownerId, "deals_won"), meetings: ownerTarget(ownerId, "meetings_booked") }, meetingsOf.get(ownerId) ?? 0),
  }));
  const meetingsTotal = [...meetingsOf.values()].reduce((a, b) => a + b, 0);
  return {
    total: figures(total, { revenue: teamTarget("revenue_won"), deals: teamTarget("deals_won"), meetings: teamTarget("meetings_booked") }, meetingsTotal),
    owners,
    otherCurrencies: [...other.values()].sort((a, b) => a.currency.localeCompare(b.currency)),
    ignoredTargets,
  };
}

/**
 * A team's figures: the sum of its members' rows (from summarizeForecast)
 * against the team's own target, else the sum of its members' targets.
 * Deactivated members' won deals and meetings still count; their open
 * pipeline does not (nobody is working it).
 */
export function rollUpTeam(input: {
  owners: (ForecastFigures & { ownerId: string | null })[];
  memberIds: string[];
  deactivated?: Set<string> | string[];
  /** The team's own targets (teamId set); revenue ones must already be in the workspace currency. */
  targets: { metric: string; target: number }[];
}): ForecastFigures {
  const members = new Set(input.memberIds);
  const off = new Set(input.deactivated ?? []);
  const c = emptyCounts();
  let meetings = 0;
  const sums = { revenue: [] as number[], deals: [] as number[], meetings: [] as number[] };
  for (const r of input.owners) {
    if (!r.ownerId || !members.has(r.ownerId)) continue;
    c.won += r.won;
    c.dealsWon += r.dealsWon;
    meetings += r.meetingsBooked;
    if (r.target !== null) sums.revenue.push(r.target);
    if (r.dealsWonTarget !== null) sums.deals.push(r.dealsWonTarget);
    if (r.meetingsBookedTarget !== null) sums.meetings.push(r.meetingsBookedTarget);
    if (off.has(r.ownerId)) continue;
    c.commit += r.commit;
    c.bestCase += r.bestCase;
    c.pipeline += r.pipeline;
    c.omitted += r.omitted;
    c.weighted += r.weighted;
    c.openDeals += r.openDeals;
  }
  const own = (metric: TargetMetric) => input.targets.filter((t) => t.metric === metric).reduce<number | null>((a, t) => (a ?? 0) + t.target, null);
  const summed = (list: number[]) => (list.length ? round2(list.reduce((a, b) => a + b, 0)) : null);
  return figures(c, { revenue: own("revenue_won") ?? summed(sums.revenue), deals: own("deals_won") ?? summed(sums.deals), meetings: own("meetings_booked") ?? summed(sums.meetings) }, meetings);
}

// ─── Stale deals ─────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;

/** The latest of several "something happened" instants (nulls ignored). */
export function latestOf(...dates: (Date | string | null | undefined)[]): Date | null {
  let best: number | null = null;
  for (const d of dates) {
    if (d === null || d === undefined) continue;
    const t = new Date(d).getTime();
    if (Number.isFinite(t) && (best === null || t > best)) best = t;
  }
  return best === null ? null : new Date(best);
}

export type Staleness = { since: Date; days: number };

/**
 * A deal is stale when it is open, its stage has a "stale after" (rotDays),
 * and more than that many days have passed since its last progress (entering
 * the stage, a timeline entry, a completed task, a held meeting, a call).
 * `days` counts whole days since that progress.
 */
export function dealStaleness(d: { status: string; rotDays: number | null | undefined; lastProgress: Date | string }, now: Date = new Date()): Staleness | null {
  if (d.status !== "open" || d.rotDays === null || d.rotDays === undefined || d.rotDays <= 0) return null;
  const since = new Date(d.lastProgress);
  const idle = now.getTime() - since.getTime();
  if (!(idle > d.rotDays * DAY_MS)) return null;
  return { since, days: Math.floor(idle / DAY_MS) };
}

/** The owner hears once per stale spell: never told yet, or told before the last progress (which ended the previous spell). */
export const staleNoticeDue = (staleNotifiedAt: Date | string | null, lastProgress: Date | string): boolean =>
  staleNotifiedAt === null || new Date(staleNotifiedAt).getTime() < new Date(lastProgress).getTime();
