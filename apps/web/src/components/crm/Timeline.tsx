"use client";

import {
  Activity,
  AlarmClock,
  BadgeCheck,
  Ban,
  BellOff,
  BellRing,
  Building2,
  CalendarDays,
  CheckSquare,
  GitMerge,
  Handshake,
  History,
  Inbox,
  ListOrdered,
  Mail,
  MailX,
  MessageCircle,
  MessageSquare,
  MousePointerClick,
  Phone,
  Reply,
  Send,
  ShieldCheck,
  SquareCheckBig,
  StickyNote,
  UserCheck,
  UserPen,
  UserPlus,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import { Card, CardHeader } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { IconBadge, type Tint } from "@/components/ui/IconTile";
import { SkeletonText } from "@/components/ui/Skeleton";
import { useFormat } from "@/lib/session";
import type { ActivityEntry } from "@/lib/types/crm";

type Mark = { icon: LucideIcon; tint: Tint };

/*
 * Each event's marker: a glyph for what happened, tinted in the colour of the
 * thing it happened to (calls green, meetings red, notes yellow — see ENTITY
 * in components/ui/icons), so a long log can be scanned by colour.
 */
const EXACT: Record<string, Mark> = {
  "email.sent": { icon: Mail, tint: "blue" },
  "email.received": { icon: Inbox, tint: "cyan" },
  "reply.received": { icon: Reply, tint: "cyan" },
  "email.bounced": { icon: MailX, tint: "orange" },
  "message.bounced": { icon: MailX, tint: "orange" },
  "email.clicked": { icon: MousePointerClick, tint: "purple" },
  "contact.created": { icon: UserPlus, tint: "indigo" },
  "contact.updated": { icon: UserPen, tint: "indigo" },
  "contact.assigned": { icon: UserCheck, tint: "indigo" },
  "contact.qualified": { icon: BadgeCheck, tint: "green" },
  "contact.merged": { icon: GitMerge, tint: "yellow" },
  "contact.unsubscribed": { icon: BellOff, tint: "gray" },
  "contact.suppressed": { icon: Ban, tint: "red" },
  "contact.consent": { icon: ShieldCheck, tint: "gray" },
  "note.added": { icon: StickyNote, tint: "yellow" },
  "task.completed": { icon: SquareCheckBig, tint: "green" },
  "task.overdue": { icon: AlarmClock, tint: "red" },
  "task.reminder": { icon: BellRing, tint: "orange" },
  "workflow.failed": { icon: Workflow, tint: "red" },
};

const PREFIX: [string, Mark][] = [
  ["email", { icon: Mail, tint: "blue" }],
  ["message", { icon: MessageSquare, tint: "green" }],
  ["conversation", { icon: MessageSquare, tint: "green" }],
  ["telegram", { icon: MessageCircle, tint: "green" }],
  ["call", { icon: Phone, tint: "teal" }],
  ["deal", { icon: Handshake, tint: "green" }],
  ["meeting", { icon: CalendarDays, tint: "red" }],
  ["task", { icon: CheckSquare, tint: "orange" }],
  ["campaign", { icon: Send, tint: "blue" }],
  ["enrollment", { icon: ListOrdered, tint: "purple" }],
  ["sequence", { icon: ListOrdered, tint: "purple" }],
  ["workflow", { icon: Workflow, tint: "purple" }],
  ["company", { icon: Building2, tint: "teal" }],
  ["contact", { icon: UserPen, tint: "indigo" }],
];

const markFor = (type: string): Mark =>
  EXACT[type] ??
  PREFIX.find(([p]) => type.startsWith(p))?.[1] ?? {
    icon: Activity,
    tint: "gray",
  };

/** The activity log of a record, newest first, as the API writes it next to each change. */
export function Timeline({ entries, loading, limitNote }: { entries: ActivityEntry[] | undefined; loading?: boolean; limitNote?: string }) {
  const f = useFormat();
  return (
    <Card>
      <CardHeader icon={<History />} title="Activity" description={limitNote} />
      {loading && !entries ? (
        <div className="p-4">
          <SkeletonText lines={4} />
        </div>
      ) : !entries?.length ? (
        <EmptyState compact icon={<Activity />} title="No activity yet" description="Emails, calls, meetings and changes show up here as they happen." />
      ) : (
        <ol className="flex flex-col px-4 py-4">
          {entries.map((e, i) => {
            const { icon: Icon, tint } = markFor(e.type);
            return (
              <li key={e.id} className="relative flex gap-3 pb-4 last:pb-0">
                {/* The rail between markers: centred under the 28px badge, with a small gap either side. */}
                {i < entries.length - 1 && <span aria-hidden className="absolute top-8 bottom-1 left-[13.5px] w-px bg-line" />}
                <IconBadge icon={<Icon />} tint={tint} />
                <div className="min-w-0 flex-1 pt-[3px]">
                  <p className="text-sm break-words text-text">{e.summary}</p>
                  <p className="mt-0.5 text-xs text-text-3">
                    {e.actor?.name ? `${e.actor.name} · ` : ""}
                    <time dateTime={e.occurredAt} title={f.dateTime(e.occurredAt)}>
                      {f.relative(e.occurredAt)}
                    </time>
                  </p>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </Card>
  );
}
