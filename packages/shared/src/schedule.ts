/*
 * Sending windows in the campaign's own time zone.
 *
 * Adapted from LinkDesk's nextOpening(), which read the server's local clock
 * (getDay/getHours) and ignored the schedule's declared time zone. This one
 * resolves wall-clock time through Intl, so "Mon–Fri 09:00–17:00 Asia/Dhaka"
 * means Dhaka business hours whatever zone the worker runs in, across DST.
 */

export type Schedule = {
  timezone?: string;
  /** 0 = Sunday … 6 = Saturday (Date#getDay convention, as in LinkDesk). */
  days?: number[];
  from?: string;
  to?: string;
};

export const DEFAULT_SCHEDULE: Required<Schedule> = {
  timezone: "UTC",
  days: [1, 2, 3, 4, 5],
  from: "09:00",
  to: "17:00",
};

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

const minutesOf = (hhmm: string | undefined, fallback: number) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm ?? "");
  return m ? Number(m[1]) * 60 + Number(m[2]) : fallback;
};

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      weekday: "short",
    });
    formatters.set(tz, f);
  }
  return f;
}

export function isValidTimeZone(tz: string): boolean {
  try {
    formatter(tz);
    return true;
  } catch {
    return false;
  }
}

export type ZonedParts = { year: number; month: number; day: number; hour: number; minute: number; second: number; weekday: number };

export function zonedParts(date: Date, tz: string): ZonedParts {
  const parts = Object.fromEntries(formatter(tz).formatToParts(date).map((p) => [p.type, p.value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: WEEKDAYS[parts.weekday ?? "Sun"] ?? 0,
  };
}

/** Offset of `tz` from UTC at `date`, in milliseconds. */
function offsetAt(date: Date, tz: string): number {
  const p = zonedParts(date, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** The instant at which the wall clock in `tz` reads the given local time. */
export function zonedTime(year: number, month: number, day: number, hour: number, minute: number, tz: string): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  let instant = guess - offsetAt(new Date(guess), tz);
  // A second pass settles instants that straddle a DST change.
  const corrected = guess - offsetAt(new Date(instant), tz);
  if (corrected !== instant) instant = corrected;
  return new Date(instant);
}

/** The local calendar date in `tz` for an instant, as "YYYY-MM-DD". */
export function localDay(date: Date, tz: string): string {
  const p = zonedParts(date, tz);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/**
 * The first instant at or after `from` that falls inside the window. Outside
 * the window the answer is the next opening rather than "no" — a step that
 * comes due at midnight goes out at nine.
 */
export function nextOpening(schedule: Schedule, from: Date = new Date()): Date {
  const tz = schedule.timezone && isValidTimeZone(schedule.timezone) ? schedule.timezone : "UTC";
  const days = schedule.days?.length ? schedule.days : DEFAULT_SCHEDULE.days;
  const open = minutesOf(schedule.from, 9 * 60);
  const close = minutesOf(schedule.to, 17 * 60);
  if (close <= open) return from;

  let cursor = from;
  for (let i = 0; i < 15; i++) {
    const p = zonedParts(cursor, tz);
    const now = p.hour * 60 + p.minute;
    if (days.includes(p.weekday)) {
      if (now < open) return zonedTime(p.year, p.month, p.day, Math.floor(open / 60), open % 60, tz);
      if (now < close) return cursor;
    }
    // The next local day, from its opening.
    const next = new Date(Date.UTC(p.year, p.month - 1, p.day + 1));
    cursor = zonedTime(
      next.getUTCFullYear(),
      next.getUTCMonth() + 1,
      next.getUTCDate(),
      Math.floor(open / 60),
      open % 60,
      tz,
    );
  }
  return cursor;
}

export const isOpenNow = (schedule: Schedule, now: Date = new Date()) =>
  nextOpening(schedule, now).getTime() <= now.getTime();
