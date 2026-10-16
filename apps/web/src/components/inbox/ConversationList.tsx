"use client";

import { AlarmClock, Inbox as InboxIcon, ListTree, Megaphone, PenSquare, Rows2, Rows3 } from "lucide-react";
import { labelOf } from "@growthdesk/shared";
import { Segmented } from "@/components/pipeline/controls";
import { Avatar } from "@/components/ui/Avatar";
import { Button, IconButton } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { ChannelTile, EntityTile } from "@/components/ui/icons";
import { ErrorState } from "@/components/ui/ErrorState";
import { AiCategoryBadge } from "@/components/ai/AiCategoryBadge";
import { TagList } from "@/components/crm/Tags";
import { Pagination } from "@/components/ui/Pagination";
import { SearchInput } from "@/components/ui/SearchInput";
import { SkeletonText } from "@/components/ui/Skeleton";
import { cn } from "@/lib/cn";
import { useApiQuery } from "@/lib/query";
import { useFormat, useWorkspace } from "@/lib/session";
import type { Paged } from "@/lib/types";
import type { ConversationRow, InboxChannel } from "@/lib/types/inbox";
import { ActiveFilterChips, FiltersPopover } from "./ListFilters";
import { isBoolean, useStoredState } from "./useStoredState";
import { conversationTitle, isSnoozed } from "./utils";

export type InboxFilters = {
  status: "open" | "snoozed" | "closed";
  assignee: "all" | "me" | "none";
  channel: "" | InboxChannel;
  unread: boolean;
  /** "" (any), "any" (every campaign reply) or a campaign id. */
  campaign: string;
  /** "" (any), "none" (untagged) or a tag id. */
  tag: string;
  /** A live-chat widget's id. */
  widget: string;
  /** "" (any) or an AI reply label (Conversation.aiCategory). */
  label: string;
  q: string;
  page: number;
};

export const PAGE_SIZE = 50;

