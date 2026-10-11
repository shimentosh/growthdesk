"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Tabs as T } from "radix-ui";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/cn";

/*
 * Two kinds of tabs:
 *   <Tabs>/<TabsList>/<TabsTrigger>/<TabsContent>  — in-page panels (Radix; arrow keys move between tabs)
 *   <NavTabs items={[{ href, label }]} />           — tabs that are routes (settings sections, record pages)
 */

export const Tabs = T.Root;

const LIST = "flex items-center gap-4 overflow-x-auto border-b border-line";
const TRIGGER =
  "relative -mb-px inline-flex h-9 shrink-0 items-center gap-1.5 border-b-2 border-transparent px-0.5 text-sm font-medium text-text-3 transition-colors hover:text-text [&_svg]:size-4 [&_svg]:shrink-0";

export function TabsList({ className, ...rest }: ComponentProps<typeof T.List>) {
  return <T.List {...rest} className={cn(LIST, className)} />;
}

export function TabsTrigger({ className, ...rest }: ComponentProps<typeof T.Trigger>) {
  return <T.Trigger {...rest} className={cn(TRIGGER, "data-[state=active]:border-solid-line data-[state=active]:text-text-hi", className)} />;
}

export function TabsContent({ className, ...rest }: ComponentProps<typeof T.Content>) {
  return <T.Content {...rest} className={cn("pt-4 outline-none", className)} />;
}

export type NavTab = { href: string; label: ReactNode; icon?: ReactNode; count?: number; /** Active only on an exact match. */ exact?: boolean };

export function NavTabs({ items, className, "aria-label": ariaLabel = "Sections" }: { items: NavTab[]; className?: string; "aria-label"?: string }) {
  const pathname = usePathname();
  return (
    <nav aria-label={ariaLabel} className={cn(LIST, className)}>
      {items.map((t) => {
        const active = t.exact ? pathname === t.href : pathname === t.href || pathname.startsWith(`${t.href}/`);
        return (
          <Link key={t.href} href={t.href} aria-current={active ? "page" : undefined} className={cn(TRIGGER, active && "border-solid-line text-text-hi")}>
            {t.icon}
            {t.label}
            {t.count !== undefined && <span className="rounded-xs bg-mute-chip px-1.5 text-2xs text-text-2 tabular-nums">{t.count}</span>}
          </Link>
        );
      })}
    </nav>
  );
}
