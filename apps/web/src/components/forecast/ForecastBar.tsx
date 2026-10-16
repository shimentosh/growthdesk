"use client";

import type { ReactNode } from "react";
import { Tooltip } from "@/components/ui/Tooltip";
import { cn } from "@/lib/cn";
import { formatCurrency, formatPercent } from "@/lib/format";

/*
 * Attainment as one horizontal bar: won, then commit, then best case, laid end
 * to end against the target (a tick). The three are degrees of certainty, so
 * they are one blue ramp, darkest = most certain (an ordinal ramp, validated
 * with the dataviz skill's validate_palette.js --ordinal against the panel
 * surface in light and in dark). Segments are separated by a 2px gap of the
 * surface, the last one has a rounded end, and each one has a tooltip; the
 * numbers are also printed in the tables, so nothing is hover-only.
 */

/** The ramp, light and dark (dark: lighter = more certain, so "won" stays the loudest on the dark panel). */
const RAMP_CSS = `
.gd-forecast-ramp { --fc-won: #1c5cab; --fc-commit: #3987e5; --fc-best: #86b6ef; }
@media (prefers-color-scheme: dark) { :root:not(.light) .gd-forecast-ramp { --fc-won: #86b6ef; --fc-commit: #3987e5; --fc-best: #184f95; } }
:root.dark .gd-forecast-ramp { --fc-won: #86b6ef; --fc-commit: #3987e5; --fc-best: #184f95; }
`;

/** Put once around everything that draws a ForecastBar or a ForecastLegend. */
export function ForecastRamp({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div className={cn("gd-forecast-ramp", className)}>
      <style>{RAMP_CSS}</style>
      {children}
    </div>
  );
}

export const SERIES = [
  { key: "won", label: "Won", color: "var(--fc-won)" },
  { key: "commit", label: "Commit", color: "var(--fc-commit)" },
  { key: "bestCase", label: "Best case", color: "var(--fc-best)" },
] as const;

type Figures = { won: number; commit: number; bestCase: number; target: number | null };

export function ForecastBar({ figures, currency, size = "md", className }: { figures: Figures; currency: string; size?: "sm" | "md"; className?: string }) {
  const parts = SERIES.map((s) => ({ ...s, value: Math.max(0, figures[s.key]) })).filter((p) => p.value > 0);
  const filled = parts.reduce((a, p) => a + p.value, 0);
  const scale = Math.max(figures.target ?? 0, filled);
  const pct = (v: number) => (scale > 0 ? (v / scale) * 100 : 0);
  const height = size === "sm" ? "h-2" : "h-5";
  const money = (v: number) => formatCurrency(v, currency);
  const label = [
    ...parts.map((p) => `${p.label} ${money(p.value)}`),
    figures.target !== null ? `target ${money(figures.target)}` : "no target",
  ].join(", ");

  return (
    <div role="img" aria-label={label} className={cn("relative py-1", className)}>
      <div className={cn("flex w-full items-stretch gap-[2px]", height)}>
        {parts.map((p, i) => (
          <Tooltip
            key={p.key}
            content={
              <span className="tabular-nums">
                <strong className="font-semibold">{money(p.value)}</strong> {p.label.toLowerCase()}
                {figures.target ? ` · ${formatPercent(p.value / figures.target, 0)} of target` : ""}
              </span>
            }
          >
            <span
              className={cn("block min-w-[3px] shrink", i === parts.length - 1 && "rounded-r-[4px]")}
              style={{ width: `${pct(p.value)}%`, background: p.color }}
            />
          </Tooltip>
        ))}
        {/* The rest of the way to the target: the track. */}
        <span aria-hidden className="block min-w-0 flex-1 rounded-r-[4px] bg-s-4" />
      </div>
      {figures.target !== null && figures.target > 0 && (
        <Tooltip content={<span className="tabular-nums">Target {money(figures.target)}</span>}>
          <span className="absolute top-0 bottom-0 w-[2px] -translate-x-1/2 rounded-full bg-text-hi" style={{ left: `${pct(figures.target)}%` }} />
        </Tooltip>
      )}
    </div>
  );
}

/** The key for the bars: one swatch per series and the target tick. Text stays in text colours. */
export function ForecastLegend({ className }: { className?: string }) {
  return (
    <ul className={cn("flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-text-2", className)}>
      {SERIES.map((s) => (
        <li key={s.key} className="flex items-center gap-1.5">
          <span aria-hidden className="size-2.5 rounded-[3px]" style={{ background: s.color }} />
          {s.label}
        </li>
      ))}
      <li className="flex items-center gap-1.5">
        <span aria-hidden className="h-3 w-[2px] rounded-full bg-text-hi" />
        Target
      </li>
    </ul>
  );
}
