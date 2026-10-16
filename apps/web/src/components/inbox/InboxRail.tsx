"use client";

import { useState, type ReactNode } from "react";
import { ChevronRight, Hash, Inbox as InboxIcon, Megaphone, MessagesSquare, Settings2, Tag as TagIcon, User, UserX, Dot } from "lucide-react";
import Link from "next/link";
import { tagTone } from "@/components/imports/labels";
import { CHANNEL } from "@/components/ui/icons";
import { cn } from "@/lib/cn";
import { useApiQuery } from "@/lib/query";
import { useWorkspace } from "@/lib/session";
import type { InboxChannel, InboxFacets } from "@/lib/types/inbox";
import type { InboxFilters } from "./ConversationList";
import { isStringArray, useStoredState } from "./useStoredState";

/** Long lists (campaigns, tags) show this many rows until "Show all". */
const SHOW_FIRST = 6;

const CHANNELS: { value: InboxChannel; label: string }[] = [
  { value: "email", label: "Email" },
  { value: "whatsapp", label: "WhatsApp" },
  { value: "telegram", label: "Telegram" },
  { value: "web", label: "Live chat" },
];

/** Tag colour names → a dot colour (the Badge tones' ink). */
const TONE_DOT: Record<string, string> = {
  mute: "bg-text-3",
  live: "bg-accent",
  ok: "bg-ok-ink",
  warn: "bg-warn-ink",
  bad: "bg-bad-ink",
  info: "bg-info-edge",
};

/**
 * The inbox's left rail: one-click views (mine, unassigned, unread), then
 * channels, campaign replies, live-chat widgets and tags, each with its count
 * of open conversations. Picking the active item again clears it. Counts come
 * from GET /inbox/facets and refresh with the live stream.
 */
export function InboxRail({ filters, onFilters, className }: { filters: InboxFilters; onFilters: (patch: Partial<InboxFilters>) => void; className?: string }) {
  const ws = useWorkspace();
  const facets = useApiQuery<InboxFacets>(ws.key("inbox", "facets"), ws.path("/inbox/facets"), { refetchInterval: 120_000 });
  const f = facets.data;
  const set = (patch: Partial<InboxFilters>) => onFilters({ ...patch, page: 1 });

  const allActive = filters.assignee === "all" && !filters.unread && !filters.channel && !filters.campaign && !filters.tag && !filters.widget && !filters.label;

  // Which sections are folded, remembered per workspace in this browser.
  const [collapsed, setCollapsed] = useStoredState<string[]>(`gd.inbox.rail.${ws.id}`, [], isStringArray);
  const fold = (id: string) => ({
    collapsed: collapsed.includes(id),
    onToggle: () => setCollapsed((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id])),
  });
  const [allCampaigns, setAllCampaigns] = useState(false);
  const [allTags, setAllTags] = useState(false);
  // Only tags in use (plus the one filtered on), and the first few until "Show all".
  const usedTags = f?.tags.filter((t) => t.count > 0 || filters.tag === t.id) ?? [];
  const shownTags = allTags ? usedTags : usedTags.filter((t, i) => i < SHOW_FIRST || filters.tag === t.id);
  const campaigns = f?.campaigns ?? [];
  const shownCampaigns = allCampaigns ? campaigns : campaigns.filter((c, i) => i < SHOW_FIRST || filters.campaign === c.id);
  const widgetTotal = f?.widgets.reduce((n, w) => n + w.count, 0) ?? 0;

  return (
    <nav aria-label="Inbox filters" className={cn("flex h-full min-h-0 flex-col overflow-y-auto px-2 py-3", className)}>
      <Section>
        <RailItem
          icon={<InboxIcon />}
          label={ws.can("records.view_all") ? "All conversations" : "Mine & unassigned"}
          count={f?.total}
          active={allActive}
          onClick={() => set({ assignee: "all", unread: false, channel: "", campaign: "", tag: "", widget: "", label: "" })}
        />
        <RailItem icon={<User />} label="Assigned to me" count={f?.mine} active={filters.assignee === "me"} onClick={() => set({ assignee: filters.assignee === "me" ? "all" : "me" })} />
        <RailItem icon={<UserX />} label="Unassigned" count={f?.unassigned} active={filters.assignee === "none"} onClick={() => set({ assignee: filters.assignee === "none" ? "all" : "none" })} />
        <RailItem icon={<Dot className="!size-5 -m-0.5" />} label="Unread" count={f?.unread} strong={Boolean(f?.unread)} active={filters.unread} onClick={() => set({ unread: !filters.unread })} />
      </Section>

      <Section title="Channels" count={f?.total} countTitle="Open conversations" {...fold("channels")}>
        {CHANNELS.map((c) => {
          const Icon = CHANNEL[c.value].icon;
          const unread = f?.unreadByChannel[c.value] ?? 0;
          return (
            <RailItem
              key={c.value}
              icon={<Icon />}
              label={c.label}
              count={f?.channels[c.value]}
              strong={unread > 0}
              title={unread ? `${unread} unread` : undefined}
              active={filters.channel === c.value && !filters.widget}
              onClick={() => set({ channel: filters.channel === c.value && !filters.widget ? "" : c.value, widget: "" })}
            />
          );
        })}
      </Section>

      <Section title="Campaign replies" count={f?.campaignReplies} countTitle="Open campaign replies" {...fold("campaigns")}>
        <RailItem
          icon={<Megaphone />}
          label="All campaign replies"
          count={f?.campaignReplies}
          active={filters.campaign === "any"}
          onClick={() => set({ campaign: filters.campaign === "any" ? "" : "any" })}
        />
        {shownCampaigns.map((c) => (
          <RailItem
            key={c.id}
            icon={<Hash />}
            label={c.name}
            count={c.count}
            indent
            active={filters.campaign === c.id}
            onClick={() => set({ campaign: filters.campaign === c.id ? "" : c.id })}
          />
        ))}
        {campaigns.length > SHOW_FIRST && <ShowAll open={allCampaigns} total={campaigns.length} onToggle={() => setAllCampaigns((v) => !v)} />}
      </Section>

      {f && f.widgets.length > 0 && (
        <Section title="Live chat" count={widgetTotal} countTitle="Open live chats" {...fold("widgets")}>
          {f.widgets.map((w) => (
            <RailItem
              key={w.id}
              icon={<MessagesSquare />}
              label={w.name}
              count={w.count}
              active={filters.widget === w.id}
              onClick={() => set({ widget: filters.widget === w.id ? "" : w.id, channel: filters.widget === w.id ? "" : "web" })}
            />
          ))}
        </Section>
      )}

      <Section
        title="Tags"
        count={usedTags.length}
        countTitle="Tags on open conversations"
        {...fold("tags")}
        action={
          ws.can("contacts.write") ? (
            <Link href={`/w/${ws.id}/settings/tags`} className="rounded-xs p-0.5 text-text-3 hover:bg-hover hover:text-text" aria-label="Manage tags" title="Manage tags">
              <Settings2 aria-hidden className="size-3.5" />
            </Link>
          ) : null
        }
      >
        {f?.tags.length ? (
          <>
            {!usedTags.length && <li className="px-2 py-1 text-2xs text-text-3">No open conversation is tagged.</li>}
            {shownTags.map((t) => (
              <RailItem
                key={t.id}
                icon={<span aria-hidden className={cn("m-[3px] block size-2 rounded-full", TONE_DOT[tagTone(t.color)] ?? "bg-text-3")} />}
                label={t.name}
                count={t.count}
                active={filters.tag === t.id}
                onClick={() => set({ tag: filters.tag === t.id ? "" : t.id })}
              />
            ))}
            {usedTags.length > SHOW_FIRST && <ShowAll open={allTags} total={usedTags.length} onToggle={() => setAllTags((v) => !v)} />}
            <RailItem icon={<TagIcon />} label="Untagged" active={filters.tag === "none"} onClick={() => set({ tag: filters.tag === "none" ? "" : "none" })} />
          </>
        ) : (
          <p className="px-2 py-1 text-2xs text-text-3">{f ? "No tags yet. Tag a conversation from its header." : ""}</p>
        )}
      </Section>
    </nav>
  );
}

