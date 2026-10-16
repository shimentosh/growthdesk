import { z } from "zod";
import { isValidTimeZone, localDay, zonedParts, zonedTime } from "./schedule.js";
import { email, isoDate, requiredText, text, uuid } from "./schemas.js";

/*
 * Calendar sync and booking pages (Calendly-style): the inputs the booking
 * API takes and the pure rules both sides read — above all the slot
 * computation, which the API runs for the public page and again, race-safe,
 * when someone books.
 *
 * A page's weekly hours are wall-clock times in the page's own time zone
 * ("Mon 09:00–17:00 Europe/Berlin"), resolved through Intl (schedule.ts), so
 * they mean the same local hours on both sides of a DST change. Slots are
 * instants (ISO strings); the visitor's page shows them in the visitor's zone.
 */

export const CALENDAR_PROVIDERS = ["google", "microsoft"] as const;
export type CalendarProvider = (typeof CALENDAR_PROVIDERS)[number];
export const CALENDAR_PROVIDER_LABELS: Record<CalendarProvider, string> = { google: "Google Calendar", microsoft: "Microsoft Outlook" };

export const BOOKING_ASSIGNMENTS = ["single", "round_robin"] as const;
export type BookingAssignment = (typeof BOOKING_ASSIGNMENTS)[number];

/** google_meet / teams ask the host's calendar to create the video link; the others are written into the event's location. */
export const BOOKING_LOCATION_TYPES = ["google_meet", "teams", "phone", "in_person", "custom"] as const;
export type BookingLocationType = (typeof BOOKING_LOCATION_TYPES)[number];
export const BOOKING_LOCATION_LABELS: Record<BookingLocationType, string> = {
  google_meet: "Google Meet",
  teams: "Microsoft Teams",
  phone: "Phone call",
  in_person: "In person",
  custom: "Other",
};

/**
 * Form questions. `phone` is also saved as the contact's phone number; `consent`
 * is a checkbox ("I agree to be called…") that, when ticked, records the
 * contact's consent as granted — the AI calling feature only calls contacts
 * whose consent is granted. A page has at most one consent question.
 */
export const BOOKING_QUESTION_TYPES = ["text", "textarea", "phone", "consent"] as const;
export type BookingQuestionType = (typeof BOOKING_QUESTION_TYPES)[number];

/** Slugs that are routes of their own under /book. */
export const RESERVED_BOOKING_SLUGS = ["manage", "new", "api", "admin"] as const;
const SLUG = /^[a-z0-9](?:[a-z0-9-]{1,58}[a-z0-9])$/;
export const isValidBookingSlug = (slug: string) => SLUG.test(slug) && !slug.includes("--") && !(RESERVED_BOOKING_SLUGS as readonly string[]).includes(slug);

/** "Intro call with Ada" → "intro-call-with-ada" (a starting point; the person can change it). */
export const slugifyBooking = (s: string) =>
  s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$|^24:00$/;
const minutesOf = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

export const BookingHours = z
  .object({
    /** 0 = Sunday … 6 = Saturday (Date#getDay, as in schedule.ts). */
    day: z.number().int().min(0).max(6),
    from: z.string().regex(HHMM, "Use HH:MM"),
    to: z.string().regex(HHMM, "Use HH:MM"),
  })
  .refine((h) => minutesOf(h.to) > minutesOf(h.from), { message: "The end must be after the start", path: ["to"] });
export type BookingHoursT = z.infer<typeof BookingHours>;

export const BookingAvailability = z.object({
  timezone: z.string().trim().max(64).refine(isValidTimeZone, "Unknown time zone"),
  hours: z.array(BookingHours).max(50),
});
export type BookingAvailabilityT = z.infer<typeof BookingAvailability>;

export const DEFAULT_BOOKING_AVAILABILITY = (timezone = "UTC"): BookingAvailabilityT => ({
  timezone,
  hours: [1, 2, 3, 4, 5].map((day) => ({ day, from: "09:00", to: "17:00" })),
});

export const BookingQuestion = z.object({
  id: z.string().trim().regex(/^[a-z0-9_-]{1,40}$/i, "Letters, digits, - and _ only"),
  label: requiredText(300),
  type: z.enum(BOOKING_QUESTION_TYPES).default("text"),
  required: z.boolean().default(false),
});
export type BookingQuestionT = z.infer<typeof BookingQuestion>;

