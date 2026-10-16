"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useMemo, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { ArrowRight, Clock, CornerDownLeft, Plus, Search, Settings } from "lucide-react";
import { labelOf } from "@growthdesk/shared";
import { cn } from "@/lib/cn";
import { useDebouncedValue } from "@/lib/hooks";
import { useApiQuery } from "@/lib/query";
import { useFormat, useWorkspace } from "@/lib/session";
import { navigation } from "@/lib/stores/navigation";
import type { Pipeline } from "@/lib/types/pipeline";
import { Badge, statusTone } from "@/components/ui/Badge";
import { DialogPrimitive as D } from "@/components/ui/Dialog";
import { IconTile } from "@/components/ui/IconTile";
import { ENTITY, EntityTile, type Entity } from "@/components/ui/icons";
import { Kbd } from "@/components/ui/Kbd";
import { Spinner } from "@/components/ui/Skeleton";
import { NewContactModal } from "@/components/crm/NewContactModal";
import { NewDealModal } from "@/components/pipeline/NewDealModal";
import { TaskDrawer } from "@/components/pipeline/TaskDrawer";
import { CampaignTypeModal, useCampaignKinds } from "@/components/campaigns/CampaignTypeModal";
import { ComposeModal } from "@/components/inbox/ComposeModal";
import { NAV, NAV_FOOTER, SETTINGS_NAV, type NavItem } from "./nav";

/*
 * The ⌘K / Ctrl+K palette: jump to any page the sidebar offers, start the
 * common "new …" flows, reopen a recent record, or search every kind of
 * record (GET /workspaces/:id/search, which applies the same permissions and
 * ownership scopes as each list page).
 *
 * Accessibility: a modal dialog (Radix: focus trap, Escape, scrim) holding a
 * combobox input that drives a listbox through aria-activedescendant; arrow
 * keys move, Enter runs, the mouse hovers and clicks.
 */

// ─── Search results (apps/api/src/search/search.service.ts) ───────────────────

type SearchGroup = "contacts" | "companies" | "deals" | "conversations" | "campaigns" | "lists" | "templates" | "workflows" | "tasks";
type SearchHit = { id: string; title: string; subtitle: string | null; badge: string | null; kind?: string; value?: number; currency?: string };
type SearchResponse = { q: string; groups: Partial<Record<SearchGroup, { items: SearchHit[]; more: boolean }>> };

const GROUPS: { key: SearchGroup; label: string; entity: Entity; seeAll: (q: string) => string; href: (h: SearchHit) => string; tile?: (h: SearchHit) => Entity }[] = [
  {
    key: "contacts",
    label: "Contacts & leads",
    entity: "contacts",
    seeAll: (q) => `/contacts?stage=all&q=${encodeURIComponent(q)}`,
    href: (h) => `/contacts/${h.id}`,
    tile: (h) => (h.badge === "contact" ? "contacts" : "leads"),
  },
  { key: "companies", label: "Companies", entity: "companies", seeAll: (q) => `/companies?q=${encodeURIComponent(q)}`, href: (h) => `/companies/${h.id}` },
  { key: "deals", label: "Deals", entity: "deals", seeAll: (q) => `/deals?view=list&q=${encodeURIComponent(q)}`, href: (h) => `/deals/${h.id}` },
  { key: "conversations", label: "Conversations", entity: "inbox", seeAll: (q) => `/inbox?status=all&q=${encodeURIComponent(q)}`, href: (h) => `/inbox/${h.id}` },
  {
    key: "campaigns",
    label: "Campaigns",
    entity: "campaigns",
    seeAll: (q) => `/campaigns?q=${encodeURIComponent(q)}`,
    href: (h) => (h.kind === "marketing" ? `/marketing/campaigns/${h.id}` : `/campaigns/${h.id}`),
    tile: (h) => (h.kind === "marketing" ? "marketingCampaigns" : "campaigns"),
  },
  { key: "lists", label: "Lead lists", entity: "lists", seeAll: (q) => `/marketing/lists?q=${encodeURIComponent(q)}`, href: (h) => `/marketing/lists/${h.id}` },
  {
    key: "templates",
    label: "Templates & designs",
    entity: "templates",
    seeAll: (q) => `/templates?q=${encodeURIComponent(q)}`,
    href: (h) => (h.kind === "design" ? `/marketing/designs/${h.id}` : `/templates/${h.id}`),
    tile: (h) => (h.kind === "design" ? "designs" : "templates"),
  },
  { key: "workflows", label: "Workflows", entity: "workflows", seeAll: (q) => `/automation?q=${encodeURIComponent(q)}`, href: (h) => `/automation/${h.id}` },
  { key: "tasks", label: "Tasks", entity: "tasks", seeAll: () => `/tasks?view=all`, href: (h) => `/tasks?view=all&task=${h.id}` },
];

