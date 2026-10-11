import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export type KeyValueItem = { label: ReactNode; value: ReactNode; hint?: ReactNode };

const isBlank = (v: ReactNode) => v === null || v === undefined || v === "" || v === false;

/**
 * Label / value pairs (a record's details panel). Blank values show an
 * em dash, so a missing field reads as missing rather than as a layout bug.
 */
export function KeyValueList({ items, columns = 1, className }: { items: KeyValueItem[]; columns?: 1 | 2; className?: string }) {
  return (
    <dl className={cn("grid gap-x-6 gap-y-3", columns === 2 ? "grid-cols-1 sm:grid-cols-2" : "grid-cols-1", className)}>
      {items.map((item, i) => (
        <div key={i} className="grid min-w-0 grid-cols-[minmax(96px,38%)_1fr] items-baseline gap-3">
          <dt className="truncate text-xs text-text-3">{item.label}</dt>
          <dd className="min-w-0 text-sm break-words text-text">
            {isBlank(item.value) ? <span className="text-text-3">—</span> : item.value}
            {item.hint && <div className="text-xs text-text-3">{item.hint}</div>}
          </dd>
        </div>
      ))}
    </dl>
  );
}