const questions = z
  .array(BookingQuestion)
  .max(12)
  .refine((qs) => new Set(qs.map((q) => q.id)).size === qs.length, "Each question needs its own id")
  .refine((qs) => qs.filter((q) => q.type === "consent").length <= 1, "Only one consent question per page")
  .refine((qs) => qs.filter((q) => q.type === "phone").length <= 1, "Only one phone question per page");

/** POST /booking-pages. PATCH takes patchOf(BookingPageInput). */
export const BookingPageInput = z.object({
  title: requiredText(200),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .refine(isValidBookingSlug, "3–60 lowercase letters, digits and single dashes (and not a reserved word)"),
  description: text(2000).default(""),
  durationMinutes: z.number().int().min(5).max(720).default(30),
  assignment: z.enum(BOOKING_ASSIGNMENTS).default("single"),
  /** Members who take these meetings; round robin goes through them in this order. */
  hostUserIds: z.array(uuid).min(1, "Choose at least one host").max(20),
  availability: BookingAvailability,
  bufferBeforeMinutes: z.number().int().min(0).max(240).default(0),
  bufferAfterMinutes: z.number().int().min(0).max(240).default(0),
  minNoticeMinutes: z.number().int().min(0).max(60 * 24 * 30).default(240),
  maxDaysAhead: z.number().int().min(1).max(365).default(30),
  slotStepMinutes: z.number().int().min(5).max(240).default(30),
  locationType: z.enum(BOOKING_LOCATION_TYPES).default("google_meet"),
  /** The address, phone number or link (phone / in_person / custom). */
  locationDetail: text(500).default(""),
  questions: questions.default([]),
  confirmationMessage: text(2000).default(""),
  active: z.boolean().default(true),
});
export type BookingPageInputT = z.infer<typeof BookingPageInput>;

/** PUT /calendar/connections/:id — which calendar booked meetings go to, and which ones block slots. */
export const CalendarSettingsInput = z.object({
  calendarId: z.string().trim().min(1).max(500),
  busyCalendarIds: z.array(z.string().trim().min(1).max(500)).max(25),
});

/** GET /public/booking/:slug/slots */
export const BookingSlotsQuery = z.object({
  from: isoDate,
  to: isoDate,
  /** The visitor's zone: slots are grouped into the visitor's days. */
  timezone: z.string().trim().max(64).refine(isValidTimeZone, "Unknown time zone").default("UTC"),
});

/** POST /public/booking/:slug/book */
export const BookInput = z.object({
  name: requiredText(200),
  email,
  phone: text(40).optional(),
  timezone: z.string().trim().max(64).refine(isValidTimeZone, "Unknown time zone"),
  start: isoDate,
  /** Question id → answer. */
  answers: z.record(z.string().max(40), z.union([z.string().max(2000), z.boolean()])).default({}),
  /** The consent question was ticked. */
  consent: z.boolean().optional(),
});
export type BookInputT = z.infer<typeof BookInput>;

export const BookingCancelInput = z.object({ reason: text(1000).default("") });
export const BookingRescheduleInput = z.object({ start: isoDate });

// ─── Slots ───────────────────────────────────────────────────────────────────

/** A busy stretch, in epoch milliseconds, [start, end). */
export type BusyInterval = { start: number; end: number };

export type SlotRules = {
  availability: BookingAvailabilityT;
  durationMinutes: number;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  minNoticeMinutes: number;
  maxDaysAhead: number;
  slotStepMinutes: number;
};

const MIN = 60_000;
const DAY = 86_400_000;
/** Never more than this many slots from one call (a year of 5-minute steps would be absurd to send). */
export const MAX_SLOTS = 5000;

/** A booking page row's `availability` JSON, read defensively (an empty or broken value means no hours). */
export function readAvailability(raw: unknown): BookingAvailabilityT {
  const parsed = BookingAvailability.safeParse(raw);
  if (parsed.success) return parsed.data;
  const tz = (raw as { timezone?: unknown } | null)?.timezone;
  return { timezone: typeof tz === "string" && isValidTimeZone(tz) ? tz : "UTC", hours: [] };
}