// ─── Recent records (this browser only) ────────────────────────────────────────

type Recent = { key: string; title: string; subtitle: string | null; entity: Entity; href: string };
const RECENT_MAX = 5;
const recentKey = (workspaceId: string) => `gd.palette.recent.${workspaceId}`;

function readRecent(workspaceId: string): Recent[] {
  try {
    const raw: unknown = JSON.parse(window.localStorage.getItem(recentKey(workspaceId)) ?? "[]");
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((r): r is Recent => typeof r === "object" && r !== null && typeof r.key === "string" && typeof r.href === "string" && typeof r.title === "string" && r.entity in ENTITY)
      .slice(0, RECENT_MAX);
  } catch {
    return [];
  }
}

function pushRecent(workspaceId: string, item: Recent) {
  try {
    const next = [item, ...readRecent(workspaceId).filter((r) => r.key !== item.key)].slice(0, RECENT_MAX);
    window.localStorage.setItem(recentKey(workspaceId), JSON.stringify(next));
  } catch {
    // Not remembered; the palette still works.
  }
}

// ─── Options ─────────────────────────────────────────────────────────────────

type QuickAction = "contact" | "task" | "deal" | "campaign" | "workflow" | "compose";

type Option = {
  id: string;
  label: string;
  hint?: ReactNode;
  icon: ReactNode;
  badge?: ReactNode;
  run: () => void;
};
type Section = { id: string; label: string; options: Option[] };

const matches = (q: string, ...texts: string[]) => {
  const needle = q.trim().toLowerCase();
  return !needle || texts.some((t) => t.toLowerCase().includes(needle));
};

const isMacLike = () => typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent);

// ─── Trigger + palette ───────────────────────────────────────────────────────

/** The top-bar search box (wide on desktop, an icon on phones) and the palette it opens. ⌘K / Ctrl+K anywhere opens it too. */
export function SearchTrigger() {
  const [open, setOpen] = useState(false);
  const [action, setAction] = useState<QuickAction | null>(null);
  const [mac, setMac] = useState(true);

  useEffect(() => {
    setMac(isMacLike());
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Search or jump to"
        aria-keyshortcuts={mac ? "Meta+K" : "Control+K"}
        className={cn(
          "inline-flex items-center gap-2 rounded-sm text-text-3 transition-colors hover:text-text",
          // Phones: an icon button. Wider: a search field look-alike.
          "size-8 justify-center hover:bg-hover",
          "sm:h-8 sm:w-full sm:max-w-[420px] sm:justify-start sm:border sm:border-line sm:bg-ctl-face sm:px-2.5 sm:hover:border-line-strong sm:hover:bg-ctl-face",
        )}
      >
        <Search aria-hidden className="size-4 shrink-0" />
        <span className="hidden flex-1 truncate text-left text-sm sm:block">Search or jump to…</span>
        <span aria-hidden className="hidden items-center gap-0.5 sm:inline-flex">
          <Kbd>{mac ? "⌘" : "Ctrl"}</Kbd>
          <Kbd>K</Kbd>
        </span>
      </button>
      <CommandPalette open={open} onOpenChange={setOpen} onAction={setAction} />
      <QuickActionHost action={action} onDone={() => setAction(null)} />
    </>
  );
}

function CommandPalette({ open, onOpenChange, onAction }: { open: boolean; onOpenChange: (open: boolean) => void; onAction: (a: QuickAction) => void }) {
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-50 flex items-start justify-center bg-scrim px-3 pt-[10vh] backdrop-blur-[2px] animate-fade-in">
          <D.Content
            aria-describedby={undefined}
            className="flex max-h-[min(560px,80vh)] w-full max-w-[640px] flex-col overflow-hidden rounded-xl border border-line-strong bg-popover shadow-sheet animate-pop-in"
          >
            <D.Title className="sr-only">Search or jump to</D.Title>
            {/* Remounted on each open: a fresh query and selection. */}
            {open && <PaletteBody close={() => onOpenChange(false)} onAction={onAction} />}
          </D.Content>
        </D.Overlay>
      </D.Portal>
    </D.Root>
  );
}

