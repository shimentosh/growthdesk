import { labelOf } from "@growthdesk/shared";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/*
 * Status chips. A word on an 8% wash of its hue, no border.
 *
 *   ok    green   done, healthy, won
 *   live  blue    running right now, on its own
 *   warn  amber   paused, waiting on someone, needs a decision
 *   bad   red     failed, refused, lost
 *   info  purple  new, draft, a fresh state worth noticing
 *   mute  grey    everything else
 */

export type Tone = "ok" | "live" | "warn" | "bad" | "info" | "mute";

const TONES: Record<Tone, { chip: string; dot: string }> = {
  ok: { chip: "bg-ok-chip text-ok-ink", dot: "bg-ok" },
  live: { chip: "bg-live-chip text-accent-ink", dot: "bg-accent" },
  warn: { chip: "bg-warn-chip text-warn-ink", dot: "bg-warn" },
  bad: { chip: "bg-bad-chip text-bad-ink", dot: "bg-bad" },
  info: { chip: "bg-alt-chip text-alt-ink", dot: "bg-alt" },
  mute: { chip: "bg-mute-chip text-text-2", dot: "bg-text-3" },
};

const QUIET: Record<Tone, string> = {
  ok: "text-ok-ink",
  live: "text-accent-ink",
  warn: "text-warn-ink",
  bad: "text-bad-ink",
  info: "text-alt-ink",
  mute: "text-text-2",
};

export type BadgeProps = {
  tone?: Tone;
  /** A leading dot (it pulses for "live"). Colour should not carry the meaning alone — the word does. */
  dot?: boolean;
  /** Outline instead of fill: for a category a row simply *is*, rather than a state. */
  quiet?: boolean;
  title?: string;
  className?: string;
  children: ReactNode;
};

export function Badge({ tone = "mute", dot, quiet, title, className, children }: BadgeProps) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex h-5 max-w-full items-center gap-1.5 rounded-xs px-2 text-2xs font-medium whitespace-nowrap",
        quiet ? cn("border border-line-strong", QUIET[tone]) : TONES[tone].chip,
        className,
      )}
    >
      {dot && <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", TONES[tone].dot, tone === "live" && "animate-pulse")} />}
      <span className="truncate">{children}</span>
    </span>
  );
}

/*
 * Enum value → tone, for every status enum in @growthdesk/shared (contact,
 * campaign, enrollment, execution, message, call, subscription, workflow run,
 * import, connection, deal, meeting, task, qualification, priority, consent).
 * Unknown values are "mute".
 */
const OK = new Set([
  "active",
  "completed",
  "succeeded",
  "delivered",
  "sent",
  "read",
  "won",
  "customer",
  "interested",
  "qualified",
  "granted",
  "done",
  "connected",
  "meeting_booked",
  "paid",
  "verified",
  "healthy",
]);
const LIVE = new Set(["running", "sending", "in_progress", "ringing", "processing", "trialing", "qualifying", "waiting", "contacted", "pending"]);
const WARN = new Set([
  "paused",
  "past_due",
  "incomplete",
  "uncertain",
  "waiting_approval",
  "callback_requested",
  "left_voicemail",
  "no_answer",
  "busy",
  "stopped",
  "high",
  "unpaid",
  "snoozed",
]);
const BAD = new Set([
  "failed",
  "bounced",
  "error",
  "lost",
  "expired",
  "disqualified",
  "not_interested",
  "do_not_contact",
  "do_not_call",
  "wrong_number",
  "denied",
  "suspended",
  "no_show",
  "urgent",
  "blocked",
  "restricted",
]);
const INFO = new Set(["new", "replied", "draft", "scheduled", "received", "invited"]);

export function statusTone(value: string | null | undefined): Tone {
  if (!value) return "mute";
  const v = value.toLowerCase();
  if (OK.has(v)) return "ok";
  if (BAD.has(v)) return "bad";
  if (WARN.has(v)) return "warn";
  if (LIVE.has(v)) return "live";
  if (INFO.has(v)) return "info";
  return "mute";
}

/** An enum value as a chip: tone from statusTone(), text from labelOf(). */
export function StatusBadge({ value, label, dot = true, className }: { value: string | null | undefined; label?: ReactNode; dot?: boolean; className?: string }) {
  if (!value) return <span className="text-text-3">—</span>;
  return (
    <Badge tone={statusTone(value)} dot={dot} className={className}>
      {label ?? labelOf(value)}
    </Badge>
  );
}
