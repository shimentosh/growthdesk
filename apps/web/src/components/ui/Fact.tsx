import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/*
 * Facts as tiles: a glyph, a small label and the value, laid out in a grid
 * whose hairlines are the grid gap (a record's "at a glance", a campaign's
 * setup). Blank values show an em dash.
 */

export function FactGrid({ children, columns = 2, className }: { children: ReactNode; columns?: 2 | 3; className?: string }) {
  return (
    <div className={cn("grid grid-cols-1 gap-px overflow-hidden bg-line", columns === 3 ? "sm:grid-cols-2 lg:grid-cols-3" : "sm:grid-cols-2", className)}>
      {children}
    </div>
  );
}

export function Fact({ icon, label, children, hint, tone }: { icon: ReactNode; label: string; children: ReactNode; hint?: ReactNode; tone?: "bad" | "warn" | "ok" }) {
  const blank = children === null || children === undefined || children === "";
  return (
    <div className="flex min-w-0 items-start gap-2.5 bg-panel px-3.5 py-3">
      <span
        aria-hidden
        className={cn(
          "flex size-8 shrink-0 items-center justify-center rounded-lg [&_svg]:size-4",
          tone === "bad" ? "bg-bad-wash text-bad-ink" : tone === "warn" ? "bg-warn-wash text-warn-ink" : tone === "ok" ? "bg-ok-wash text-ok-ink" : "bg-s-3 text-text-2",
        )}
      >
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-2xs font-medium tracking-wide text-text-3 uppercase">{label}</div>
        <div className={cn("mt-0.5 min-w-0 truncate text-sm", tone === "bad" ? "text-bad-ink" : "text-text-hi")}>{blank ? <span className="text-text-3">—</span> : children}</div>
        {hint && <div className="mt-0.5 line-clamp-2 text-xs text-text-3">{hint}</div>}
      </div>
    </div>
  );
}