function PaletteBody({ close, onAction }: { close: () => void; onAction: (a: QuickAction) => void }) {
  const ws = useWorkspace();
  const f = useFormat();
  const router = useRouter();
  const kinds = useCampaignKinds();
  const baseId = useId();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [recent, setRecent] = useState<Recent[]>([]);
  useEffect(() => setRecent(readRecent(ws.id)), [ws.id]);

  const q = query.trim();
  const debounced = useDebouncedValue(q, 200);
  const results = useApiQuery<SearchResponse>(ws.key("search"), debounced ? ws.path("/search") : null, {
    query: { q: debounced, limit: 5 },
    keepPrevious: true,
    staleTime: 15_000,
  });
  const searching = Boolean(q) && (debounced !== q || results.isFetching);

  const go = useCallback(
    (path: string) => {
      close();
      const href = ws.href(path);
      navigation.start(href);
      router.push(href);
    },
    [close, router, ws],
  );

  const sections = useMemo<Section[]>(() => {
    const out: Section[] = [];
    const visible = (items: NavItem[]) => items.filter((i) => !i.permission || ws.can(i.permission));

    // Pages: the sidebar and the settings menu, exactly as this role sees them.
    const pages: Option[] = [];
    for (const group of NAV) {
      for (const item of visible(group.items)) {
        if (!matches(q, item.label, group.label ?? "")) continue;
        const Icon = item.icon;
        pages.push({ id: `page:${item.href}`, label: item.label, hint: group.label, icon: <IconTile size="sm" tint="gray" icon={<Icon />} />, run: () => go(item.href) });
      }
    }
    for (const item of visible(NAV_FOOTER)) {
      if (!matches(q, item.label)) continue;
      const Icon = item.icon;
      pages.push({ id: `page:${item.href}`, label: item.label, icon: <IconTile size="sm" tint="gray" icon={<Icon />} />, run: () => go(item.href) });
    }
    // Settings sub-pages only when asked for: the empty palette stays short.
    if (q) {
      for (const group of SETTINGS_NAV) {
        for (const item of group.items.filter((i) => !i.permission || ws.can(i.permission))) {
          if (!matches(q, item.label, "settings")) continue;
          pages.push({ id: `page:${item.href}`, label: item.label, hint: `Settings · ${group.label}`, icon: <IconTile size="sm" tint="gray" icon={<Settings />} />, run: () => go(item.href) });
        }
      }
    }

    // Quick actions: the same create flows the pages open, only where the role (and plan) allows.
    const actions: Option[] = [];
    const action = (id: QuickAction, label: string, entity: Entity, allowed: boolean, run?: () => void) => {
      if (!allowed || !matches(q, label, "new create add")) return;
      actions.push({ id: `action:${id}`, label, icon: <EntityTile of={entity} size="sm" />, hint: <Plus aria-hidden className="size-3.5" />, run: run ?? (() => (close(), onAction(id))) });
    };
    action("contact", "New contact", "contacts", ws.can("contacts.write"));
    action("task", "New task", "tasks", ws.can("tasks.write"));
    action("deal", "New deal", "deals", ws.can("deals.write"));
    action("campaign", "New campaign", "campaigns", kinds.any);
    action("workflow", "New workflow", "workflows", ws.can("automation.write") && ws.hasFeature("automation"), () => go("/automation/new"));
    action("compose", "Compose message", "inbox", ws.can("inbox.reply"));

    if (!q) {
      if (recent.length) {
        out.push({
          id: "recent",
          label: "Recent",
          options: recent.map((r) => ({
            id: `recent:${r.key}`,
            label: r.title,
            hint: r.subtitle ?? undefined,
            icon: <EntityTile of={r.entity} size="sm" />,
            badge: <Clock aria-hidden className="size-3.5 text-text-3" />,
            run: () => go(r.href),
          })),
        });
      }
      if (actions.length) out.push({ id: "actions", label: "Quick actions", options: actions });
      if (pages.length) out.push({ id: "pages", label: "Jump to", options: pages });
      return out;
    }

    if (pages.length) out.push({ id: "pages", label: "Pages", options: pages.slice(0, 6) });
    // While the next answer loads, the previous one stays (keepPrevious) so the list does not flash empty.
    const data = results.data;
    for (const g of GROUPS) {
      const group = data?.groups[g.key];
      if (!group?.items.length) continue;
      const options: Option[] = group.items.map((h) => {
        const entity = g.tile?.(h) ?? g.entity;
        const href = g.href(h);
        const sub = [h.subtitle, g.key === "deals" && h.value !== undefined ? f.money(h.value, h.currency) : null, g.key === "conversations" && h.kind ? labelOf(h.kind) : null]
          .filter(Boolean)
          .join(" · ");
        return {
          id: `${g.key}:${h.id}`,
          label: h.title,
          hint: sub || undefined,
          icon: <EntityTile of={entity} size="sm" />,
          badge: h.badge ? (
            <Badge tone={g.key === "deals" && h.badge !== "won" && h.badge !== "lost" ? "mute" : statusTone(h.badge)} className="max-w-[140px]">
              {g.key === "deals" ? h.badge : labelOf(h.badge)}
            </Badge>
          ) : undefined,
          run: () => {
            pushRecent(ws.id, { key: `${g.key}:${h.id}`, title: h.title, subtitle: h.subtitle, entity, href });
            go(href);
          },
        };
      });
      if (group.more) {
        options.push({
          id: `all:${g.key}`,
          label: `See all in ${g.label}`,
          icon: <span aria-hidden className="inline-flex size-[22px] items-center justify-center text-text-3"><ArrowRight className="size-3.5" /></span>,
          run: () => go(g.seeAll(q)),
        });
      }
      out.push({ id: g.key, label: g.label, options });
    }
    if (actions.length) out.push({ id: "actions", label: "Quick actions", options: actions });
    return out;
  }, [q, debounced, results.data, recent, ws, kinds.any, go, close, onAction, f]);

  const flat = useMemo(() => sections.flatMap((s) => s.options), [sections]);
  const optionId = (i: number) => `${baseId}-opt-${i}`;
  const activeIndex = flat.length ? Math.min(active, flat.length - 1) : -1;

  // A new query starts at the top.
  useEffect(() => setActive(0), [q]);
  useEffect(() => {
    if (activeIndex < 0) return;
    document.getElementById(optionId(activeIndex))?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (!flat.length) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((activeIndex + 1) % flat.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((activeIndex - 1 + flat.length) % flat.length);
    } else if (e.key === "Home" && e.ctrlKey) {
      e.preventDefault();
      setActive(0);
    } else if (e.key === "End" && e.ctrlKey) {
      e.preventDefault();
      setActive(flat.length - 1);
    } else if (e.key === "Enter" && !e.nativeEvent.isComposing) {
      e.preventDefault();
      flat[activeIndex]?.run();
    }
  };

  const listboxId = `${baseId}-list`;
  const noResults = Boolean(q) && !searching && !results.isError && debounced === q && flat.every((o) => o.id.startsWith("page:") || o.id.startsWith("action:"));
  let index = -1;

  return (
    <>
      <div className="flex shrink-0 items-center gap-2.5 border-b border-line px-4">
        <Search aria-hidden className="size-4 shrink-0 text-text-3" />
        <input
          autoFocus
          role="combobox"
          aria-expanded={flat.length > 0}
          aria-controls={listboxId}
          aria-autocomplete="list"
          aria-activedescendant={activeIndex >= 0 ? optionId(activeIndex) : undefined}
          aria-label="Search or jump to"
          placeholder="Search contacts, deals, campaigns… or jump to a page"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          spellCheck={false}
          autoComplete="off"
          className="h-12 min-w-0 flex-1 bg-transparent text-sm text-text-hi outline-none placeholder:text-text-3"
        />
        {searching && <Spinner size="sm" label="Searching" />}
        <Kbd className="hidden sm:inline-flex">Esc</Kbd>
      </div>

      <div id={listboxId} role="listbox" aria-label="Results" className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {sections.map((s) => (
          <div key={s.id} role="group" aria-labelledby={`${baseId}-${s.id}`} className="mb-1 last:mb-0">
            <div id={`${baseId}-${s.id}`} role="presentation" className="px-2.5 pt-2 pb-1 text-2xs font-semibold tracking-wide text-text-3 uppercase">
              {s.label}
            </div>
            {s.options.map((o) => {
              index += 1;
              const i = index;
              const selected = i === activeIndex;
              return (
                <div
                  key={o.id}
                  id={optionId(i)}
                  role="option"
                  aria-selected={selected}
                  onMouseMove={() => !selected && setActive(i)}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => o.run()}
                  className={cn("flex cursor-pointer items-center gap-2.5 rounded-sm px-2.5 py-1.5 text-sm", selected ? "bg-hover text-text-hi" : "text-text")}
                >
                  <span className="shrink-0">{o.icon}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{o.label}</span>
                    {o.hint && <span className="block truncate text-xs text-text-3">{o.hint}</span>}
                  </span>
                  {o.badge && <span className="shrink-0">{o.badge}</span>}
                  {selected && <CornerDownLeft aria-hidden className="size-3.5 shrink-0 text-text-3" />}
                </div>
              );
            })}
          </div>
        ))}
        {noResults && <p className="px-3 py-6 text-center text-xs text-text-3">No records match “{q}”.</p>}
        {results.isError && q && (
          <p role="alert" className="px-3 py-6 text-center text-xs text-bad-ink">
            Search is unavailable right now. {results.error.message}
          </p>
        )}
      </div>

      <div className="hidden shrink-0 items-center gap-3 border-t border-line bg-well px-4 py-2 text-2xs text-text-3 sm:flex">
        <span className="inline-flex items-center gap-1">
          <Kbd>↑</Kbd>
          <Kbd>↓</Kbd> to move
        </span>
        <span className="inline-flex items-center gap-1">
          <Kbd>↵</Kbd> to open
        </span>
        <span className="inline-flex items-center gap-1">
          <Kbd>Esc</Kbd> to close
        </span>
      </div>
    </>
  );
}

