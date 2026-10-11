"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import type { PlatformRole } from "@growthdesk/shared";
import { Tooltip } from "@/components/ui/Tooltip";
import { PLATFORM_ROLE_LABELS } from "@/features/common/platform";
import { cn } from "@/lib/cn";
import { isActive, navFor } from "@/nav";
import { ConsoleTile, ConsoleWordmark } from "./Brand";

/*
 * The console's left rail: grouped sections from src/nav.ts. Expanded it is
 * 248px with labels; collapsed it is a 60px icon rail with tooltips. Below
 * the `nav` breakpoint the shell shows it in a drawer, always expanded.
 */

export function Sidebar({
  role,
  collapsed = false,
  onToggle,
  onNavigate,
}: {
  role: PlatformRole;
  collapsed?: boolean;
  /** Absent in the mobile drawer (no collapse there). */
  onToggle?: () => void;
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  const groups = navFor(role);

  return (
    <div className="flex h-full flex-col">
      <div className={cn("flex h-14 shrink-0 items-center gap-2.5 border-b border-line", collapsed ? "justify-center px-0" : "px-4")}>
        <Link href="/" onClick={onNavigate} aria-label="Growthdesk Console — dashboard" className="flex min-w-0 items-center gap-2.5 rounded-sm">
          <ConsoleTile size="md" />
          {!collapsed && <ConsoleWordmark subtitle={`Signed in as ${PLATFORM_ROLE_LABELS[role].toLowerCase()}`} />}
        </Link>
      </div>

      <nav aria-label="Console" className={cn("min-h-0 flex-1 overflow-y-auto pb-3", collapsed ? "px-2" : "px-3")}>
        {groups.map((group) => (
          <div key={group.id} className="mt-4 first:mt-3">
            {collapsed ? (
              <div aria-hidden className="mx-auto mb-1.5 h-px w-6 bg-line first:hidden" />
            ) : (
              <div className="px-2 pb-1.5 text-2xs font-semibold tracking-[0.06em] text-text-3 uppercase">{group.label}</div>
            )}
            <ul className="flex flex-col gap-0.5" aria-label={collapsed ? group.label : undefined}>
              {group.items.map((item) => {
                const active = isActive(item, pathname);
                const Icon = item.icon;
                const link = (
                  <Link
                    href={item.href}
                    onClick={onNavigate}
                    aria-current={active ? "page" : undefined}
                    aria-label={collapsed ? item.label : undefined}
                    className={cn(
                      "group relative flex h-8 items-center gap-2.5 rounded-md text-sm transition-colors",
                      collapsed ? "justify-center px-0" : "px-2",
                      active ? "bg-sidebar-accent font-medium text-text-hi" : "text-text-2 hover:bg-hover hover:text-text",
                    )}
                  >
                    {active && <span aria-hidden className="absolute top-1.5 bottom-1.5 -left-1 w-[3px] rounded-full bg-accent" />}
                    <Icon aria-hidden className={cn("size-4 shrink-0", active ? "text-accent-ink" : "text-text-3 group-hover:text-text-2")} />
                    {!collapsed && <span className="truncate">{item.label}</span>}
                  </Link>
                );
                return (
                  <li key={item.href}>
                    {collapsed ? (
                      <Tooltip content={item.label} side="right">
                        {link}
                      </Tooltip>
                    ) : (
                      link
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>

      {onToggle && (
        <div className={cn("shrink-0 border-t border-line p-2", collapsed && "flex justify-center")}>
          <Tooltip content={collapsed ? "Expand sidebar" : undefined} side="right">
            <button
              type="button"
              onClick={onToggle}
              aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
              aria-expanded={!collapsed}
              className={cn(
                "flex h-8 items-center gap-2.5 rounded-md text-sm text-text-3 transition-colors hover:bg-hover hover:text-text",
                collapsed ? "w-8 justify-center" : "w-full px-2",
              )}
            >
              {collapsed ? <PanelLeftOpen aria-hidden className="size-4" /> : <PanelLeftClose aria-hidden className="size-4" />}
              {!collapsed && <span>Collapse</span>}
            </button>
          </Tooltip>
        </div>
      )}
    </div>
  );
}