/** A page row's `questions` JSON, keeping only well-formed entries. */
export function readQuestions(raw: unknown): BookingQuestionT[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((q) => {
    const parsed = BookingQuestion.safeParse(q);
    return parsed.success ? [parsed.data] : [];
  });
}

/** True when [start, end) overlaps any busy interval. */
export const overlapsBusy = (start: number, end: number, busy: readonly BusyInterval[]) => busy.some((b) => b.start < end && b.end > start);

/** Sorts and merges overlapping or touching busy intervals (fewer comparisons per slot). */
export function mergeBusy(busy: readonly BusyInterval[]): BusyInterval[] {
  const sorted = busy.filter((b) => Number.isFinite(b.start) && Number.isFinite(b.end) && b.end > b.start).sort((a, b) => a.start - b.start);
  const out: BusyInterval[] = [];
  for (const b of sorted) {
    const last = out.at(-1);
    if (last && b.start <= last.end) last.end = Math.max(last.end, b.end);
    else out.push({ ...b });
  }
  return out;
}

/** The earliest and latest start a page accepts right now: min notice from now, max days ahead of now. */
export function bookingWindow(rules: Pick<SlotRules, "minNoticeMinutes" | "maxDaysAhead">, now: Date): { earliest: number; latest: number } {
  return { earliest: now.getTime() + rules.minNoticeMinutes * MIN, latest: now.getTime() + rules.maxDaysAhead * DAY };
}

/**
 * Every start time in [from, to) a page offers, given the host's busy times.
 *
 * Each weekly window (in the page's zone) is cut into steps of
 * `slotStepMinutes` from its opening; a slot needs the whole meeting inside
 * the window, and the meeting plus its buffers (before and after) clear of
 * every busy interval. Slots before `now + minNotice` or after
 * `now + maxDaysAhead` are left out. Steps are counted in real minutes from
 * the window's opening, so the night a clock changes does not shift them.
 */
export function computeSlots(rules: SlotRules, range: { from: Date; to: Date }, busy: readonly BusyInterval[], now: Date = new Date()): Date[] {
  const { availability } = rules;
  const tz = isValidTimeZone(availability.timezone) ? availability.timezone : "UTC";
  const duration = Math.max(1, rules.durationMinutes) * MIN;
  const step = Math.max(5, rules.slotStepMinutes) * MIN;
  const before = Math.max(0, rules.bufferBeforeMinutes) * MIN;
  const after = Math.max(0, rules.bufferAfterMinutes) * MIN;
  const { earliest, latest } = bookingWindow(rules, now);
  const lo = Math.max(range.from.getTime(), earliest);
  const hi = Math.min(range.to.getTime(), latest + 1);
  if (hi <= lo || !availability.hours.length) return [];
  const merged = mergeBusy(busy);

  const out: Date[] = [];
  // Walk local days from the day before `lo` (a window can start the evening before in another zone) until past `hi`.
  let p = zonedParts(new Date(lo - DAY), tz);
  for (let guard = 0; guard < 400; guard++) {
    const dayStart = zonedTime(p.year, p.month, p.day, 0, 0, tz).getTime();
    if (dayStart >= hi) break;
    const weekday = new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
    const windows = availability.hours
      .filter((h) => h.day === weekday)
      .map((h) => ({ open: localInstant(p, h.from, tz), close: localInstant(p, h.to, tz) }))
      .sort((a, b) => a.open - b.open);
    for (const w of windows) {
      for (let t = w.open; t + duration <= w.close; t += step) {
        if (t < lo || t >= hi) continue;
        if (overlapsBusy(t - before, t + duration + after, merged)) continue;
        if (out.length && out.at(-1)!.getTime() >= t) continue; // overlapping windows on one day
        out.push(new Date(t));
        if (out.length >= MAX_SLOTS) return out;
      }
    }
    const next = new Date(Date.UTC(p.year, p.month - 1, p.day + 1));
    p = { ...p, year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() };
  }
  return out;
}

