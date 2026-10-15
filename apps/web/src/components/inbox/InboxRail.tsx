"use client";

import type { ReactNode } from "react";
import { Hash, Inbox as InboxIcon, Megaphone, MessagesSquare, Settings2, Tag as TagIcon, User, UserX, Dot } from "lucide-react";
import Link from "next/link";
import { tagTone } from "@/components/imports/labels";
import { CHANNEL } from "@/components/ui/icons";
import { cn } from "@/lib/cn";
import { useApiQuery } from "@/lib/query";
import { useWorkspace } from "@/lib/session";
import type { InboxChannel, InboxFacets } from "@/lib/types/inbox";
import type { InboxFilters } from "./ConversationList";

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

  const allActive = filters.assignee === "all" && !filters.unread && !filters.channel && !filters.campaign && !filters.tag && !filters.widget;

  return (
    <nav aria-label="Inbox filters" className={cn("flex h-full min-h-0 flex-col overflow-y-auto px-2 py-3", className)}>
      <Section>
        <RailItem
          icon={<InboxIcon />}
          label={ws.can("records.view_all") ? "All conversations" : "Mine & unassigned"}
          count={f?.total}
          active={allActive}
          onClick={() => set({ assignee: "all", unread: false, channel: "", campaign: "", tag: "", widget: "" })}
        />
        <RailItem icon={<User />} label="Assigned to me" count={f?.mine} active={filters.assignee === "me"} onClick={() => set({ assignee: filters.assignee === "me" ? "all" : "me" })} />
        <RailItem icon={<UserX />} label="Unassigned" count={f?.unassigned} active={filters.assignee === "none"} onClick={() => set({ assignee: filters.assignee === "none" ? "all" : "none" })} />
        <RailItem icon={<Dot className="!size-5 -m-0.5" />} label="Unread" count={f?.unread} strong={Boolean(f?.unread)} active={filters.unread} onClick={() => set({ unread: !filters.unread })} />
      </Section>

      <Section title="Channels">
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

      <Section title="Campaign replies">
        <RailItem
          icon={<Megaphone />}
          label="All campaign replies"
          count={f?.campaignReplies}
          active={filters.campaign === "any"}
          onClick={() => set({ campaign: filters.campaign === "any" ? "" : "any" })}
        />
        {f?.campaigns.map((c) => (
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
      </Section>

      {f && f.widgets.length > 0 && (
        <Section title="Live chat">
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
            {f.tags.map((t) => (
              <RailItem
                key={t.id}
                icon={<span aria-hidden className={cn("m-[3px] block size-2 rounded-full", TONE_DOT[tagTone(t.color)] ?? "bg-text-3")} />}
                label={t.name}
                count={t.count}
                active={filters.tag === t.id}
                onClick={() => set({ tag: filters.tag === t.id ? "" : t.id })}
              />
            ))}
            <RailItem icon={<TagIcon />} label="Untagged" active={filters.tag === "none"} onClick={() => set({ tag: filters.tag === "none" ? "" : "none" })} />
          </>
        ) : (
          <p className="px-2 py-1 text-2xs text-text-3">{f ? "No tags yet. Tag a conversation from its header." : ""}</p>
        )}
      </Section>
    </nav>
  );
}

function Section({ title, action, children }: { title?: string; action?: ReactNode; children: ReactNode }) {
  return (
    <div className="mb-3">
      {title && (
        <div className="mb-1 flex items-center justify-between px-2">
          <h3 className="text-2xs font-semibold tracking-wide text-text-3 uppercase">{title}</h3>
          {action}
        </div>
      )}
      <ul className="flex flex-col gap-px">{children}</ul>
    </div>
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
