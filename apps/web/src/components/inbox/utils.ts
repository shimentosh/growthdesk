/*
 * Small helpers the inbox components share.
 */
import { dayKey, zonedInputToUtc } from "@/lib/format";
import type { ConversationDetail, ConversationRow } from "@/lib/types/inbox";

/** Who the conversation is with, in the most human form on file. */
export function conversationTitle(
  c: Pick<ConversationRow, "displayName" | "handle"> & {
    contact: { fullName: string | null; email?: string | null } | null;
  },
): string {
  return c.contact?.fullName || c.displayName || c.handle || c.contact?.email || "Unknown sender";
}

/** True while snoozedUntil is in the future (the API's own definition of "snoozed"). */
export const isSnoozed = (c: Pick<ConversationRow, "status" | "snoozedUntil">, now = Date.now()) =>
  c.status === "open" && Boolean(c.snoozedUntil) && new Date(c.snoozedUntil as string).getTime() > now;

const weekday = (d: Date, timeZone: string) => {
  try {
    return new Intl.DateTimeFormat("en-US", {
      weekday: "short",
      timeZone,
    }).format(d);
  } catch {
    return new Intl.DateTimeFormat("en-US", {
      weekday: "short",
      timeZone: "UTC",
    }).format(d);
  }
};

/** Snooze choices as ISO instants, with wall-clock times read in the workspace zone. */
export function snoozePresets(timeZone: string, now = new Date()): { label: string; until: string }[] {
  const at9 = (d: Date) => zonedInputToUtc(`${dayKey(d, timeZone)}T09:00`, timeZone);
  const day = 86_400_000;
  const tomorrow = at9(new Date(now.getTime() + day));
  let monday: string | null = null;
  for (let i = 1; i <= 7; i++) {
    const d = new Date(now.getTime() + i * day);
    if (weekday(d, timeZone) === "Mon") {
      monday = at9(d);
      break;
    }
  }
  return [
    {
      label: "In 3 hours",
      until: new Date(now.getTime() + 3 * 3600_000).toISOString(),
    },
    ...(tomorrow ? [{ label: "Tomorrow, 9:00 AM", until: tomorrow }] : []),
    ...(monday ? [{ label: "Next Monday, 9:00 AM", until: monday }] : []),
  ];
}

/** The detail's messages and notes as one chronological thread. */
export type ThreadItem =
  | {
      kind: "message";
      at: string;
      message: ConversationDetail["messages"][number];
    }
  | { kind: "note"; at: string; note: ConversationDetail["notes"][number] };

export function threadItems(d: Pick<ConversationDetail, "messages" | "notes">): ThreadItem[] {
  const items: ThreadItem[] = [
    ...d.messages.map((m) => ({
      kind: "message" as const,
      at: m.createdAt,
      message: m,
    })),
    ...d.notes.map((n) => ({
      kind: "note" as const,
      at: n.createdAt,
      note: n,
    })),
  ];
  return items.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
}
