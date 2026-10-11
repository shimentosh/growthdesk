import { z } from "zod";
import { isValidTimeZone, localDay, zonedTime } from "./schedule.js";

/*
 * Report date ranges.
 *
 * A report covers whole calendar days in the WORKSPACE's time zone, so "Oct 9"
 * means the same 24 hours for everybody on the team. The query carries local
 * days ("YYYY-MM-DD", both ends inclusive); the API turns them into a
 * half-open UTC interval [start, end) with zonedTime(), which settles DST, and
 * buckets rows by their local day in SQL. Everything here is pure, so the web
 * app computes presets with the same arithmetic the API validates against.
 */

export const ANALYTICS_DEFAULT_DAYS = 30;
/** Longest range one request may cover (a leap year). Keeps a daily series to ≤ 366 points. */
export const ANALYTICS_MAX_DAYS = 366;

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;

/** Days since 1970-01-01 for a "YYYY-MM-DD" (calendar arithmetic only; no zone involved). */
function epochDay(day: string): number {
  const m = DAY_RE.exec(day);
  if (!m) return Number.NaN;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / DAY_MS;
}

function fromEpochDay(n: number): string {
  return new Date(n * DAY_MS).toISOString().slice(0, 10);
}

/** True for a real calendar date written "YYYY-MM-DD" (rejects 2026-02-30). */
export function isLocalDateString(value: string): boolean {
  const n = epochDay(value);
  return Number.isFinite(n) && fromEpochDay(n) === value;
}

/** "2026-10-09" + 1 → "2026-10-10". */
export const addLocalDays = (day: string, n: number): string => fromEpochDay(epochDay(day) + n);

/** Whole days from `from` to `to` (0 when equal, negative when `to` is earlier). */
export const localDayDiff = (from: string, to: string): number => epochDay(to) - epochDay(from);

/** Every day from `from` to `to`, both included. */
export function localDaysBetween(from: string, to: string): string[] {
  const start = epochDay(from);
  const n = epochDay(to) - start;
  if (!Number.isFinite(n) || n < 0) return [];
  return Array.from({ length: n + 1 }, (_, i) => fromEpochDay(start + i));
}

export const localDateParam = z.string().refine(isLocalDateString, "Use a date written YYYY-MM-DD");

const rangeShape = { from: localDateParam.optional(), to: localDateParam.optional() };

function checkRange(v: { from?: string; to?: string }, ctx: z.RefinementCtx) {
  if (!v.from || !v.to) return;
  const span = localDayDiff(v.from, v.to);
  if (span < 0) ctx.addIssue({ code: "custom", path: ["to"], message: "The end date is before the start date" });
  else if (span + 1 > ANALYTICS_MAX_DAYS) ctx.addIssue({ code: "custom", path: ["to"], message: `A report can cover at most ${ANALYTICS_MAX_DAYS} days` });
}

/** `?from=YYYY-MM-DD&to=YYYY-MM-DD` in the workspace's zone; both optional (default: the last 30 days). */
export const AnalyticsRangeQuery = z.object(rangeShape).superRefine(checkRange);
export type AnalyticsRangeQueryT = z.infer<typeof AnalyticsRangeQuery>;

/** The pipeline report: a range plus which pipeline's funnel (default: the workspace's default pipeline). */
export const AnalyticsPipelineQuery = z.object({ ...rangeShape, pipelineId: z.string().uuid().optional() }).superRefine(checkRange);
export type AnalyticsPipelineQueryT = z.infer<typeof AnalyticsPipelineQuery>;

export type ResolvedRange = {
  /** First local day, inclusive. */
  from: string;
  /** Last local day, inclusive. */
  to: string;
  days: number;
  timeZone: string;
  /** The instant `from` begins in `timeZone`. */
  start: Date;
  /** The instant the day after `to` begins in `timeZone` (exclusive end). */
  end: Date;
};

/**
 * Fills in a missing end (today in the zone, or `from` if that is later) and
 * a missing start (29 days before the end), then converts to instants.
 * Assumes the query passed AnalyticsRangeQuery; a span that is still too long
 * (one end given far from today) is cut to the last ANALYTICS_MAX_DAYS days.
 */
export function resolveRange(q: { from?: string; to?: string }, timeZone: string, now: Date = new Date()): ResolvedRange {
  const tz = isValidTimeZone(timeZone) ? timeZone : "UTC";
  const today = localDay(now, tz);
  let to = q.to ?? (q.from && localDayDiff(q.from, today) < 0 ? q.from : today);
  let from = q.from ?? addLocalDays(to, -(ANALYTICS_DEFAULT_DAYS - 1));
  if (localDayDiff(from, to) < 0) [from, to] = [to, from];
  if (localDayDiff(from, to) + 1 > ANALYTICS_MAX_DAYS) from = addLocalDays(to, -(ANALYTICS_MAX_DAYS - 1));
  return { from, to, days: localDayDiff(from, to) + 1, timeZone: tz, start: startOfLocalDay(from, tz), end: startOfLocalDay(addLocalDays(to, 1), tz) };
}

/** The instant a local day begins in a zone (midnight, or the first instant after a DST gap at midnight). */
export function startOfLocalDay(day: string, timeZone: string): Date {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return zonedTime(y, m, d, 0, 0, timeZone);
}

export const RANGE_PRESETS = [
  { key: "7d", label: "Last 7 days" },
  { key: "30d", label: "Last 30 days" },
  { key: "90d", label: "Last 90 days" },
  { key: "mtd", label: "This month" },
  { key: "last_month", label: "Last month" },
  { key: "qtd", label: "This quarter" },
  { key: "ytd", label: "This year" },
] as const;
export type RangePreset = (typeof RANGE_PRESETS)[number]["key"];

/** A preset as local days, given today's local date in the workspace's zone. */
export function presetRange(preset: RangePreset, today: string): { from: string; to: string } {
  const [y, m] = today.split("-").map(Number) as [number, number];
  const first = (year: number, month: number) => `${year}-${String(month).padStart(2, "0")}-01`;
  switch (preset) {
    case "7d":
      return { from: addLocalDays(today, -6), to: today };
    case "30d":
      return { from: addLocalDays(today, -29), to: today };
    case "90d":
      return { from: addLocalDays(today, -89), to: today };
    case "mtd":
      return { from: first(y, m), to: today };
    case "last_month": {
      const start = m === 1 ? first(y - 1, 12) : first(y, m - 1);
      return { from: start, to: addLocalDays(first(y, m), -1) };
    }
    case "qtd":
      return { from: first(y, Math.floor((m - 1) / 3) * 3 + 1), to: today };
    case "ytd":
      return { from: first(y, 1), to: today };
  }
}

/** The preset a range is equal to, if any (for labelling the picker). */
export function matchPreset(range: { from: string; to: string }, today: string): RangePreset | null {
  for (const p of RANGE_PRESETS) {
    const r = presetRange(p.key, today);
    if (r.from === range.from && r.to === range.to) return p.key;
  }
  return null;
}

/** numerator / denominator, or null when there is nothing to divide by (shown as "—", never as 0%). */
export const safeRatio = (numerator: number, denominator: number): number | null => (denominator > 0 ? numerator / denominator : null);
