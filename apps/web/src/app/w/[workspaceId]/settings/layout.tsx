"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useActivePath } from "@/lib/stores/navigation";
import type { ReactNode } from "react";
import { SETTINGS_NAV } from "@/components/shell/nav";
import { EntityTile, type Entity } from "@/components/ui/icons";
import { cn } from "@/lib/cn";
import { useWorkspace } from "@/lib/session";

/** Each section's tile, iOS Settings style; a section not listed here gets the plain settings tile. */
const SECTION_TILE: Record<string, Entity> = {
  "/settings/general": "general",
  "/settings/company": "company",
  "/settings/members": "members",
  "/settings/roles": "roles",
  "/settings/lead-routing": "leads",
  "/settings/integrations": "integrations",
  "/settings/discord": "discord",
  "/settings/billing": "billing",
  "/settings/mailboxes": "mailboxes",
  "/settings/channels": "channels",
  "/settings/live-chat": "liveChat",
  "/settings/calling": "calling",
  "/settings/pipelines": "pipelines",
  "/settings/tags": "tags",
  "/settings/fields": "fields",
  "/settings/suppressions": "suppressions",
  "/settings/api-keys": "apiKeys",
  "/settings/mcp": "mcp",
  "/settings/webhooks": "webhooks",
  "/settings/audit": "audit",
  "/settings/support-access": "supportAccess",
  "/settings/data": "privacy",
  "/settings/sending-domains": "sendingDomains",
  "/settings/subscriptions": "lists",
};

/** Settings: a section list on the left (a scrolling row on phones), the section on the right. */
export default function SettingsLayout({ children }: { children: ReactNode }) {
  const ws = useWorkspace();
  const pathname = useActivePath(usePathname());
  const groups = SETTINGS_NAV.map((g) => ({ ...g, items: g.items.filter((i) => !i.permission || ws.can(i.permission)) })).filter((g) => g.items.length);

  return (
    <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-4 px-4 py-5 nav:flex-row nav:gap-8 nav:px-6 nav:py-6">
      {/* Pinned while the section scrolls: sticky inside the shell's <main> scroller, offset by this layout's top padding,
          and capped to the viewport (minus the 3rem topbar and both paddings). The heading stays put; only the list scrolls. */}
      <nav aria-label="Settings" className="shrink-0 nav:sticky nav:top-6 nav:flex nav:max-h-[calc(100dvh-6rem)] nav:w-56 nav:flex-col nav:self-start">
        <h1 className="mb-4 hidden shrink-0 items-center gap-2.5 text-2xl font-semibold tracking-[-0.022em] text-text-hi nav:flex">
          <EntityTile of="settings" size="md" />
          Settings
        </h1>
        <div className="gd-scroll-quiet flex gap-1 overflow-x-auto pb-1 nav:-mr-3 nav:min-h-0 nav:flex-col nav:gap-4 nav:overflow-x-hidden nav:overflow-y-auto nav:overscroll-contain nav:pr-2 nav:pb-2">
          {groups.map((g) => (
            <div key={g.label} className="flex shrink-0 gap-1 nav:flex-col nav:gap-px">
              <div className="hidden px-2 pb-1 text-2xs font-semibold tracking-wide text-text-3 uppercase nav:block">{g.label}</div>
              {g.items.map((i) => {
                const href = ws.href(i.href);
                const active = pathname === href || pathname.startsWith(`${href}/`);
                return (
                  <Link
                    key={i.href}
                    href={href}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "flex h-8 shrink-0 items-center gap-2.5 rounded-md px-2 text-sm whitespace-nowrap transition-colors",
                      active ? "bg-accent font-medium text-on-accent" : "text-text hover:bg-ctl-hover",
                    )}
                  >
                    <EntityTile of={SECTION_TILE[i.href] ?? "settings"} size="sm" className={active ? "shadow-none ring-1 ring-white/25" : undefined} />
                    {i.label}
                  </Link>
                );
              })}
            </div>
          ))}
        </div>
      </nav>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
