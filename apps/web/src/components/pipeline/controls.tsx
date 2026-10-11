"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * Filters that live in the URL (?view=today&type=call), so a link or a
 * reload lands on the same list. Empty values are removed from the URL.
 */
export function useSearchState() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  return {
    get: (key: string) => params.get(key) ?? "",
    set: (patch: Record<string, string | null | undefined>) => {
      const next = new URLSearchParams(params.toString());
      for (const [k, v] of Object.entries(patch)) {
        if (v) next.set(k, v);
        else next.delete(k);
      }
      const s = next.toString();
      router.replace(s ? `${pathname}?${s}` : pathname, { scroll: false });
    },
  };
}

/** Two or three mutually exclusive buttons (Board / List). */
export function Segmented<V extends string>({
  value,
  onChange,
  options,
  "aria-label": ariaLabel,
}: {
  value: V;
  onChange: (value: V) => void;
  options: { value: V; label: string; icon?: ReactNode }[];
  "aria-label": string;
}) {
  return (
    <div role="group" aria-label={ariaLabel} className="inline-flex h-8 shrink-0 items-center rounded-sm border border-line-strong bg-ctl-face p-0.5 shadow-sm">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            "inline-flex h-full items-center gap-1.5 rounded-xs px-2.5 text-xs font-medium transition-colors [&_svg]:size-3.5",
            value === o.value ? "bg-s-4 text-text-hi" : "text-text-3 hover:text-text",
          )}
        >
          {o.icon}
          {o.label}
        </button>
      ))}
    </div>
  );
}

/**
 * A row of view tabs that drive the URL (?view=today). Plain toggle buttons
 * rather than Radix Tabs, because there are no panels to point at — the list
 * below simply reloads.
 */
export function ViewTabs<V extends string>({
  value,
  onChange,
  options,
  "aria-label": ariaLabel,
}: {
  value: V;
  onChange: (value: V) => void;
  options: { value: V; label: string; icon?: ReactNode; count?: number }[];
  "aria-label": string;
}) {
  return (
    <div role="group" aria-label={ariaLabel} className="flex items-center gap-4 overflow-x-auto border-b border-line">
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(o.value)}
            className={cn(
              "relative -mb-px inline-flex h-9 shrink-0 items-center gap-1.5 border-b-2 px-0.5 text-sm font-medium transition-colors",
              active ? "border-solid-line text-text-hi" : "border-transparent text-text-3 hover:text-text",
            )}
          >
            {o.icon && <span aria-hidden className="flex [&_svg]:size-4">{o.icon}</span>}
            {o.label}
            {o.count !== undefined && <span className="rounded-xs bg-mute-chip px-1.5 text-2xs text-text-2 tabular-nums">{o.count}</span>}
          </button>
        );
      })}
    </div>
  );
}
