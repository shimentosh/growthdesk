/*
 * Formatting for people: dates in a time zone, relative time, numbers, money.
 *
 * Pure and server-safe. Every date function takes the time zone explicitly;
 * inside a workspace use `useFormat()` from src/lib/session.tsx, which binds
 * these to the workspace's time zone and currency so a timestamp reads the
 * same for everybody on the team, wherever their laptop is.
 */
import { formatMoney } from "@growthdesk/shared";

export { formatMoney };

export type DateInput = string | number | Date | null | undefined;

const LOCALE = "en-US";

export function toDate(value: DateInput): Date | null {
  if (value === null || value === undefined || value === "") return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

export const browserTimeZone = (): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
};

const cache = new Map<string, Intl.DateTimeFormat>();
function dtf(timeZone: string | undefined, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${timeZone ?? ""}|${JSON.stringify(options)}`;
  let f = cache.get(key);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat(LOCALE, { ...options, timeZone });
    } catch {
      // An unknown zone name should not take the page down; fall back to UTC.
      f = new Intl.DateTimeFormat(LOCALE, { ...options, timeZone: "UTC" });
    }
    cache.set(key, f);
  }
  return f;
}

type TzOpt = { timeZone?: string };
const EMPTY = "—";

/** "Oct 9, 2026" */
export function formatDate(value: DateInput, opts: TzOpt & { style?: "short" | "medium" | "long" } = {}): string {
  const d = toDate(value);
  if (!d) return EMPTY;
  const style = opts.style ?? "medium";
  const o: Intl.DateTimeFormatOptions =
    style === "short"
      ? { month: "numeric", day: "numeric", year: "2-digit" }
      : style === "long"
        ? { weekday: "long", month: "long", day: "numeric", year: "numeric" }
        : { month: "short", day: "numeric", year: "numeric" };
  return dtf(opts.timeZone, o).format(d);
}

/** "3:04 PM" */
export function formatTime(value: DateInput, opts: TzOpt = {}): string {
  const d = toDate(value);
  if (!d) return EMPTY;
  return dtf(opts.timeZone, { hour: "numeric", minute: "2-digit" }).format(d);
}

/** "Oct 9, 2026, 3:04 PM" */
export function formatDateTime(value: DateInput, opts: TzOpt = {}): string {
  const d = toDate(value);
  if (!d) return EMPTY;
  return dtf(opts.timeZone, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }).format(d);
}

/** The calendar day of an instant in a zone, as "YYYY-MM-DD". */
export function dayKey(value: DateInput, timeZone?: string): string {
  const d = toDate(value);
  if (!d) return "";
  const p = zonedParts(d, timeZone ?? "UTC");
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** Compact, list-friendly: today → "3:04 PM", this year → "Oct 9", else → "Oct 9, 2025". */
export function formatSmartDate(value: DateInput, opts: TzOpt & { now?: Date } = {}): string {
  const d = toDate(value);
  if (!d) return EMPTY;
  const now = opts.now ?? new Date();
  if (dayKey(d, opts.timeZone) === dayKey(now, opts.timeZone)) return formatTime(d, opts);
  const sameYear = zonedParts(d, opts.timeZone ?? "UTC").year === zonedParts(now, opts.timeZone ?? "UTC").year;
  return dtf(opts.timeZone, sameYear ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" }).format(d);
}

const rtf = new Intl.RelativeTimeFormat(LOCALE, { numeric: "auto" });

/** "just now", "5 minutes ago", "in 3 hours", "yesterday"; beyond ~4 weeks, the date. */
export function formatRelative(value: DateInput, opts: TzOpt & { now?: Date } = {}): string {
  const d = toDate(value);
  if (!d) return EMPTY;
  const now = (opts.now ?? new Date()).getTime();
  const diffSec = Math.round((d.getTime() - now) / 1000);
  const abs = Math.abs(diffSec);
  if (abs < 45) return "just now";
  if (abs < 45 * 60) return rtf.format(Math.round(diffSec / 60), "minute");
  if (abs < 22 * 3600) return rtf.format(Math.round(diffSec / 3600), "hour");
  if (abs < 6 * 86400) return rtf.format(Math.round(diffSec / 86400), "day");
  if (abs < 27 * 86400) return rtf.format(Math.round(diffSec / (7 * 86400)), "week");
  return formatDate(d, opts);
}

/** Whole days from now until the instant (negative when past). */
export function daysUntil(value: DateInput, now = new Date()): number | null {
  const d = toDate(value);
  if (!d) return null;
  return Math.ceil((d.getTime() - now.getTime()) / 86_400_000);
}

// ─── Numbers & money ────────────────────────────────────────────────────────

export function formatNumber(n: number | null | undefined, options: Intl.NumberFormatOptions = {}): string {
  if (n === null || n === undefined || Number.isNaN(n)) return EMPTY;
  return new Intl.NumberFormat(LOCALE, options).format(n);
}

/** 1234 → "1.2K" */
export function formatCompact(n: number | null | undefined): string {
  return formatNumber(n, { notation: "compact", maximumFractionDigits: 1 });
}

/** A ratio (0.125) as "12.5%". Pass `digits` to change the precision. */
export function formatPercent(ratio: number | null | undefined, digits = 1): string {
  if (ratio === null || ratio === undefined || Number.isNaN(ratio)) return EMPTY;
  return new Intl.NumberFormat(LOCALE, { style: "percent", maximumFractionDigits: digits }).format(ratio);
}

/**
 * An amount in MAJOR units (deal values: 1250.5 → "$1,250.50").
 * For integer cents (plan prices, invoices) use `formatMoney` from @growthdesk/shared.
 */
export function formatCurrency(amount: number | null | undefined, currency = "USD", options: Intl.NumberFormatOptions = {}): string {
  if (amount === null || amount === undefined || Number.isNaN(amount)) return EMPTY;
  try {
    return new Intl.NumberFormat(LOCALE, {
      style: "currency",
      currency,
      maximumFractionDigits: Number.isInteger(amount) ? 0 : 2,
      ...options,
    }).format(amount);
  } catch {
    return `${formatNumber(amount)} ${currency}`;
  }
}

/** Seconds → "4:05" under an hour, "1:02:09" above. */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || Number.isNaN(seconds)) return EMPTY;
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return EMPTY;
  const units = ["B", "KB", "MB", "GB"];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 && i ? 1 : 0)} ${units[i]}`;
}

