"use client";

import type { ReactNode } from "react";
import { AlarmClock, ChevronRight, Clock, Mail, Reply, Sparkles, User } from "lucide-react";
import type { AiReplyCategory } from "@growthdesk/shared";
import { AiCategoryBadge } from "@/components/ai/AiCategoryBadge";
import { Avatar } from "@/components/ui/Avatar";
import { Card, CardHeader } from "@/components/ui/Card";
import { ErrorState } from "@/components/ui/ErrorState";
import { ChannelTile, EntityTile } from "@/components/ui/icons";
import { IconBadge, type Tint } from "@/components/ui/IconTile";
import { Skeleton, SkeletonText } from "@/components/ui/Skeleton";
import { cn } from "@/lib/cn";
import { useApiQuery } from "@/lib/query";
import { useFormat, useWorkspace } from "@/lib/session";
import type { InboxSummary } from "@/lib/types/inbox";
import type { InboxFilters } from "./ConversationList";
import { labelName } from "./ListFilters";
import { conversationTitle } from "./utils";

/** Label colours, matching AiCategoryBadge's tones. */
const LABEL_TINT: Partial<Record<AiReplyCategory, Tint>> = {
  interested: "green",
  meeting_request: "teal",
  question: "blue",
  referral: "indigo",
  not_interested: "red",
  unsubscribe: "red",
  not_now: "orange",
  out_of_office: "gray",
  wrong_person: "gray",
};

/**
 * "Inbox today" — what the detail pane shows while no conversation is open:
 * the day's numbers (each one a filter), the five conversations that have
 * waited longest for a reply, and the open conversations per AI label.
 * GET /inbox/summary; refreshed by the live stream with the rest of the inbox.
 */
export function InboxToday({ onFilters, onSelect }: { onFilters: (patch: Partial<InboxFilters>) => void; onSelect: (id: string) => void }) {
  const ws = useWorkspace();
  const f = useFormat();
  const summary = useApiQuery<InboxSummary>(ws.key("inbox", "summary"), ws.path("/inbox/summary"), { refetchInterval: 120_000 });
  const s = summary.data;
  const reset: Partial<InboxFilters> = { assignee: "all", channel: "", unread: false, campaign: "", tag: "", widget: "", label: "", q: "", page: 1 };
  const show = (patch: Partial<InboxFilters>) => onFilters({ ...reset, status: "open", ...patch });

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-6 lg:px-6">
        <div className="flex items-center gap-3">
          <EntityTile of="inbox" size="lg" />
          <div className="min-w-0">
            <h2 className="text-lg font-semibold tracking-[-0.015em] text-text-hi">Inbox today</h2>
            <p className="text-xs text-text-3">{f.date(new Date().toISOString())} · pick a conversation on the left, or start with what needs you.</p>
          </div>
        </div>

        {summary.isError && !s ? (
          <ErrorState compact error={summary.error} onRetry={() => void summary.refetch()} />
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
              <Figure label="Unread" value={s?.unread} icon={<Mail />} tint="blue" onClick={() => show({ unread: true })} />
              <Figure label="Needs a reply" value={s?.needsReply} icon={<Reply />} tint="orange" hint="They wrote last" warn={Boolean(s?.needsReply)} />
              <Figure label="Back today" value={s?.snoozedToday} icon={<AlarmClock />} tint="yellow" hint="Snoozed until today" onClick={() => show({ status: "snoozed" })} />
              <Figure label="Assigned to me" value={s?.mine} icon={<User />} tint="purple" onClick={() => show({ assignee: "me" })} />
            </div>

            <Card>
              <CardHeader icon={<Clock />} title="Needs a reply" description="The longest-waiting conversations where the contact wrote last." className="py-2.5" />
              {!s ? (
                <SkeletonText lines={4} className="p-4" />
              ) : !s.oldest.length ? (
                <p className="px-4 py-6 text-center text-xs text-text-3">All caught up — nobody is waiting on a reply.</p>
              ) : (
                <ul className="divide-y divide-line">
                  {s.oldest.map((c) => (
                    <li key={c.id}>
                      <button type="button" onClick={() => onSelect(c.id)} className="flex w-full items-center gap-2.5 px-4 py-2.5 text-left hover:bg-hover">
                        <ChannelTile channel={c.channel} size="md" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium text-text-hi">{conversationTitle(c)}</span>
                          <span className="block truncate text-xs text-text-3">{c.subject || c.handle}</span>
                        </span>
                        <AiCategoryBadge category={c.aiCategory} className="hidden sm:inline-flex" />
                        {c.assignee && <Avatar size="xs" name={c.assignee.name} email={c.assignee.email} />}
                        <span className="w-20 shrink-0 text-right text-xs text-warn-ink tabular-nums" title={f.dateTime(c.lastInboundAt)}>
                          {f.relative(c.lastInboundAt)}
                        </span>
                        <ChevronRight aria-hidden className="size-3.5 shrink-0 text-text-3" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {s && s.needsReply > s.oldest.length && (
                <p className="border-t border-line px-4 py-2 text-xs text-text-3">and {s.needsReply - s.oldest.length} more waiting.</p>
              )}
            </Card>

            <Card>
              <CardHeader icon={<Sparkles />} title="By AI label" description="Open conversations, as the AI read the latest reply. Pick one to filter the list." className="py-2.5" />
              {!s ? (
                <SkeletonText lines={2} className="p-4" />
              ) : !s.labels.length ? (
                <p className="px-4 py-6 text-center text-xs text-text-3">No labelled conversations open. Replies get a label once the AI has read them.</p>
              ) : (
                <div className="grid grid-cols-2 gap-2 p-3 sm:grid-cols-3">
                  {s.labels.map((l) => (
                    <button
                      key={l.category}
                      type="button"
                      onClick={() => show({ label: l.category })}
                      className="flex min-w-0 items-center gap-2.5 rounded-lg border border-line bg-panel px-3 py-2.5 text-left transition-colors hover:border-line-strong hover:bg-hover"
                    >
                      <IconBadge icon={<Sparkles />} tint={LABEL_TINT[l.category as AiReplyCategory] ?? "gray"} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm text-text">{labelName(l.category)}</span>
                        <span className="block text-xs text-text-3 tabular-nums">{l.count === 1 ? "1 conversation" : `${l.count} conversations`}</span>
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </Card>
          </>
        )}
      </div>
    </div>
  );
}

function Figure({
  label,
  value,
  icon,
  tint,
  hint,
  warn,
  onClick,
}: {
  label: string;
  value: number | undefined;
  icon: ReactNode;
  tint: Tint;
  hint?: string;
  warn?: boolean;
  onClick?: () => void;
}) {
  const body = (
    <>
      <span className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-text-3">{label}</span>
        <IconBadge icon={icon} tint={tint} className="-my-1" />
      </span>
      {value === undefined ? (
        <Skeleton className="mt-2 h-7 w-12" />
      ) : (
        <span className={cn("mt-1.5 block text-2xl font-semibold tracking-[-0.025em] tabular-nums", warn ? "text-warn-ink" : "text-text-hi")}>{value}</span>
      )}
      {hint && <span className="mt-0.5 block text-xs text-text-3">{hint}</span>}
    </>
  );
  const cls = "block min-w-0 rounded-xl border border-line bg-panel px-4 py-3.5 text-left shadow-card";
  return onClick ? (
    <button type="button" onClick={onClick} className={cn(cls, "transition-[border-color,box-shadow] hover:border-line-strong hover:shadow-md")}>
      {body}
    </button>
  ) : (
    <div className={cls}>{body}</div>
  );
}
