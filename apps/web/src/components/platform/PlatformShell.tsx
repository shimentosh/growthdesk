"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { ChevronLeft, Menu } from "lucide-react";
import type { PlatformRole } from "@growthdesk/shared";
import { UserMenu } from "@/components/shell/Topbar";
import { Button, IconButton } from "@/components/ui/Button";
import { DialogPrimitive as D } from "@/components/ui/Dialog";
import { EntityTile } from "@/components/ui/icons";
import { cn } from "@/lib/cn";
import { useMe } from "@/lib/session";
import { PLATFORM_ROLE_LABELS, PlatformRoleProvider, PlatformTile, type PlatformSection } from "./common";

/*
 * The platform admin's own frame (docs/ARCHITECTURE.md: "the admin area has
 * its own layout"): a sidebar of platform sections, no workspace switcher,
 * and a way back to the customer app. The server layout has already checked
 * the platform role; every endpoint checks it again.
 */

/** `tile`: the section's glyph and colour (PLATFORM in ./common), the same tile its page header shows. */
type Item = { href: string; label: string; tile: PlatformSection; exact?: boolean };

const NAV: { label?: string; items: Item[] }[] = [
  { items: [{ href: "/admin", label: "Overview", tile: "overview", exact: true }] },
  {
    label: "Customers",
    items: [
      { href: "/admin/users", label: "Users", tile: "users" },
      { href: "/admin/workspaces", label: "Workspaces", tile: "workspaces" },
      { href: "/admin/billing", label: "Billing accounts", tile: "billing" },
      { href: "/admin/plans", label: "Plans", tile: "plans" },
    ],
  },
  { label: "Support", items: [{ href: "/admin/support", label: "Support", tile: "support" }] },
  {
    label: "Platform",
    items: [
      { href: "/admin/audit", label: "Audit log", tile: "audit" },
      { href: "/admin/email", label: "Email log", tile: "email" },
      { href: "/admin/settings", label: "Settings", tile: "settings" },
    ],
  },
];

function PlatformNav({ role, onNavigate }: { role: PlatformRole; onNavigate?: () => void }) {
  const pathname = usePathname();
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-12 shrink-0 items-center gap-2.5 px-4">
        <EntityTile of="admin" size="md" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold text-text-hi">Platform admin</span>
          <span className="block truncate text-2xs text-text-3">Signed in as {PLATFORM_ROLE_LABELS[role].toLowerCase()}</span>
        </span>
      </div>
      <nav aria-label="Platform admin" className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {NAV.map((group, gi) => (
          <div key={gi} className="mt-3 first:mt-1">
            {group.label && <div className="px-2 pb-1 text-2xs font-semibold tracking-wide text-text-3 uppercase">{group.label}</div>}
            <ul className="flex flex-col gap-px">
              {group.items.map((item) => {
                const active = item.exact ? pathname === item.href : pathname === item.href || pathname.startsWith(`${item.href}/`);
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      onClick={onNavigate}
                      aria-current={active ? "page" : undefined}
                      className={cn(
                        "flex h-8 items-center gap-2.5 rounded-md px-2 text-sm transition-colors",
                        active ? "bg-sidebar-accent font-medium text-text-hi" : "text-text-2 hover:bg-hover hover:text-text",
                      )}
                    >
                      <PlatformTile of={item.tile} size="sm" />
                      <span className="truncate">{item.label}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>
    </div>
  );
}

export function PlatformShell({ role, children }: { role: PlatformRole; children: ReactNode }) {
  const pathname = usePathname();
  const me = useMe();
  const [navOpen, setNavOpen] = useState(false);
  useEffect(() => setNavOpen(false), [pathname]);
  const workspaces = me.data?.workspaces ?? [];
  const last = workspaces.find((w) => w.id === me.data?.lastWorkspaceId) ?? workspaces[0];

  return (
    <PlatformRoleProvider role={role}>
      <div className="flex h-dvh overflow-hidden bg-bg">
        <aside className="hidden w-[232px] shrink-0 border-r border-line bg-sidebar nav:block">
          <PlatformNav role={role} />
        </aside>

        <D.Root open={navOpen} onOpenChange={setNavOpen}>
          <D.Portal>
            <D.Overlay className="fixed inset-0 z-50 bg-scrim animate-fade-in nav:hidden" />
            <D.Content aria-describedby={undefined} className="fixed inset-y-0 left-0 z-50 w-[260px] border-r border-line-strong bg-sidebar shadow-sheet animate-slide-in-left nav:hidden">
              <D.Title className="sr-only">Platform admin navigation</D.Title>
              <PlatformNav role={role} onNavigate={() => setNavOpen(false)} />
            </D.Content>
          </D.Portal>
        </D.Root>

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="sticky top-0 z-30 flex h-12 shrink-0 items-center gap-2 border-b border-line bg-bg/90 px-3 backdrop-blur nav:px-4">
            <IconButton label="Open navigation" icon={<Menu />} className="nav:hidden" onClick={() => setNavOpen(true)} />
            <div className="flex-1" />
            <Button size="sm" variant="ghost" href={last ? `/w/${last.id}` : "/account"} icon={<ChevronLeft />}>
              <span className="max-w-[40vw] truncate">{last ? `Back to ${last.name}` : "Account settings"}</span>
            </Button>
            <UserMenu />
          </header>
          <main className="min-h-0 flex-1 overflow-y-auto">{children}</main>
        </div>
      </div>
    </PlatformRoleProvider>
  );
}