/** "Jane Doe" / "jane@x.com" → "JD" / "J" */
export function initials(name?: string | null, email?: string | null): string {
  const src = (name ?? "").trim();
  if (src) {
    const parts = src.split(/\s+/).filter(Boolean);
    const first = parts[0]?.[0] ?? "";
    const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : "";
    return (first + last).toUpperCase();
  }
  return (email ?? "?").trim().charAt(0).toUpperCase() || "?";
}

// ─── Time zones ─────────────────────────────────────────────────────────────

const pad = (n: number) => String(n).padStart(2, "0");

export type ZonedParts = { year: number; month: number; day: number; hour: number; minute: number; second: number };

/** The wall-clock reading of an instant in a zone. */
export function zonedParts(date: Date, timeZone: string): ZonedParts {
  const parts = dtf(timeZone, {
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour") % 24, minute: get("minute"), second: get("second") };
}

/** Minutes the zone is ahead of UTC at that instant (Berlin in summer → 120). */
export function tzOffsetMinutes(date: Date, timeZone: string): number {
  const p = zonedParts(date, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(date.getTime() / 1000) * 1000) / 60_000);
}

/**
 * An instant as the value an <input type="datetime-local"> (or "date") shows
 * in a zone: "2026-10-09T15:04" / "2026-10-09".
 */
export function utcToZonedInput(value: DateInput, timeZone: string, mode: "datetime" | "date" = "datetime"): string {
  const d = toDate(value);
  if (!d) return "";
  const p = zonedParts(d, timeZone);
  const date = `${p.year}-${pad(p.month)}-${pad(p.day)}`;
  return mode === "date" ? date : `${date}T${pad(p.hour)}:${pad(p.minute)}`;
}

/**
 * The inverse: a wall-clock value typed in a zone → the ISO instant. Two
 * passes settle the offset across DST changes; a wall time that does not
 * exist (the skipped hour) lands on the instant just after the jump.
 */
export function zonedInputToUtc(value: string, timeZone: string): string | null {
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!m) return null;
  const [, y, mo, d, h = "0", mi = "0", s = "0"] = m;
  const wall = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
  let guess = wall - tzOffsetMinutes(new Date(wall), timeZone) * 60_000;
  guess = wall - tzOffsetMinutes(new Date(guess), timeZone) * 60_000;
  return new Date(guess).toISOString();
}

/** "GMT+2", "EDT" — the short name of a zone at an instant. */
export function zoneAbbreviation(timeZone: string, at: Date = new Date()): string {
  try {
    const part = new Intl.DateTimeFormat(LOCALE, { timeZone, timeZoneName: "short" })
      .formatToParts(at)
      .find((p) => p.type === "timeZoneName");
    return part?.value ?? timeZone;
  } catch {
    return timeZone;
  }
}

/** Every IANA zone the runtime knows, with UTC first. */
export function timeZones(): string[] {
  let zones: string[] = [];
  try {
    zones = Intl.supportedValuesOf("timeZone");
  } catch {
    zones = [];
  }
  return ["UTC", ...zones.filter((z) => z !== "UTC")];
}

/** ISO 4217 codes with readable names, common ones first. */
export function currencies(): { code: string; label: string }[] {
  const common = ["USD", "EUR", "GBP", "CAD", "AUD", "INR", "BDT", "SGD", "AED", "JPY"];
  let all: string[] = [];
  try {
    all = Intl.supportedValuesOf("currency");
  } catch {
    all = common;
  }
  let names: Intl.DisplayNames | null = null;
  try {
    names = new Intl.DisplayNames([LOCALE], { type: "currency" });
  } catch {
    names = null;
  }
  const label = (c: string) => `${c} — ${names?.of(c) ?? c}`;
  const rest = all.filter((c) => !common.includes(c));
  return [...common.filter((c) => all.includes(c) || all.length === 0), ...rest].map((code) => ({ code, label: label(code) }));
}
