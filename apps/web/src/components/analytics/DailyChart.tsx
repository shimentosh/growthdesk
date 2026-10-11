"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { cn } from "@/lib/cn";

/*
 * A daily column chart in plain SVG (no chart library): one series, one axis.
 * Colours are the theme's tokens (var(--accent), var(--line), var(--text-3)),
 * so it follows light and dark mode with the rest of the app.
 *
 * Reading it: hover or focus the chart and use ←/→ to step through days; the
 * readout names the day and the value. Callers also offer a table view, so
 * nothing here is available only by pointer or only by colour.
 */

const HEIGHT = 220;
const PAD = { top: 12, right: 8, bottom: 24, left: 44 };

export type ChartPoint = { date: string; value: number };

/** "Sep 3" for a local day "2026-09-03" (the day is already in the workspace's zone; format it as-is). */
const SHORT = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const LONG = new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
export const dayLabel = (day: string, long = false) => (long ? LONG : SHORT).format(new Date(`${day}T12:00:00Z`));

/** A round axis maximum and step: 0, step, 2·step … ≥ max, with steps of 1/2/2.5/5 × 10ⁿ. */
export function niceScale(max: number, ticks = 4, integer = true): { top: number; step: number } {
  if (!(max > 0)) return { top: integer ? ticks : 1, step: integer ? 1 : 0.25 };
  const raw = max / ticks;
  const mag = 10 ** Math.floor(Math.log10(raw));
  let step = ([1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag) as number;
  if (integer) step = Math.max(1, Math.ceil(step));
  return { top: Math.ceil(max / step) * step, step };
}

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(Math.floor(entry?.contentRect.width ?? 0)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

/** A column with a 3px rounded top, square on the baseline. */
function columnPath(x: number, y: number, w: number, h: number): string {
  if (h <= 0) return "";
  const r = Math.min(3, w / 2, h);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

export function DailyChart({
  points,
  label,
  format,
  integer = true,
  className,
}: {
  points: ChartPoint[];
  /** What the series is ("Messages sent") — the chart's accessible name. */
  label: string;
  format: (value: number) => string;
  /** Counts (default) get whole-number ticks; money does not. */
  integer?: boolean;
  className?: string;
}) {
  const [box, width] = useWidth<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);
  const descId = useId();
  const n = points.length;
  const max = points.reduce((m, p) => Math.max(m, p.value), 0);
  const sum = points.reduce((a, p) => a + p.value, 0);
  const { top, step } = niceScale(max, 4, integer);
  const plotW = Math.max(0, width - PAD.left - PAD.right);
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  const band = n ? plotW / n : 0;
  // Thin columns with at least a 2px surface gap; a single pixel when a year is squeezed in.
  const barW = band > 4 ? Math.min(28, Math.max(1, band - Math.max(2, band * 0.3))) : Math.max(0.5, band - 0.5);
  const y = (v: number) => PAD.top + plotH - (v / top) * plotH;
  const ticks = Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step);
  const maxLabels = Math.max(2, Math.floor(plotW / 64));
  const every = Math.max(1, Math.ceil(n / maxLabels));
  const at = active !== null ? points[active] : null;

  const pick = (e: PointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const i = Math.floor((e.clientX - rect.left - PAD.left) / band);
    setActive(i >= 0 && i < n ? i : null);
  };
  const keys = (e: KeyboardEvent<SVGSVGElement>) => {
    if (!n) return;
    const moves: Record<string, number> = { ArrowRight: 1, ArrowLeft: -1, Home: -n, End: n };
    const d = moves[e.key];
    if (d === undefined) return;
    e.preventDefault();
    setActive((i) => Math.min(n - 1, Math.max(0, (i ?? (d > 0 ? -1 : n)) + d)));
  };

  return (
    <div ref={box} className={cn("relative w-full", className)}>
      {width > 0 && (
        <svg
          width={width}
          height={HEIGHT}
          role="img"
          aria-label={`${label}, daily`}
          aria-describedby={descId}
          tabIndex={0}
          className="block rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
          onPointerMove={pick}
          onPointerLeave={() => setActive(null)}
          onKeyDown={keys}
          onBlur={() => setActive(null)}
        >
          {/* Recessive grid and y labels. */}
          {ticks.map((v) => (
            <g key={v}>
              <line x1={PAD.left} x2={width - PAD.right} y1={y(v)} y2={y(v)} stroke="var(--line)" strokeWidth={1} shapeRendering="crispEdges" />
              <text x={PAD.left - 8} y={y(v)} dy="0.32em" textAnchor="end" fontSize={11} fill="var(--text-3)" className="tabular-nums">
                {format(v)}
              </text>
            </g>
          ))}
          {active !== null && <rect x={PAD.left + active * band} y={PAD.top} width={band} height={plotH} fill="var(--s-3)" />}
          {points.map((p, i) => (
            <path
              key={p.date}
              d={columnPath(PAD.left + i * band + (band - barW) / 2, y(p.value), barW, y(0) - y(p.value))}
              fill="var(--accent)"
              opacity={active === null || active === i ? 1 : 0.55}
            />
          ))}
          <line x1={PAD.left} x2={width - PAD.right} y1={y(0)} y2={y(0)} stroke="var(--line-strong)" strokeWidth={1} shapeRendering="crispEdges" />
          {points.map((p, i) =>
            i % every === 0 ? (
              <text key={p.date} x={PAD.left + i * band + band / 2} y={HEIGHT - 6} textAnchor="middle" fontSize={11} fill="var(--text-3)">
                {dayLabel(p.date)}
              </text>
            ) : null,
          )}
        </svg>
      )}
      {width === 0 && <div style={{ height: HEIGHT }} />}

      {at && active !== null && (
        <div
          aria-hidden
          className="pointer-events-none absolute top-1 z-10 -translate-x-1/2 rounded-sm bg-solid px-2 py-1 text-xs whitespace-nowrap text-on-solid shadow-md"
          style={{ left: Math.min(Math.max(PAD.left + active * band + band / 2, 70), width - 70) }}
        >
          <span className="opacity-75">{dayLabel(at.date, true)}</span> · <span className="font-medium tabular-nums">{format(at.value)}</span>
        </div>
      )}
      {/* What a screen reader hears: the total, the busiest day, and the focused day as it changes. */}
      <p id={descId} className="sr-only">
        {n ? `${format(sum)} in total over ${n} days.` : "No days in range."}
        {max > 0 ? ` Highest: ${format(max)} on ${dayLabel(points.find((p) => p.value === max)!.date, true)}.` : " Nothing recorded."} Use the arrow keys to read each day.
      </p>
      <p className="sr-only" aria-live="polite">
        {at ? `${dayLabel(at.date, true)}: ${format(at.value)}` : ""}
      </p>
    </div>
  );
}
