"use client";

import { AlarmClock, Inbox as InboxIcon, PenSquare } from "lucide-react";
import { labelOf } from "@growthdesk/shared";
import { Segmented } from "@/components/pipeline/controls";
import { Avatar } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Checkbox";
import { EmptyState } from "@/components/ui/EmptyState";
import { ChannelTile, EntityTile } from "@/components/ui/icons";
import { ErrorState } from "@/components/ui/ErrorState";
import { AiCategoryBadge } from "@/components/ai/AiCategoryBadge";
import { NativeSelect } from "@/components/ui/Input";
import { Pagination } from "@/components/ui/Pagination";
import { SearchInput } from "@/components/ui/SearchInput";
import { SkeletonText } from "@/components/ui/Skeleton";
import { cn } from "@/lib/cn";
import { useApiQuery } from "@/lib/query";
import { useFormat, useWorkspace } from "@/lib/session";
import type { Paged } from "@/lib/types";
import type { ConversationRow } from "@/lib/types/inbox";
import { conversationTitle, isSnoozed } from "./utils";

export type InboxFilters = {
  status: "open" | "snoozed" | "closed";
  assignee: "all" | "me" | "none";
  channel: "" | "email" | "whatsapp" | "telegram";
  unread: boolean;
  q: string;
  page: number;
};

export const PAGE_SIZE = 50;

const EMPTY: Record<InboxFilters["status"], { title: string; description: string }> = {
  open: {
    title: "Nothing waiting",
    description: "Replies to your emails and WhatsApp or Telegram messages land here.",
  },
  snoozed: {
    title: "Nothing snoozed",
    description: "Snoozed conversations come back to Open when their time is up, or as soon as the contact writes again.",
  },
  closed: {
    title: "No closed conversations",
    description: "Close a conversation once it needs nothing more from you.",
  },
};

/** The left pane: filters, then the conversations (newest activity first), polled every 30 seconds. */
export function ConversationList({
  filters,
  onFilters,
  selectedId,
  onSelect,
  onCompose,
}: {
  filters: InboxFilters;
  onFilters: (patch: Partial<InboxFilters>) => void;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onCompose?: () => void;
}) {
  const ws = useWorkspace();
  const query = {
    status: filters.status,
    assignee: filters.assignee === "all" ? undefined : filters.assignee,
    channel: filters.channel || undefined,
    unread: filters.unread ? "true" : undefined,
    q: filters.q || undefined,
    page: filters.page,
    pageSize: PAGE_SIZE,
  };
  const list = useApiQuery<Paged<ConversationRow>>(ws.key("inbox", "list"), ws.path("/inbox/conversations"), {
    query,
    keepPrevious: true,
    refetchInterval: 30_000,
  });
  const filtered = filters.assignee !== "all" || filters.channel !== "" || filters.unread || filters.q !== "";

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-col gap-2.5 border-b border-line px-3 pt-3 pb-3">
        <div className="flex items-center justify-between gap-2">
          <h1 className="flex items-center gap-2.5 text-lg font-semibold tracking-[-0.015em] text-text-hi">
            <EntityTile of="inbox" size="md" />
            Inbox
          </h1>
          {onCompose && (
            <Button size="sm" variant="primary" icon={<PenSquare />} onClick={onCompose}>
              New message
            </Button>
          )}
        </div>
        <SearchInput value={filters.q} onChange={(q) => onFilters({ q, page: 1 })} size="sm" placeholder="Search name, address, subject…" />
        <Segmented
          aria-label="Status"
          value={filters.status}
          onChange={(status) => onFilters({ status, page: 1 })}
          options={[
            { value: "open", label: "Open" },
            { value: "snoozed", label: "Snoozed" },
            { value: "closed", label: "Closed" },
          ]}
        />
        <div className="grid grid-cols-2 gap-2">
          <NativeSelect
            size="sm"
            aria-label="Assignee"
            value={filters.assignee}
            onChange={(e) =>
              onFilters({
                assignee: e.target.value as InboxFilters["assignee"],
                page: 1,
              })
            }
            options={[
              // Without records.view_all, "all" is what the API lets you see: yours and unassigned.
              {
                value: "all",
                label: ws.can("records.view_all") ? "Everyone" : "Mine & unassigned",
              },
              { value: "me", label: "Assigned to me" },
              { value: "none", label: "Unassigned" },
            ]}
          />
          <NativeSelect
            size="sm"
            aria-label="Channel"
            value={filters.channel}
            onChange={(e) =>
              onFilters({
                channel: e.target.value as InboxFilters["channel"],
                page: 1,
              })
            }
            options={[
              { value: "", label: "All channels" },
              { value: "email", label: "Email" },
              { value: "whatsapp", label: "WhatsApp" },
              { value: "telegram", label: "Telegram" },
            ]}
          />
        </div>
        <Checkbox checked={filters.unread} onCheckedChange={(unread) => onFilters({ unread, page: 1 })} label="Unread only" />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {list.isPending ? (
          <SkeletonText lines={8} className="p-4" />
        ) : list.isError && !list.data ? (
          <ErrorState compact error={list.error} onRetry={() => void list.refetch()} />
        ) : !list.data.items.length ? (
          <EmptyState
            compact
            icon={<InboxIcon />}
            title={filtered ? "No conversation matches" : EMPTY[filters.status].title}
            description={filtered ? "Try other filters or clear the search." : EMPTY[filters.status].description}
          />
        ) : (
          <ul aria-label="Conversations" className="divide-y divide-line">
            {list.data.items.map((c) => (
              <ConversationItem key={c.id} c={c} active={c.id === selectedId} onSelect={() => onSelect(c.id)} />
            ))}
          </ul>
        )}
      </div>

      {list.data && list.data.total > PAGE_SIZE && (
        <div className="shrink-0 border-t border-line px-3 py-2">
          <Pagination page={filters.page} pageSize={PAGE_SIZE} total={list.data.total} onPageChange={(page) => onFilters({ page })} />
        </div>
      )}
    </div>
  );
}