/** The instant a local "HH:MM" (or "24:00", the end of the day) falls on, on the local date `p`, in `tz`. */
function localInstant(p: { year: number; month: number; day: number }, hhmm: string, tz: string): number {
  const m = minutesOf(hhmm);
  if (m >= 24 * 60) {
    const next = new Date(Date.UTC(p.year, p.month - 1, p.day + 1));
    return zonedTime(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), 0, 0, tz).getTime();
  }
  return zonedTime(p.year, p.month, p.day, Math.floor(m / 60), m % 60, tz).getTime();
}

/** Whether one start time is offered: the same rules as computeSlots, for re-checking a booking. */
export function isSlotAvailable(rules: SlotRules, start: Date, busy: readonly BusyInterval[], now: Date = new Date()): boolean {
  const t = start.getTime();
  if (!Number.isFinite(t)) return false;
  return computeSlots(rules, { from: new Date(t), to: new Date(t + 1) }, busy, now).some((s) => s.getTime() === t);
}

/**
 * Slots a set of hosts can take: the union of each host's free slots, with
 * the hosts free at each one (for round robin). `busyByHost` holds each
 * host's busy intervals (calendar free/busy plus their Growthdesk meetings).
 */
export function hostSlots(rules: SlotRules, range: { from: Date; to: Date }, busyByHost: ReadonlyMap<string, readonly BusyInterval[]>, now: Date = new Date()): Map<number, string[]> {
  const out = new Map<number, string[]>();
  for (const [hostId, busy] of busyByHost) {
    for (const s of computeSlots(rules, range, busy, now)) out.set(s.getTime(), [...(out.get(s.getTime()) ?? []), hostId]);
  }
  return new Map([...out.entries()].sort((a, b) => a[0] - b[0]));
}

/**
 * Round robin: the next host in page order, starting at `cursor`, who is
 * free (`free` holds the ids free at the chosen slot). Returns the host and
 * the cursor to store (one past the chosen host), or null when nobody is
 * free. A single-host page always answers its one host.
 */
export function pickHost(hostIds: readonly string[], cursor: number, free: readonly string[]): { hostId: string; nextCursor: number } | null {
  if (!hostIds.length) return null;
  const n = hostIds.length;
  const startAt = ((Math.floor(cursor) % n) + n) % n;
  for (let i = 0; i < n; i++) {
    const idx = (startAt + i) % n;
    const id = hostIds[idx]!;
    if (free.includes(id)) return { hostId: id, nextCursor: (idx + 1) % n };
  }
  return null;
}

/** Slots grouped by the visitor's local date ("YYYY-MM-DD"), in order. */
export function groupSlotsByDay(slots: readonly Date[], timezone: string): { date: string; slots: string[] }[] {
  const tz = isValidTimeZone(timezone) ? timezone : "UTC";
  const days = new Map<string, string[]>();
  for (const s of slots) {
    const k = localDay(s, tz);
    days.set(k, [...(days.get(k) ?? []), s.toISOString()]);
  }
  return [...days.entries()].map(([date, list]) => ({ date, slots: list }));
}

// ─── API shapes ──────────────────────────────────────────────────────────────

/** GET /public/booking/:slug */
export type PublicBookingPage = {
  slug: string;
  title: string;
  description: string;
  durationMinutes: number;
  locationType: BookingLocationType;
  /** Only for in-person and custom locations (a phone number is not published). */
  locationDetail: string;
  questions: BookingQuestionT[];
  timezone: string;
  maxDaysAhead: number;
  workspaceName: string;
  /** The host's name (single) or "" (round robin: whoever is free). */
  hostName: string;
};

/** GET /public/booking/:slug/slots */
export type PublicBookingSlots = { timezone: string; days: { date: string; slots: string[] }[] };

/** POST /public/booking/:slug/book, and the manage endpoints. */
export type PublicBooking = {
  id: string;
  title: string;
  startsAt: string;
  endsAt: string | null;
  timezone: string;
  status: "scheduled" | "canceled" | "completed" | "no_show";
  attendeeName: string;
  attendeeEmail: string;
  hostName: string;
  location: string;
  conferenceUrl: string;
  confirmationMessage: string;
  /** /book/manage/<token> path (cancel / reschedule). */
  manageToken: string;
  /** The page, for rescheduling (null when the page was deleted or switched off). */
  page: { slug: string; durationMinutes: number; maxDaysAhead: number } | null;
  canceledAt: string | null;
  cancelReason: string;
};
