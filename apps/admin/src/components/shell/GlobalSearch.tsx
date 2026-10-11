"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Building2, CornerDownLeft, Search, X } from "lucide-react";
import type { PlatformRole } from "@growthdesk/shared";
import { Avatar } from "@/components/ui/Avatar";
import { Badge } from "@/components/ui/Badge";
import { Kbd } from "@/components/ui/Kbd";
import { Spinner } from "@/components/ui/Skeleton";
import { PLATFORM_ROLE_LABELS, platformKey } from "@/features/common/platform";
import type { AdminUserRow, AdminWorkspaceRow } from "@/features/common/types";
import { cn } from "@/lib/cn";
import { useApiQuery } from "@/lib/query";
import type { Paged } from "@/lib/types";
import { navFor } from "@/nav";

/*
 * The top bar's search: pages from src/nav.ts, plus users and workspaces from
 * GET /admin/users?q= and GET /admin/workspaces?q= (the list endpoints, 5 rows
 * each). ⌘K / Ctrl+K focuses it from anywhere; arrows move, Enter opens,
 * Escape closes.
 */

const LIMIT = 5;

type Result = { key: string; href: string; group: "Pages" | "Users" | "Workspaces"; title: string; subtitle?: string; icon: ReactNode; meta?: ReactNode };

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function GlobalSearch({ role, className }: { role: PlatformRole; className?: string }) {
  const router = useRouter();
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [mac, setMac] = useState(true);
  const q = useDebounced(text.trim(), 200);
  const searching = q.length >= 2;

  useEffect(() => setMac(/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)), []);

  // ⌘K / Ctrl+K from anywhere.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
        setOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Close on a click outside.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);

  const users = useApiQuery<Paged<AdminUserRow>>(platformKey("search", "users"), searching ? "/admin/users" : null, {
    query: { q, page: 1, pageSize: LIMIT },
    keepPrevious: true,
    staleTime: 15_000,
  });
  const workspaces = useApiQuery<Paged<AdminWorkspaceRow>>(platformKey("search", "workspaces"), searching ? "/admin/workspaces" : null, {
    query: { q, page: 1, pageSize: LIMIT },
    keepPrevious: true,
    staleTime: 15_000,
  });

  const results = useMemo<Result[]>(() => {
    const needle = text.trim().toLowerCase();
    if (!needle) return [];
    const pages: Result[] = navFor(role)
      .flatMap((g) => g.items.map((item) => ({ item, group: g.label })))
      .filter(({ item, group }) => [item.label, group, ...(item.keywords ?? [])].some((w) => w.toLowerCase().includes(needle)))
      .slice(0, 4)
      .map(({ item, group }) => ({
        key: `page:${item.href}`,
        href: item.href,
        group: "Pages",
        title: item.label,
        subtitle: group,
        icon: (
          <span className="flex size-8 items-center justify-center rounded-md bg-s-3 text-text-2">
            <item.icon aria-hidden className="size-4" />
          </span>
        ),
      }));
    if (!searching) return pages;
    const u: Result[] = (users.data?.items ?? []).map((row) => ({
      key: `user:${row.id}`,
      href: `/users/${row.id}`,
      group: "Users",
      title: row.name || row.email,
      subtitle: row.name ? row.email : undefined,
      icon: <Avatar name={row.name} email={row.email} size="md" />,
      meta: row.disabledAt ? (
        <Badge tone="bad" quiet>
          Disabled
        </Badge>
      ) : row.platformRole !== "none" ? (
        <Badge tone="info" quiet>
          {PLATFORM_ROLE_LABELS[row.platformRole]}
        </Badge>
      ) : undefined,
    }));
    const w: Result[] = (workspaces.data?.items ?? []).map((row) => ({
      key: `ws:${row.id}`,
      href: `/workspaces/${row.id}`,
      group: "Workspaces",
      title: row.name,
      subtitle: row.billingAccount.owner.email,
      icon: (
        <span className="flex size-8 items-center justify-center rounded-md bg-s-3 text-text-2">
          <Building2 aria-hidden className="size-4" />
        </span>
      ),
      meta: row.status === "suspended" ? (
        <Badge tone="bad" quiet>
          Suspended
        </Badge>
      ) : row.subscription ? (
        <Badge quiet>{row.subscription.plan.name}</Badge>
      ) : undefined,
    }));
    return [...pages, ...u, ...w];
  }, [text, role, searching, users.data, workspaces.data]);

  useEffect(() => setActive(0), [text]);

  const loading = searching && (users.isFetching || workspaces.isFetching);
  const failed = searching && (users.isError || workspaces.isError);
  const showPanel = open && text.trim().length > 0;

  const go = (r: Result | undefined) => {
    if (!r) return;
    router.push(r.href);
    setOpen(false);
    setText("");
    inputRef.current?.blur();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setActive((i) => Math.min(i + 1, Math.max(results.length - 1, 0)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      go(results[active]);
    } else if (e.key === "Escape") {
      if (text) setText("");
      else inputRef.current?.blur();
      setOpen(false);
    }
  };

  let lastGroup = "";

  return (
    <div ref={wrapRef} className={cn("relative", className)}>
      <div
        className={cn(
          "flex h-8 w-full items-center gap-2 rounded-md border bg-field px-2.5 text-sm transition-[border-color,box-shadow]",
          open ? "border-accent shadow-[0_0_0_3px_var(--accent-ring)]" : "border-line-strong hover:border-s-7",
        )}
      >
        <Search aria-hidden className="size-4 shrink-0 text-text-3" />
        <input
          ref={inputRef}
          type="text"
          role="combobox"
          aria-expanded={showPanel}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={showPanel && results[active] ? `${listId}-${active}` : undefined}
          aria-label="Search users, workspaces and pages"
          placeholder="Search users, workspaces…"
          autoComplete="off"
          spellCheck={false}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          className="h-full min-w-0 flex-1 bg-transparent text-text outline-none placeholder:text-text-3 focus-visible:outline-none"
        />
        {loading ? (
          <Spinner size="sm" label="Searching" />
        ) : text ? (
          <button type="button" aria-label="Clear search" onClick={() => setText("")} className="rounded-xs text-text-3 hover:text-text">
            <X aria-hidden className="size-3.5" />
          </button>
        ) : (
          <span className="hidden items-center gap-0.5 md:flex" aria-hidden>
            <Kbd>{mac ? "⌘" : "Ctrl"}</Kbd>
            <Kbd>K</Kbd>
          </span>
        )}
      </div>

      {showPanel && (
        <div className="absolute top-[calc(100%+6px)] right-0 left-0 z-[60] min-w-[min(420px,calc(100vw-24px))] overflow-hidden rounded-lg border border-line-strong bg-popover shadow-lg animate-pop-in sm:right-auto sm:w-full">
          <ul id={listId} role="listbox" aria-label="Search results" className="max-h-[min(440px,70dvh)] overflow-y-auto p-1">
            {results.map((r, i) => {
              const heading = r.group !== lastGroup ? r.group : null;
              lastGroup = r.group;
              return (
                <li key={r.key} role="presentation">
                  {heading && <div className="px-2 pt-2 pb-1 text-2xs font-semibold tracking-wide text-text-3 uppercase">{heading}</div>}
                  <div
                    id={`${listId}-${i}`}
                    role="option"
                    aria-selected={i === active}
                    onMouseMove={() => setActive(i)}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => go(r)}
                    className={cn("flex cursor-pointer items-center gap-2.5 rounded-sm px-2 py-1.5", i === active && "bg-hover")}
                  >
                    {r.icon}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm text-text">{r.title}</span>
                      {r.subtitle && <span className="block truncate text-xs text-text-3">{r.subtitle}</span>}
                    </span>
                    {r.meta}
                    {i === active && <CornerDownLeft aria-hidden className="size-3.5 shrink-0 text-text-3" />}
                  </div>
                </li>
              );
            })}
          </ul>
          {results.length === 0 && (
            <p className="px-3 py-6 text-center text-xs text-text-3">
              {!searching ? "Type at least 2 characters to search users and workspaces." : loading ? "Searching…" : failed ? "Search failed. Try again." : `Nothing matches “${q}”.`}
            </p>
          )}
          <div className="flex items-center gap-3 border-t border-line bg-well px-3 py-1.5 text-2xs text-text-3">
            <span className="flex items-center gap-1">
              <Kbd>↑</Kbd>
              <Kbd>↓</Kbd> move
            </span>
            <span className="flex items-center gap-1">
              <Kbd>↵</Kbd> open
            </span>
            <span className="flex items-center gap-1">
              <Kbd>esc</Kbd> close
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