const EMPTY: Record<InboxFilters["status"], { title: string; description: string }> = {
  open: {
    title: "Nothing waiting",
    description: "Replies to your emails and campaigns, WhatsApp and Telegram messages, and website live chats land here.",
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

/**
 * The conversation list: search and status on top, then the conversations
 * (newest activity first). Channel, AI label, assignee and unread are in the
 * Filters popover; campaigns, tags and widgets in the rail (InboxRail), which
 * below `lg` opens in a drawer. Active filters show as clearable chips. Rows
 * can be compact (one line each). Kept fresh by the live stream, with a slow
 * poll as the fallback.
 */
export function ConversationList({
  filters,
  onFilters,
  selectedId,
  onSelect,
  onCompose,
  onOpenFilters,
  activeFilters,
}: {
  filters: InboxFilters;
  onFilters: (patch: Partial<InboxFilters>) => void;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onCompose?: () => void;
  onOpenFilters?: () => void;
  /** How many rail filters are on (shown on the Filters button and as "Clear"). */
  activeFilters: number;
}) {
  const ws = useWorkspace();
  const query = {
    status: filters.status,
    assignee: filters.assignee === "all" ? undefined : filters.assignee,
    channel: filters.channel || undefined,
    unread: filters.unread ? "true" : undefined,
    campaignId: filters.campaign || undefined,
    tag: filters.tag || undefined,
    integrationId: filters.widget || undefined,
    aiCategory: filters.label || undefined,
    q: filters.q || undefined,
    page: filters.page,
    pageSize: PAGE_SIZE,
  };
  const list = useApiQuery<Paged<ConversationRow>>(ws.key("inbox", "list"), ws.path("/inbox/conversations"), {
    query,
    keepPrevious: true,
    refetchInterval: 120_000,
  });
  const filtered = activeFilters > 0 || filters.q !== "";
  // One-line rows, remembered in this browser.
  const [compact, setCompact] = useStoredState("gd.inbox.compact", false, isBoolean);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-col gap-2.5 border-b border-line px-3 pt-3 pb-3">
        <div className="flex items-center justify-between gap-2">
          <h1 className="flex items-center gap-2.5 text-lg font-semibold tracking-[-0.015em] text-text-hi">
            <EntityTile of="inbox" size="md" />
            Inbox
          </h1>
          <div className="flex shrink-0 items-center gap-1">
            <IconButton
              size="sm"
              label="Compact rows"
              aria-pressed={compact}
              icon={compact ? <Rows3 /> : <Rows2 />}
              className={cn(compact && "bg-s-3 text-text-hi")}
              onClick={() => setCompact(!compact)}
            />
            {onCompose && (
              <Button size="sm" variant="primary" icon={<PenSquare />} onClick={onCompose}>
                New message
              </Button>
            )}
          </div>
        </div>
        <SearchInput value={filters.q} onChange={(q) => onFilters({ q, page: 1 })} size="sm" placeholder="Search name, address, subject…" />
        <div className="flex items-center gap-1.5">
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
          <span className="flex-1" />
          <FiltersPopover filters={filters} onFilters={onFilters} />
          {onOpenFilters && (
            <IconButton size="sm" variant="secondary" label="Campaigns, tags and channels" icon={<ListTree />} onClick={onOpenFilters} className="lg:hidden" />
          )}
        </div>
        <ActiveFilterChips filters={filters} onFilters={onFilters} />
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
              <ConversationItem key={c.id} c={c} active={c.id === selectedId} compact={compact} onSelect={() => onSelect(c.id)} />
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

function ConversationItem({ c, active, compact, onSelect }: { c: ConversationRow; active: boolean; compact: boolean; onSelect: () => void }) {
  const f = useFormat();
  const title = conversationTitle(c);
  const snoozed = isSnoozed(c);
  const preview = c.preview ? `${c.preview.direction === "outbound" ? "You: " : ""}${c.preview.text}` : "No messages yet";
  if (compact) {
    return (
      <li>
        <button
          type="button"
          onClick={onSelect}
          aria-current={active ? "true" : undefined}
          title={[title, c.subject, preview].filter(Boolean).join(" — ")}
          className={cn("flex h-9 w-full items-center gap-2 px-3 text-left transition-colors", active ? "bg-sidebar-accent" : "hover:bg-hover")}
        >
          <span className="flex w-2 shrink-0 justify-center">{c.unread && <span className="size-2 rounded-full bg-accent" aria-label="Unread" role="img" />}</span>
          <ChannelTile channel={c.channel} size="sm" />
          <span className={cn("w-[34%] max-w-40 shrink-0 truncate text-sm", c.unread ? "font-semibold text-text-hi" : "text-text")}>{title}</span>
          <span className="min-w-0 flex-1 truncate text-xs text-text-3">{c.channel === "email" && c.subject ? `${c.subject} — ${preview}` : preview}</span>
          {snoozed && <AlarmClock aria-label="Snoozed" className="size-3 shrink-0 text-warn-ink" />}
          <span className="shrink-0 text-2xs text-text-3 tabular-nums" title={c.lastMessageAt ? f.dateTime(c.lastMessageAt) : undefined}>
            {c.lastMessageAt ? f.relative(c.lastMessageAt) : ""}
          </span>
        </button>
      </li>
    );
  }
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
          {(c.channel === "email" || c.channel === "web") && c.subject && <span className={cn("block truncate text-xs", c.unread ? "text-text" : "text-text-2")}>{c.subject}</span>}
          <span className="block truncate text-xs text-text-3">{preview}</span>
          <span className="mt-1 flex items-center gap-2 text-2xs text-text-3">
            <span>{labelOf(c.channel)}</span>
            {c.campaignId && (
              <span className="inline-flex items-center" title="Campaign reply">
                <Megaphone aria-label="Campaign reply" className="size-3" />
              </span>
            )}
            {c.tags.length > 0 && <TagList tags={c.tags} max={2} className="min-w-0" />}
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
