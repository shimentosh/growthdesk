"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { navigation, useActivePath } from "@/lib/stores/navigation";
import { useEffect, useState } from "react";
import { Check, ChevronDown, ChevronsUpDown, Plus } from "lucide-react";
import { cn } from "@/lib/cn";
import { useApiQuery } from "@/lib/query";
import { useMe, useWorkspace } from "@/lib/session";
import type { InboxUnreadCount } from "@/lib/types/inbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/DropdownMenu";
import { NAV, NAV_FOOTER, type NavItem } from "./nav";

/** The workspace name at the top of the sidebar; a menu to switch to another or create one. */
function WorkspaceSwitcher() {
  const ws = useWorkspace();
  const me = useMe();
  const router = useRouter();
  const others = me.data?.workspaces ?? [];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="flex h-10 w-full items-center gap-2 rounded-sm px-2 text-left hover:bg-hover">
        <span aria-hidden className="flex size-6 shrink-0 items-center justify-center rounded-sm bg-solid text-2xs font-semibold text-on-solid">
          {ws.name.charAt(0).toUpperCase()}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold text-text-hi">{ws.name}</span>
          <span className="block truncate text-2xs text-text-3">{ws.plan.name} plan</span>
        </span>
        <ChevronsUpDown aria-hidden className="size-3.5 shrink-0 text-text-3" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuLabel>Workspaces</DropdownMenuLabel>
        {others.map((w) => (
          <DropdownMenuItem key={w.id} onSelect={() => {
            navigation.start(`/w/${w.id}`);
            router.push(`/w/${w.id}`);
          }} shortcut={w.id === ws.id ? <Check aria-hidden className="!size-3.5 !text-accent" /> : undefined}>
            {w.name}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem icon={<Plus />} onSelect={() => {
          navigation.start("/onboarding");
          router.push("/onboarding");
        }}>
          New workspace
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const COLLAPSED_KEY = "gd.nav.collapsed";

/**
 * Which sidebar groups the person has folded, by group id. Kept in this
 * browser only; storage that is missing or blocked just means every group
 * starts open. Read after mount so the server render and first paint agree.
 */
function useCollapsedGroups() {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => {
    try {
      const saved: unknown = JSON.parse(window.localStorage.getItem(COLLAPSED_KEY) ?? "[]");
      if (Array.isArray(saved)) setCollapsed(new Set(saved.filter((v): v is string => typeof v === "string")));
    } catch {
      // Unreadable storage: keep every group open.
    }
  }, []);
  const toggle = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      try {
        window.localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]));
      } catch {
        // Not remembered, still toggles for this visit.
      }
      return next;
    });
  return { collapsed, toggle };
}

function NavLink({ item, active, badge, onNavigate }: { item: NavItem; active: boolean; badge?: number; onNavigate?: () => void }) {
  const ws = useWorkspace();
  const Icon = item.icon;
  return (
    <Link
      href={ws.href(item.href)}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      className={cn(
        "relative flex h-8 items-center gap-2.5 rounded-sm px-2 text-sm transition-colors",
        active
          ? "bg-sidebar-accent font-medium text-text-hi before:absolute before:top-1/2 before:left-0 before:h-4 before:w-[3px] before:-translate-y-1/2 before:rounded-full before:bg-accent"
          : "text-text-2 hover:bg-hover hover:text-text",
      )}
    >
      <Icon aria-hidden className={cn("size-4 shrink-0", active ? "text-text-hi" : "text-text-3")} />
      <span className="truncate">{item.label}</span>
      {!!badge && (
        <span className="ml-auto rounded-xs bg-accent px-1.5 text-2xs font-semibold text-on-accent tabular-nums">
          {badge > 99 ? "99+" : badge}
          <span className="sr-only"> unread</span>
        </span>
      )}
    </Link>
  );
}

/** Primary navigation. Links a role cannot use are hidden. */
export function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const ws = useWorkspace();
  // The clicked item lights up at once, before its page has arrived.
  const pathname = useActivePath(usePathname());
  const { collapsed, toggle } = useCollapsedGroups();
  // Open, unread, not-snoozed conversations for the Inbox link (the inbox's own changes refresh it via ws.key("inbox")).
  const unread = useApiQuery<InboxUnreadCount>(ws.key("inbox", "unread"), ws.can("inbox.read") ? ws.path("/inbox/unread-count") : null, { refetchInterval: 60_000 });
  const inboxUnread = unread.data?.total ?? 0;

  const visible = (items: NavItem[]) => items.filter((i) => !i.permission || ws.can(i.permission));
  const isActive = (item: NavItem) => {
    const under = (path: string) => {
      const href = ws.href(path);
      return pathname === href || pathname.startsWith(`${href}/`);
    };
    return item.exact ? pathname === ws.href(item.href) : under(item.href) || (item.also ?? []).some(under);
  };
  const footer = visible(NAV_FOOTER);

  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 p-2">
        <WorkspaceSwitcher />
      </div>
      <nav aria-label="Main" className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {NAV.map((group) => {
          const items = visible(group.items);
          if (!items.length) return null;
          const hasActive = items.some(isActive);
          // The group holding the current page never hides it.
          const open = !group.label || hasActive || !collapsed.has(group.id);
          const listId = `nav-group-${group.id}`;
          return (
            <div key={group.id} className="mt-4 first:mt-1">
              {group.label && (
                <button
                  type="button"
                  onClick={() => toggle(group.id)}
                  disabled={hasActive}
                  aria-expanded={open}
                  aria-controls={listId}
                  className="group/head mb-0.5 flex h-6 w-full items-center gap-1 rounded-xs px-2 text-left text-2xs font-semibold tracking-wide text-text-3 uppercase transition-colors enabled:hover:text-text-2"
                >
                  <span className="flex-1 truncate">{group.label}</span>
                  {!hasActive && (
                    <ChevronDown
                      aria-hidden
                      className={cn(
                        "size-3 shrink-0 transition-[transform,opacity] duration-200",
                        open ? "opacity-0 group-hover/head:opacity-100 group-focus-visible/head:opacity-100" : "-rotate-90",
                      )}
                    />
                  )}
                </button>
              )}
              <div className={cn("grid transition-[grid-template-rows] duration-200 ease-out", open ? "grid-rows-[1fr]" : "grid-rows-[0fr]")}>
                <ul id={listId} inert={!open} className="flex min-h-0 flex-col gap-px overflow-hidden">
                  {items.map((item) => (
                    <li key={item.href}>
                      <NavLink item={item} active={isActive(item)} badge={item.href === "/inbox" ? inboxUnread : undefined} onNavigate={onNavigate} />
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          );
        })}
      </nav>
      {footer.length > 0 && (
        <div className="shrink-0 border-t border-line p-2">
          <ul className="flex flex-col gap-px">
            {footer.map((item) => (
              <li key={item.href}>
                <NavLink item={item} active={isActive(item)} onNavigate={onNavigate} />
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
