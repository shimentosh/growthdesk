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

/** The instant the local calendar day after the one containing `date` begins in `tz`. */
function startOfNextDay(date: Date, tz: string): Date {
  const p = zonedParts(date, tz);
  const next = new Date(Date.UTC(p.year, p.month - 1, p.day + 1));
  return zonedTime(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), 0, 0, tz);
}

const ymd = (date: Date, tz: string): [number, number, number] => {
  const p = zonedParts(date, tz);
  return [p.year, p.month, p.day];
};

const resolveZone = (schedule: Schedule) => (schedule.timezone && isValidTimeZone(schedule.timezone) ? schedule.timezone : "UTC");

/**
 * The first instant at or after `from` that falls inside the window. Outside
 * the window the answer is the next opening rather than "no" — a step that
 * comes due at midnight goes out at nine.
 *
 * A window whose close is not after its open runs overnight: "22:00–06:00"
 * on Monday opens Monday 22:00 and closes Tuesday 06:00, so `days` names the
 * day a window opens on. Equal times mean a full 24 hours from that time.
 */
export function nextOpening(schedule: Schedule, from: Date = new Date()): Date {
  const tz = resolveZone(schedule);
  const days = schedule.days?.length ? schedule.days : DEFAULT_SCHEDULE.days;
  const open = minutesOf(schedule.from, 9 * 60);
  const close = minutesOf(schedule.to, 17 * 60);
  const overnight = close <= open;

  let cursor = from;
  for (let i = 0; i < 16; i++) {
    const p = zonedParts(cursor, tz);
    const now = p.hour * 60 + p.minute;
    // The tail of an overnight window that opened the evening before.
    if (overnight && now < close && days.includes((p.weekday + 6) % 7)) return cursor;
    if (days.includes(p.weekday)) {
      if (now < open) return zonedTime(p.year, p.month, p.day, Math.floor(open / 60), open % 60, tz);
      if (overnight || now < close) return cursor;
    }
    // Overnight windows can open just after midnight (their tail), so look from the start of the next day.
    const next = startOfNextDay(cursor, tz);
    cursor = overnight ? next : zonedTime(...ymd(next, tz), Math.floor(open / 60), open % 60, tz);
  }
  return cursor;
}

export const isOpenNow = (schedule: Schedule, now: Date = new Date()) =>
  nextOpening(schedule, now).getTime() <= now.getTime();

/** Starts already booked on one local day: how many, and the latest of them (ms). */
export type DayLoad = { count: number; last: number };

/**
 * Start times for new enrollments under a per-day cap. Each item gets the
 * first instant at or after its floor that is inside the window, on a local
 * day (in the schedule's zone) with fewer than `limit` starts, and at least
 * `gapMs` after the latest start already on that day. `taken` holds the
 * starts already booked or made, keyed by localDay(); it is not modified.
 *
 * Floors are best given in ascending order: a sorted queue is planned in
 * one pass over the days rather than one pass per item.
 *
 * Counting per real local day (instead of "day i = floor(i / limit)") is what
 * keeps a weekend from folding three days' starts onto Monday, and a second
 * batch from landing on top of the first.
 */
export function planStarts(schedule: Schedule, floors: Date[], opts: { limit: number; gapMs: number; taken?: Map<string, DayLoad> }): Date[] {
  const tz = resolveZone(schedule);
  const limit = Math.max(1, Math.floor(opts.limit));
  const taken = new Map(opts.taken ?? []);
  // Days skipped as full for one item are still full for the next when its floor is no earlier,
  // so a sorted queue resumes from the last day used instead of rescanning from its floor.
  let prev = { floor: Number.POSITIVE_INFINITY, dayStart: 0 };
  return floors.map((floor) => {
    const from = floor.getTime() >= prev.floor ? Math.max(floor.getTime(), prev.dayStart) : floor.getTime();
    prev = { floor: floor.getTime(), dayStart: from };
    let t = nextOpening(schedule, new Date(from));
    // A day per pass at most; ten years of full days is far past any real queue.
    for (let guard = 0; guard < 3660; guard++) {
      const day = localDay(t, tz);
      const load = taken.get(day) ?? { count: 0, last: Number.NEGATIVE_INFINITY };
      if (load.count < limit) {
        const at = nextOpening(schedule, new Date(Math.max(t.getTime(), load.last + opts.gapMs)));
        if (localDay(at, tz) === day) {
          taken.set(day, { count: load.count + 1, last: at.getTime() });
          prev.dayStart = zonedTime(...ymd(at, tz), 0, 0, tz).getTime();
          return at;
        }
      }
      // This day is full (by count, or the window closed before the next gap): try the next one.
      t = nextOpening(schedule, startOfNextDay(t, tz));
    }
    return t;
  });
}
