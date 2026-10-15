"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Bell, CheckCheck, LogOut, Menu, Monitor, Moon, ShieldCheck, Sun, UserRound } from "lucide-react";
import { cn } from "@/lib/cn";
import { useApiMutation, useApiQuery } from "@/lib/query";
import { navigation } from "@/lib/stores/navigation";
import { signOut, useFormat, useMe, useWorkspace } from "@/lib/session";
import { applyTheme, currentTheme, type ThemeChoice } from "@/lib/theme";
import type { NotificationsResponse } from "@/lib/types";
import { Avatar } from "@/components/ui/Avatar";
import { Button, IconButton } from "@/components/ui/Button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/DropdownMenu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/Popover";
import { Spinner } from "@/components/ui/Skeleton";

/** The bell: unread count, the latest notifications, mark one or all read. */
function NotificationsBell() {
  const ws = useWorkspace();
  const f = useFormat();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const list = useApiQuery<NotificationsResponse>(ws.key("notifications"), ws.path("/notifications"), { refetchInterval: 60_000 });
  const readAll = useApiMutation({ path: ws.path("/notifications/read"), invalidate: [ws.key("notifications")] });
  const readOne = useApiMutation<unknown, string>({ path: (id) => ws.path(`/notifications/${id}/read`), invalidate: [ws.key("notifications")] });
  const unread = list.data?.unread ?? 0;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={unread ? `Notifications, ${unread} unread` : "Notifications"}
          className="relative inline-flex size-8 items-center justify-center rounded-sm text-text-2 hover:bg-hover hover:text-text"
        >
          <Bell aria-hidden className="size-4" />
          {unread > 0 && (
            <span className="absolute top-1 right-1 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-bad px-1 text-[9px] font-semibold text-white tabular-nums">
              {unread > 99 ? "99+" : unread}
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[360px] p-0">
        <div className="flex items-center justify-between border-b border-line px-3 py-2">
          <span className="text-sm font-semibold text-text-hi">Notifications</span>
          <Button size="sm" variant="ghost" icon={<CheckCheck />} disabled={!unread} loading={readAll.isPending} onClick={() => readAll.mutate()}>
            Mark all read
          </Button>
        </div>
        <div className="max-h-[420px] overflow-y-auto">
          {list.isPending ? (
            <div className="flex justify-center py-8">
              <Spinner label="Loading notifications" />
            </div>
          ) : !list.data?.items.length ? (
            <p className="px-3 py-8 text-center text-xs text-text-3">Nothing yet. Replies, overdue tasks and deal changes will show up here.</p>
          ) : (
            <ul>
              {list.data.items.map((n) => (
                <li key={n.id}>
                  <button
                    type="button"
                    onClick={() => {
                      if (!n.readAt) readOne.mutate(n.id);
                      if (n.link) {
                        setOpen(false);
                        navigation.start(n.link);
                        router.push(n.link);
                      }
                    }}
                    className="flex w-full items-start gap-2.5 border-b border-line px-3 py-2.5 text-left last:border-b-0 hover:bg-hover"
                  >
                    <span aria-hidden className={cn("mt-1.5 size-1.5 shrink-0 rounded-full", n.readAt ? "bg-transparent" : "bg-accent")} />
                    <span className="min-w-0 flex-1">
                      <span className={cn("block text-sm", n.readAt ? "text-text-2" : "font-medium text-text")}>{n.title}</span>
                      {n.body && <span className="mt-0.5 block line-clamp-2 text-xs text-text-3">{n.body}</span>}
                      <span className="mt-0.5 block text-2xs text-text-3">{f.relative(n.createdAt)}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** The signed-in person: account settings, appearance, sign out. */
export function UserMenu() {
  const me = useMe();
  const router = useRouter();
  const [theme, setTheme] = useState<ThemeChoice>(() => currentTheme());
  const user = me.data?.user;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="inline-flex items-center rounded-full outline-offset-2" aria-label="Your account">
        <Avatar name={user?.name} email={user?.email} size="sm" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        {user && (
          <div className="px-2 py-1.5">
            <div className="truncate text-sm font-medium text-text">{user.name}</div>
            <div className="truncate text-xs text-text-3">{user.email}</div>
          </div>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem icon={<UserRound />} onSelect={() => {
            navigation.start("/account");
            router.push("/account");
          }}>
          Account settings
        </DropdownMenuItem>
        {/* A full page load: /admin redirects to the operator console, another origin (src/proxy.ts). */}
        {user && user.platformRole !== "none" && (
          <DropdownMenuItem icon={<ShieldCheck />} onSelect={() => window.location.assign("/admin")}>
            Platform admin
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Appearance</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={theme}
          onValueChange={(v) => {
            setTheme(v as ThemeChoice);
            applyTheme(v as ThemeChoice);
          }}
        >
          <DropdownMenuRadioItem value="system" onSelect={(e) => e.preventDefault()}>
            <span className="flex items-center gap-2">
              <Monitor aria-hidden className="size-3.5 text-text-3" /> System
            </span>
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="light" onSelect={(e) => e.preventDefault()}>
            <span className="flex items-center gap-2">
              <Sun aria-hidden className="size-3.5 text-text-3" /> Light
            </span>
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="dark" onSelect={(e) => e.preventDefault()}>
            <span className="flex items-center gap-2">
              <Moon aria-hidden className="size-3.5 text-text-3" /> Dark
            </span>
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem icon={<LogOut />} onSelect={() => void signOut()}>
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * "Switch to admin" for platform staff: the operator console is another
 * origin, reached through /admin (a full page load; src/proxy.ts redirects).
 * The console's own top bar links back here.
 */
function AdminSwitch() {
  const me = useMe();
  const role = me.data?.user.platformRole;
  if (!role || role === "none") return null;
  return (
    <Button size="sm" variant="ghost" icon={<ShieldCheck />} title="Open the operator console" onClick={() => window.location.assign("/admin")}>
      <span className="hidden sm:inline">Switch to admin</span>
      <span className="sm:hidden">Admin</span>
    </Button>
  );
}

export function Topbar({ onOpenNav }: { onOpenNav: () => void }) {
  return (
    <header className="sticky top-0 z-30 flex h-12 shrink-0 items-center gap-2 border-b border-line bg-bg/90 px-3 backdrop-blur nav:px-4">
      <IconButton label="Open navigation" icon={<Menu />} className="nav:hidden" onClick={onOpenNav} />
      <div className="flex-1" />
      <AdminSwitch />
      <NotificationsBell />
      <UserMenu />
    </header>
  );
}
