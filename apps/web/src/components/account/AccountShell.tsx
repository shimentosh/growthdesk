"use client";

import type { ReactNode } from "react";
import { ChevronLeft } from "lucide-react";
import { UserMenu } from "@/components/shell/Topbar";
import { Button } from "@/components/ui/Button";
import { useMe } from "@/lib/session";
import { BrandTile } from "./AuthFrame";

/** The account area sits outside any workspace: a plain top bar with the way back. */
export function AccountShell({ children }: { children: ReactNode }) {
  const me = useMe();
  const workspaces = me.data?.workspaces ?? [];
  const last = workspaces.find((w) => w.id === me.data?.lastWorkspaceId) ?? workspaces[0];

  return (
    <div className="min-h-dvh bg-bg">
      <header className="sticky top-0 z-30 flex h-12 items-center gap-3 border-b border-line bg-bg/90 px-3 backdrop-blur nav:px-4">
        {me.data &&
          (last ? (
            <Button size="sm" variant="ghost" href={`/w/${last.id}`} icon={<ChevronLeft />}>
              <span className="max-w-[40vw] truncate">Back to {last.name}</span>
            </Button>
          ) : (
            <Button size="sm" variant="ghost" href="/onboarding" icon={<ChevronLeft />}>
              Set up a workspace
            </Button>
          ))}
        <div className="flex-1" />
        <span className="hidden items-center gap-2 text-sm font-semibold tracking-[-0.01em] text-text-hi sm:inline-flex">
          <BrandTile size="sm" />
          Growthdesk
        </span>
        <UserMenu />
      </header>
      <main>{children}</main>
    </div>
  );
}
