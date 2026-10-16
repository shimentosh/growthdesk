"use client";

import type { ReactNode } from "react";
import { Hash, Megaphone, MessagesSquare, Radio, SlidersHorizontal, Sparkles, Tag as TagIcon, User, X } from "lucide-react";
import { AI_REPLY_CATEGORIES, AI_REPLY_CATEGORY_LABELS, type AiReplyCategory } from "@growthdesk/shared";
import { Button } from "@/components/ui/Button";
import { NativeSelect } from "@/components/ui/Input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/Popover";
import { Switch } from "@/components/ui/Switch";
import { cn } from "@/lib/cn";
import { useApiQuery } from "@/lib/query";
import { useWorkspace } from "@/lib/session";
import type { InboxFacets } from "@/lib/types/inbox";
import type { InboxFilters } from "./ConversationList";

/*
 * The conversation list's own filters: a "Filters" popover (channel, AI label,
 * assignee, unread only) and a row of chips for every filter that is on — the
 * rail's campaign / tag / widget picks included — each with an × to clear it.
 * Everything reads and writes the same URL params as the rail.
 */

const CHANNEL_OPTIONS = [
  { value: "", label: "Any channel" },
  { value: "email", label: "Email" },
  { value: "whatsapp", label: "WhatsApp" },
  { value: "telegram", label: "Telegram" },
  { value: "web", label: "Live chat" },
];

const ASSIGNEE_LABEL: Record<InboxFilters["assignee"], string> = { all: "Anyone", me: "Assigned to me", none: "Unassigned" };

export const labelName = (category: string) => AI_REPLY_CATEGORY_LABELS[category as AiReplyCategory] ?? category;

/** How many of the popover's own filters are on. */
export const popoverFilterCount = (f: InboxFilters) => [f.channel !== "", f.label !== "", f.assignee !== "all", f.unread].filter(Boolean).length;

export function FiltersPopover({ filters, onFilters }: { filters: InboxFilters; onFilters: (patch: Partial<InboxFilters>) => void }) {
  const set = (patch: Partial<InboxFilters>) => onFilters({ ...patch, page: 1 });
  const on = popoverFilterCount(filters);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button size="sm" variant={on ? "tinted" : "secondary"} icon={<SlidersHorizontal />} aria-label={on ? `Filters, ${on} on` : "Filters"}>
          Filters{on ? ` · ${on}` : ""}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="flex w-64 flex-col gap-2.5">
        <FilterField label="Channel">
          <NativeSelect
            size="sm"
            aria-label="Channel"
            icon={<Radio />}
            value={filters.channel}
            options={CHANNEL_OPTIONS}
            onChange={(e) => set({ channel: e.target.value as InboxFilters["channel"], widget: "" })}
          />
        </FilterField>
        <FilterField label="AI label">
          <NativeSelect
            size="sm"
            aria-label="AI label"
            icon={<Sparkles />}
            value={filters.label}
            options={[{ value: "", label: "Any label" }, ...AI_REPLY_CATEGORIES.map((c) => ({ value: c, label: AI_REPLY_CATEGORY_LABELS[c] }))]}
            onChange={(e) => set({ label: e.target.value })}
          />
        </FilterField>
        <FilterField label="Assignee">
          <NativeSelect
            size="sm"
            aria-label="Assignee"
            icon={<User />}
            value={filters.assignee}
            options={(["all", "me", "none"] as const).map((v) => ({ value: v, label: ASSIGNEE_LABEL[v] }))}
            onChange={(e) => set({ assignee: e.target.value as InboxFilters["assignee"] })}
          />
        </FilterField>
        <Switch size="sm" label="Unread only" checked={filters.unread} onCheckedChange={(unread) => set({ unread })} />
        {on > 0 && (
          <button
            type="button"
            className="self-start text-xs text-text-3 underline-offset-2 hover:text-text hover:underline"
            onClick={() => set({ channel: "", label: "", assignee: "all", unread: false, widget: "" })}
          >
            Reset these filters
          </button>
        )}
      </PopoverContent>
    </Popover>
  );
}

function FilterField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-2xs font-medium tracking-wide text-text-3 uppercase">{label}</span>
      {children}
    </div>
  );
}

/** One chip per active filter (names from the rail's facets, which are usually cached already). */
export function ActiveFilterChips({ filters, onFilters, className }: { filters: InboxFilters; onFilters: (patch: Partial<InboxFilters>) => void; className?: string }) {
  const ws = useWorkspace();
  const facets = useApiQuery<InboxFacets>(ws.key("inbox", "facets"), ws.path("/inbox/facets"), { refetchInterval: 120_000 });
  const f = facets.data;
  const set = (patch: Partial<InboxFilters>) => onFilters({ ...patch, page: 1 });
  const chips: { key: string; icon: ReactNode; label: string; clear: () => void }[] = [];
  if (filters.channel && !filters.widget)
    chips.push({ key: "channel", icon: <Radio />, label: CHANNEL_OPTIONS.find((o) => o.value === filters.channel)?.label ?? filters.channel, clear: () => set({ channel: "" }) });
  if (filters.widget)
    chips.push({
      key: "widget",
      icon: <MessagesSquare />,
      label: f?.widgets.find((w) => w.id === filters.widget)?.name ?? "Live chat widget",
      clear: () => set({ widget: "", channel: "" }),
    });
  if (filters.label) chips.push({ key: "label", icon: <Sparkles />, label: labelName(filters.label), clear: () => set({ label: "" }) });
  if (filters.assignee !== "all") chips.push({ key: "assignee", icon: <User />, label: ASSIGNEE_LABEL[filters.assignee], clear: () => set({ assignee: "all" }) });
  if (filters.unread) chips.push({ key: "unread", icon: <span aria-hidden className="m-0.5 block size-2 rounded-full bg-accent" />, label: "Unread", clear: () => set({ unread: false }) });
  if (filters.campaign)
    chips.push({
      key: "campaign",
      icon: filters.campaign === "any" ? <Megaphone /> : <Hash />,
      label: filters.campaign === "any" ? "Campaign replies" : (f?.campaigns.find((c) => c.id === filters.campaign)?.name ?? "Campaign"),
      clear: () => set({ campaign: "" }),
    });
  if (filters.tag)
    chips.push({
      key: "tag",
      icon: <TagIcon />,
      label: filters.tag === "none" ? "Untagged" : (f?.tags.find((t) => t.id === filters.tag)?.name ?? "Tag"),
      clear: () => set({ tag: "" }),
    });
  if (!chips.length) return null;
  return (
    <div className={cn("flex flex-wrap items-center gap-1.5", className)}>
      {chips.map((c) => (
        <span key={c.key} className="inline-flex h-6 max-w-full items-center gap-1 rounded-full border border-line bg-s-2 pr-0.5 pl-2 text-xs text-text-2">
          <span aria-hidden className="flex text-text-3 [&_svg]:size-3">
            {c.icon}
          </span>
          <span className="min-w-0 truncate" title={c.label}>
            {c.label}
          </span>
          <button
            type="button"
            onClick={c.clear}
            aria-label={`Clear ${c.label} filter`}
            className="flex size-5 shrink-0 items-center justify-center rounded-full text-text-3 hover:bg-hover hover:text-text"
          >
            <X aria-hidden className="size-3" />
          </button>
        </span>
      ))}
      {chips.length > 1 && (
        <button
          type="button"
          className="text-xs text-text-3 underline-offset-2 hover:text-text hover:underline"
          onClick={() => set({ assignee: "all", channel: "", unread: false, campaign: "", tag: "", widget: "", label: "" })}
        >
          Clear all
        </button>
      )}
    </div>
  );
}
