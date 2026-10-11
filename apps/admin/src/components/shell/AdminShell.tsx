"use client";

import { usePathname } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type ReactNode } from "react";
import type { PlatformRole } from "@growthdesk/shared";
import { DialogPrimitive as D } from "@/components/ui/Dialog";
import { PlatformRoleProvider } from "@/features/common/platform";
import { cn } from "@/lib/cn";
import { SIDEBAR_COOKIE } from "@/lib/constants";
import type { EnvInfo } from "@/lib/environment";
import { ME_KEY } from "@/lib/session";
import type { Me } from "@/lib/types";
import { Sidebar } from "./Sidebar";
import { Topbar } from "./Topbar";

/*
 * The console frame: the sidebar (collapsible to an icon rail on desktop, a
 * drawer below the `nav` breakpoint), the top bar, and the scrolling page.
 * The (panel) layout has already checked the platform role; every endpoint
 * checks it again.
 */
export function AdminShell({
  me,
  role,
  collapsed: initialCollapsed,
  environment,
  appUrl,
  children,
}: {
  /** The layout's /auth/me answer: seeds the useMe() cache so the user menu never flashes empty. */
  me: Me;
  role: PlatformRole;
  collapsed: boolean;
  environment: EnvInfo;
  appUrl: string | null;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const qc = useQueryClient();
  useState(() => {
    if (!qc.getQueryData(ME_KEY)) qc.setQueryData(ME_KEY, me);
  });
  const [collapsed, setCollapsed] = useState(initialCollapsed);
  const [navOpen, setNavOpen] = useState(false);
  useEffect(() => setNavOpen(false), [pathname]);

  const toggle = () => {
    const next = !collapsed;
    setCollapsed(next);
    document.cookie = `${SIDEBAR_COOKIE}=${next ? "collapsed" : "expanded"}; path=/; max-age=${60 * 60 * 24 * 365}; samesite=lax`;
  };

  return (
    <PlatformRoleProvider role={role}>
      <div className="flex h-dvh overflow-hidden bg-bg">
        <aside
          className={cn(
            "hidden shrink-0 border-r border-line bg-sidebar transition-[width] duration-200 ease-out nav:block",
            collapsed ? "w-[60px]" : "w-[248px]",
          )}
        >
          <Sidebar role={role} collapsed={collapsed} onToggle={toggle} />
        </aside>

        <D.Root open={navOpen} onOpenChange={setNavOpen}>
          <D.Portal>
            <D.Overlay className="fixed inset-0 z-50 bg-scrim animate-fade-in nav:hidden" />
            <D.Content
              aria-describedby={undefined}
              className="fixed inset-y-0 left-0 z-50 w-[272px] border-r border-line-strong bg-sidebar shadow-sheet animate-slide-in-left nav:hidden"
            >
              <D.Title className="sr-only">Console navigation</D.Title>
              <Sidebar role={role} onNavigate={() => setNavOpen(false)} />
            </D.Content>
          </D.Portal>
        </D.Root>

        <div className="flex min-w-0 flex-1 flex-col">
          <Topbar role={role} environment={environment} appUrl={appUrl} onOpenNav={() => setNavOpen(true)} />
          <main id="main" className="min-h-0 flex-1 overflow-y-auto">
            {children}
          </main>
        </div>
      </div>
    </PlatformRoleProvider>
  );
}