/** A rail section; titled ones fold (chevron) and show a total beside the title. */
function Section({
  title,
  action,
  count,
  countTitle,
  collapsed,
  onToggle,
  children,
}: {
  title?: string;
  action?: ReactNode;
  count?: number;
  countTitle?: string;
  collapsed?: boolean;
  onToggle?: () => void;
  children: ReactNode;
}) {
  return (
    <div className="mb-3">
      {title && (
        <div className="mb-1 flex items-center gap-1 pr-2">
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={!collapsed}
            className="group flex h-6 min-w-0 flex-1 items-center gap-1 rounded-xs px-1 text-left hover:bg-hover"
          >
            <ChevronRight aria-hidden className={cn("size-3 shrink-0 text-text-3 transition-transform", !collapsed && "rotate-90")} />
            <h3 className="truncate text-2xs font-semibold tracking-wide text-text-3 uppercase group-hover:text-text-2">{title}</h3>
            {count !== undefined && count > 0 && (
              <span className="ml-auto shrink-0 rounded-xs bg-mute-chip px-1.5 text-2xs text-text-2 tabular-nums" title={countTitle}>
                {count}
              </span>
            )}
          </button>
          {action}
        </div>
      )}
      {!collapsed && <ul className="flex flex-col gap-px">{children}</ul>}
    </div>
  );
}

function ShowAll({ open, total, onToggle }: { open: boolean; total: number; onToggle: () => void }) {
  return (
    <li>
      <button type="button" onClick={onToggle} className="h-6 w-full rounded-sm px-2 pl-7 text-left text-xs text-text-3 hover:bg-hover hover:text-text">
        {open ? "Show fewer" : `Show all (${total})`}
      </button>
    </li>
  );
}

function RailItem({
  icon,
  label,
  count,
  active,
  strong,
  indent,
  title,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  count?: number;
  active: boolean;
  strong?: boolean;
  indent?: boolean;
  title?: string;
  onClick: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        aria-pressed={active}
        title={title ?? label}
        className={cn(
          "flex h-7 w-full items-center gap-2 rounded-sm px-2 text-left text-sm transition-colors [&_svg]:size-3.5 [&_svg]:shrink-0",
          indent && "pl-5",
          active ? "bg-sidebar-accent font-medium text-text-hi" : "text-text-2 hover:bg-hover hover:text-text",
        )}
      >
        <span aria-hidden className="flex text-text-3">
          {icon}
        </span>
        <span className={cn("min-w-0 flex-1 truncate", strong && !active && "font-medium text-text")}>{label}</span>
        {count !== undefined && count > 0 && <span className={cn("shrink-0 text-2xs tabular-nums", strong ? "font-semibold text-accent" : "text-text-3")}>{count}</span>}
      </button>
    </li>
  );
}