/**
 * The create flows a quick action starts — the very dialogs the Contacts,
 * Tasks, Deals, Campaigns and Inbox pages open — mounted only while in use.
 */
function QuickActionHost({ action, onDone }: { action: QuickAction | null; onDone: () => void }) {
  const ws = useWorkspace();
  const router = useRouter();
  const pipelines = useApiQuery<Pipeline[]>(ws.key("pipelines"), action === "deal" ? ws.path("/pipelines") : null);
  const openChange = (o: boolean) => !o && onDone();
  const go = (path: string) => {
    const href = ws.href(path);
    navigation.start(href);
    router.push(href);
  };
  switch (action) {
    case "contact":
      return <NewContactModal open onOpenChange={openChange} onCreated={(c) => go(`/contacts/${c.id}`)} />;
    case "task":
      return <TaskDrawer open onOpenChange={openChange} />;
    case "deal":
      return <NewDealModal open onOpenChange={openChange} pipelines={pipelines.data ?? []} pipelineId={pipelines.data?.[0]?.id} onCreated={(d) => go(`/deals/${d.id}`)} />;
    case "campaign":
      return <CampaignTypeModal open onOpenChange={openChange} />;
    case "compose":
      return <ComposeModal open onOpenChange={openChange} onSent={(id) => go(`/inbox/${id}`)} />;
    default:
      return null;
  }
}
