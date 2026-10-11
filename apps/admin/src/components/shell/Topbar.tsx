"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { ChevronRight, ExternalLink, LogOut, Menu, ShieldCheck } from "lucide-react";
import type { PlatformRole } from "@growthdesk/shared";
import { Avatar } from "@/components/ui/Avatar";
import { IconButton } from "@/components/ui/Button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/DropdownMenu";
import { Tooltip } from "@/components/ui/Tooltip";
import { PLATFORM_ROLE_LABELS, PlatformRoleBadge } from "@/features/common/platform";
import { cn } from "@/lib/cn";
import type { EnvInfo } from "@/lib/environment";
import { signOut, useMe } from "@/lib/session";
import { breadcrumbs } from "@/nav";
import { GlobalSearch } from "./GlobalSearch";
import { ThemeToggle } from "./ThemeToggle";

function Breadcrumbs({ className }: { className?: string }) {
  const crumbs = breadcrumbs(usePathname());
  if (!crumbs.length) return null;
  return (
    <nav aria-label="Breadcrumb" className={cn("min-w-0", className)}>
      <ol className="flex min-w-0 items-center gap-1 text-sm">
        {crumbs.map((c, i) => {
          const last = i === crumbs.length - 1;
          return (
            <li key={`${c.label}-${i}`} className={cn("flex min-w-0 items-center gap-1", !last && "shrink-0")}>
              {i > 0 && <ChevronRight aria-hidden className="size-3.5 shrink-0 text-text-3" />}
              {c.href && !last ? (
                <Link href={c.href} className="truncate text-text-3 transition-colors hover:text-text">
                  {c.label}
                </Link>
              ) : (
                <span aria-current={last ? "page" : undefined} className={cn("truncate", last ? "font-medium text-text-hi" : "text-text-3")}>
                  {c.label}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

const ENV_STYLES: Record<EnvInfo["tone"], string> = {
  info: "border-info-edge bg-info-wash text-accent-ink",
  warn: "border-warn-edge bg-warn-wash text-warn-ink",
  bad: "border-bad-edge bg-bad-wash text-bad-ink",
};

function EnvBadge({ env }: { env: EnvInfo }) {
  return (
    <Tooltip content={`Environment: ${env.label}`}>
      <span className={cn("inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full border px-2 text-2xs font-semibold tracking-wide uppercase", ENV_STYLES[env.tone])}>
        <span aria-hidden className="size-1.5 rounded-full bg-current" />
        {env.label}
      </span>
    </Tooltip>
  );
}

function UserMenu({ role, appUrl }: { role: PlatformRole; appUrl: string | null }) {
  const me = useMe();
  const router = useRouter();
  const user = me.data?.user;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="inline-flex items-center gap-2 rounded-full py-0.5 pr-0.5 pl-0.5 outline-offset-2 transition-colors hover:bg-hover lg:rounded-md lg:pr-2" aria-label="Your account">
        <Avatar name={user?.name} email={user?.email} size="md" />
        <span className="hidden min-w-0 flex-col text-left leading-tight lg:flex">
          <span className="max-w-36 truncate text-xs font-medium text-text">{user?.name || user?.email || "…"}</span>
          <span className="text-2xs text-text-3">{PLATFORM_ROLE_LABELS[role]}</span>
        </span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <div className="flex items-start gap-2.5 px-2 py-2">
          <Avatar name={user?.name} email={user?.email} size="md" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium text-text">{user?.name || "—"}</div>
            <div className="truncate text-xs text-text-3">{user?.email}</div>
            <div className="mt-1">
              <PlatformRoleBadge role={role} />
            </div>
          </div>
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem icon={<ShieldCheck />} onSelect={() => router.push("/account")}>
          Two-factor authentication
        </DropdownMenuItem>
        {appUrl && (
          <DropdownMenuItem icon={<ExternalLink />} onSelect={() => window.open(appUrl, "_blank", "noopener,noreferrer")}>
            Open customer app
          </DropdownMenuItem>
        )}
        <DropdownMenuItem icon={<LogOut />} onSelect={() => void signOut()}>
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function Topbar({ role, environment, appUrl, onOpenNav }: { role: PlatformRole; environment: EnvInfo; appUrl: string | null; onOpenNav: () => void }) {
  return (
    <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-2 border-b border-line bg-bg/85 px-3 backdrop-blur-md nav:gap-3 nav:px-5">
      <IconButton label="Open navigation" icon={<Menu />} className="nav:hidden" onClick={onOpenNav} />
      <Breadcrumbs className="hidden min-w-0 flex-1 lg:block" />
      <GlobalSearch role={role} className="min-w-0 flex-1 md:max-w-md lg:w-72 lg:flex-none xl:w-80" />
      <div className="ml-auto flex shrink-0 items-center gap-1.5">
        <span className="hidden sm:inline-flex">
          <EnvBadge env={environment} />
        </span>
        {appUrl && (
          <Tooltip content="Open the customer app in a new tab">
            <a
              href={appUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="hidden h-8 items-center gap-1.5 rounded-sm px-2 text-sm text-text-2 transition-colors hover:bg-hover hover:text-text lg:inline-flex"
            >
              Open app
              <ExternalLink aria-hidden className="size-3.5" />
            </a>
          </Tooltip>
        )}
        <ThemeToggle />
        <UserMenu role={role} appUrl={appUrl} />
      </div>
    </header>
  );
}