function ConversationItem({ c, active, onSelect }: { c: ConversationRow; active: boolean; onSelect: () => void }) {
  const f = useFormat();
  const title = conversationTitle(c);
  const snoozed = isSnoozed(c);
  const preview = c.preview ? `${c.preview.direction === "outbound" ? "You: " : ""}${c.preview.text}` : "No messages yet";
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        aria-current={active ? "true" : undefined}
        className={cn("flex w-full items-start gap-2.5 px-3 py-2.5 text-left transition-colors", active ? "bg-sidebar-accent" : "hover:bg-hover")}
      >
        <span className="flex w-2 shrink-0 justify-center pt-[7px]">{c.unread && <span className="size-2 rounded-full bg-accent" aria-label="Unread" role="img" />}</span>
        <ChannelTile channel={c.channel} size="sm" className="mt-px" />
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline justify-between gap-2">
            <span className={cn("truncate text-sm", c.unread ? "font-semibold text-text-hi" : "text-text")}>{title}</span>
            <span className="shrink-0 text-2xs text-text-3" title={c.lastMessageAt ? f.dateTime(c.lastMessageAt) : undefined}>
              {c.lastMessageAt ? f.relative(c.lastMessageAt) : ""}
            </span>
          </span>
          {c.channel === "email" && c.subject && <span className={cn("block truncate text-xs", c.unread ? "text-text" : "text-text-2")}>{c.subject}</span>}
          <span className="block truncate text-xs text-text-3">{preview}</span>
          <span className="mt-1 flex items-center gap-2 text-2xs text-text-3">
            <span>{labelOf(c.channel)}</span>
            <AiCategoryBadge category={c.aiCategory} className="h-4 px-1.5" />
            {snoozed && c.snoozedUntil && (
              <span className="inline-flex items-center gap-1 text-warn-ink">
                <AlarmClock aria-hidden className="size-3" />
                Until {f.smart(c.snoozedUntil)}
              </span>
            )}
            {c.preview?.status === "failed" || c.preview?.status === "bounced" ? <span className="text-bad-ink">{labelOf(c.preview.status)}</span> : null}
            {c.assignee && (
              <span className="ml-auto inline-flex min-w-0 items-center gap-1">
                <Avatar size="xs" name={c.assignee.name} email={c.assignee.email} />
                <span className="truncate">{c.assignee.name || c.assignee.email}</span>
              </span>
            )}
          </span>
        </span>
      </button>
    </li>
  );
}
