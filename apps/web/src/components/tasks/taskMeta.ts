import { CalendarDays, CircleCheck, FileText, Mail, MessageSquareReply, Phone, Repeat, UserRoundSearch, type LucideIcon } from "lucide-react";
import type { Tint } from "@/components/ui/IconTile";
import { dayKey, zonedInputToUtc, zonedParts } from "@/lib/format";
import type { TaskRow } from "@/lib/types/pipeline";

/** A glyph per task type, so a row or card says "call" or "email" at a glance. */
export const TYPE_ICON: Record<string, LucideIcon> = {
  email: Mail,
  follow_up: Repeat,
  call: Phone,
  meeting: CalendarDays,
  proposal: FileText,
  review_reply: MessageSquareReply,
  qualify: UserRoundSearch,
  custom: CircleCheck,
};

export const PRIORITY_TINT: Record<string, Tint> = { urgent: "red", high: "orange", medium: "blue", low: "gray" };

// ─── Tasks page layout preferences (URL first, then this browser's last choice) ───

export const TASK_LAYOUTS = ["list", "board"] as const;
export type TaskLayout = (typeof TASK_LAYOUTS)[number];
export const TASK_GROUPS = ["due", "assignee", "priority", "type"] as const;
export type TaskGroupBy = (typeof TASK_GROUPS)[number];
export const isTaskGroupBy = (v: string | null | undefined): v is TaskGroupBy => (TASK_GROUPS as readonly string[]).includes(v ?? "");

export const LAYOUT_PREF = "growthdesk.tasks.layout";
export const GROUP_PREF = "growthdesk.tasks.groupBy";

/** localStorage can be missing or throw (private mode, blocked storage): a preference is only ever a convenience. */
export function readPref(key: string): string | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writePref(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Not remembered; the URL still carries the choice.
  }
}

// ─── Due-date buckets, in the workspace time zone ────────────────────────────

export const DUE_BUCKETS = ["overdue", "today", "tomorrow", "week", "later", "none", "done"] as const;
export type DueBucket = (typeof DUE_BUCKETS)[number];

/** "2026-10-16" + n calendar days. */
export function addDays(key: string, n: number): string {
  const [y, m, d] = key.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** 0 = Sunday … 6 = Saturday, for a calendar day. */
const weekdayOf = (key: string) => new Date(`${key}T00:00:00Z`).getUTCDay();

const startOfDay = (key: string, tz: string) => Date.parse(zonedInputToUtc(key, tz) ?? key);

export type DueCalendar = ReturnType<typeof dueCalendar>;

/** The day boundaries the board sorts by: today, tomorrow, the rest of this week (to Sunday), later. */
export function dueCalendar(tz: string, now = new Date()) {
  const today = dayKey(now, tz);
  const dow = weekdayOf(today);
  const toNextMonday = (8 - dow) % 7 || 7;
  return {
    tz,
    now: now.getTime(),
    today,
    dow,
    tomorrowStart: startOfDay(addDays(today, 1), tz),
    dayAfterStart: startOfDay(addDays(today, 2), tz),
    nextWeekStart: startOfDay(addDays(today, toNextMonday), tz),
  };
}

/** Which due-date column a task sits in; null hides it (canceled, or completed before today). */
export function dueBucketOf(t: Pick<TaskRow, "status" | "dueAt" | "completedAt">, cal: DueCalendar): DueBucket | null {
  if (t.status === "canceled") return null;
  if (t.status === "done") return t.completedAt && dayKey(t.completedAt, cal.tz) === cal.today ? "done" : null;
  if (!t.dueAt) return "none";
  const due = Date.parse(t.dueAt);
  if (due < cal.now) return "overdue";
  if (due < cal.tomorrowStart) return "today";
  if (due < cal.dayAfterStart) return "tomorrow";
  if (due < cal.nextWeekStart) return "week";
  return "later";
}

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * The new due instant for a task dropped on a date column (an ISO string, or
 * null for "No date"); undefined when the column takes no due date (Overdue,
 * Done today). Keeps the task's time of day, or 17:00 when it has none; a
 * time that has already passed today moves to 17:00, then 23:59.
 */
export function dueForBucket(bucket: DueBucket, t: Pick<TaskRow, "dueAt">, cal: DueCalendar): string | null | undefined {
  const at = (key: string, hhmm: string) => zonedInputToUtc(`${key}T${hhmm}`, cal.tz)!;
  const notPast = (key: string, hhmm: string) => {
    for (const time of [hhmm, "17:00", "23:59"]) {
      const iso = at(key, time);
      if (Date.parse(iso) > cal.now) return iso;
    }
    return at(key, "23:59");
  };
  const p = t.dueAt ? zonedParts(new Date(t.dueAt), cal.tz) : null;
  const time = p ? `${pad(p.hour)}:${pad(p.minute)}` : "17:00";
  switch (bucket) {
    case "today":
      return notPast(cal.today, time);
    case "tomorrow":
      return at(addDays(cal.today, 1), time);
    case "week": {
      // Friday 17:00 from Monday to Thursday; from Friday on, Sunday 17:00.
      const offset = cal.dow >= 1 && cal.dow <= 4 ? 5 - cal.dow : (7 - cal.dow) % 7;
      return notPast(addDays(cal.today, offset), "17:00");
    }
    case "later":
      return at(addDays(cal.today, 7), time);
    case "none":
      return null;
    default:
      return undefined;
  }
}
