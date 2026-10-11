"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { cn } from "@/lib/cn";

/*
 * Revenue charts in plain SVG (no chart library), in the manner of the
 * customer app's analytics/DailyChart.tsx: theme tokens for colour (so light
 * and dark follow the app), hover or focus + ←/→ to read each point, and a
 * screen-reader summary. Every figure drawn here is also printed elsewhere on
 * the page (tiles, tables), so nothing is available only by pointer or colour.
 */

const HEIGHT = 220;
const PAD = { top: 12, right: 12, bottom: 24, left: 56 };
const DAY_MS = 86_400_000;

const SHORT = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const LONG = new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
/** "Oct 9" / "Fri, Oct 9, 2026" for a UTC day "2026-10-09". */
export const dayLabel = (day: string, long = false) => (long ? LONG : SHORT).format(new Date(`${day}T12:00:00Z`));
const epochDay = (day: string) => Math.round(Date.parse(`${day}T00:00:00Z`) / DAY_MS);

/** A round axis maximum and step: 0, step, 2·step … ≥ max, with steps of 1/2/2.5/5 × 10ⁿ (whole units). */
export function niceScale(max: number, ticks = 4): { top: number; step: number } {
  if (!(max > 0)) return { top: ticks, step: 1 };
  const raw = max / ticks;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = Math.max(1, Math.ceil([1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag));
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

function Readout({ left, width, children }: { left: number; width: number; children: ReactNode }) {
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute top-1 z-10 -translate-x-1/2 rounded-sm bg-solid px-2 py-1 text-xs whitespace-nowrap text-on-solid shadow-md"
      style={{ left: Math.min(Math.max(left, 80), width - 80) }}
    >
      {children}
    </div>
  );
}

function YGrid({ ticks, y, width, format }: { ticks: number[]; y: (v: number) => number; width: number; format: (v: number) => string }) {
  return (
    <>
      {ticks.map((v) => (
        <g key={v}>
          <line x1={PAD.left} x2={width - PAD.right} y1={y(v)} y2={y(v)} stroke="var(--line)" strokeWidth={1} shapeRendering="crispEdges" />
          <text x={PAD.left - 8} y={y(v)} dy="0.32em" textAnchor="end" fontSize={11} fill="var(--text-3)" className="tabular-nums">
            {format(v)}
          </text>
        </g>
      ))}
    </>
  );
}

const arrowStep = (e: KeyboardEvent, n: number, set: (fn: (i: number | null) => number | null) => void) => {
  const moves: Record<string, number> = { ArrowRight: 1, ArrowLeft: -1, Home: -n, End: n };
  const d = moves[e.key];
  if (d === undefined || !n) return;
  e.preventDefault();
  set((i) => Math.min(n - 1, Math.max(0, (i ?? (d > 0 ? -1 : n)) + d)));
};

export type LinePoint = { day: string; value: number };

/**
 * A daily line over [from, to]. Days without a point are gaps in the line,
 * not zeros — a missing snapshot is not a day with no revenue.
 */
export function DailyLineChart({
  points,
  from,
  to,
  label,
  format,
  formatAxis = format,
  className,
}: {
  points: LinePoint[];
  from: string;
  to: string;
  /** The series' accessible name ("MRR"). */
  label: string;
  format: (value: number) => string;
  formatAxis?: (value: number) => string;
  className?: string;
}) {
  const [box, width] = useWidth<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);
  const descId = useId();
  const gradId = useId();
  const n = points.length;
  const start = epochDay(from);
  const span = Math.max(1, epochDay(to) - start);
  const max = points.reduce((m, p) => Math.max(m, p.value), 0);
  const { top, step } = niceScale(max);
  const plotW = Math.max(0, width - PAD.left - PAD.right);
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  const x = (day: string) => PAD.left + ((epochDay(day) - start) / span) * plotW;
  const y = (v: number) => PAD.top + plotH - (v / top) * plotH;
  const ticks = Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step);

  // Consecutive days join into one segment; a gap starts a new one.
  const segments: LinePoint[][] = [];
  points.forEach((p, i) => {
    const prev = points[i - 1];
    if (prev && epochDay(p.day) - epochDay(prev.day) === 1) segments.at(-1)!.push(p);
    else segments.push([p]);
  });
  const line = (s: LinePoint[]) => s.map((p, i) => `${i ? "L" : "M"}${x(p.day)},${y(p.value)}`).join("");
  const area = (s: LinePoint[]) => `${line(s)}L${x(s.at(-1)!.day)},${y(0)}L${x(s[0]!.day)},${y(0)}Z`;

  const labelCount = Math.max(2, Math.floor(plotW / 72));
  const every = Math.max(1, Math.ceil((span + 1) / labelCount));
  const xLabels = Array.from({ length: Math.floor(span / every) + 1 }, (_, i) => new Date((start + i * every) * DAY_MS).toISOString().slice(0, 10));
  const at = active !== null ? points[active] : null;
  // Dots only where they have room (≥ 9px per day); otherwise just the line and the active point.
  const showDots = n <= 45 && plotW / span >= 9;

  const pick = (e: PointerEvent<SVGSVGElement>) => {
    if (!n) return;
    const px = e.clientX - e.currentTarget.getBoundingClientRect().left;
    let best = 0;
    points.forEach((p, i) => {
      if (Math.abs(x(p.day) - px) < Math.abs(x(points[best]!.day) - px)) best = i;
    });
    setActive(best);
  };

  return (
    <div ref={box} className={cn("relative w-full", className)}>
      {width > 0 ? (
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
          onKeyDown={(e) => arrowStep(e, n, setActive)}
          onBlur={() => setActive(null)}
        >
          <defs>
            <linearGradient id={gradId} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor="var(--accent)" stopOpacity={0.18} />
              <stop offset="100%" stopColor="var(--accent)" stopOpacity={0} />
            </linearGradient>
          </defs>
          <YGrid ticks={ticks} y={y} width={width} format={formatAxis} />
          {segments.map((s) => (s.length > 1 ? <path key={`a${s[0]!.day}`} d={area(s)} fill={`url(#${gradId})`} /> : null))}
          {segments.map((s) =>
            s.length > 1 ? <path key={`l${s[0]!.day}`} d={line(s)} fill="none" stroke="var(--accent)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" /> : null,
          )}
          {at && <line x1={x(at.day)} x2={x(at.day)} y1={PAD.top} y2={y(0)} stroke="var(--line-strong)" strokeWidth={1} />}
          {points.map((p, i) =>
            showDots || active === i || segments.some((s) => s.length === 1 && s[0] === p) ? (
              <circle key={p.day} cx={x(p.day)} cy={y(p.value)} r={active === i ? 4.5 : 3} fill="var(--panel)" stroke="var(--accent)" strokeWidth={2} />
            ) : null,
          )}
          <line x1={PAD.left} x2={width - PAD.right} y1={y(0)} y2={y(0)} stroke="var(--line-strong)" strokeWidth={1} shapeRendering="crispEdges" />
          {xLabels.map((d, i) => (
            <text
              key={d}
              x={x(d)}
              y={HEIGHT - 6}
              textAnchor={i === 0 ? "start" : "middle"}
              fontSize={11}
              fill="var(--text-3)"
            >
              {dayLabel(d)}
            </text>
          ))}
        </svg>
      ) : (
        <div style={{ height: HEIGHT }} />
      )}
      {at && active !== null && (
        <Readout left={x(at.day)} width={width}>
          <span className="opacity-75">{dayLabel(at.day, true)}</span> · <span className="font-medium tabular-nums">{format(at.value)}</span>
        </Readout>
      )}
      <p id={descId} className="sr-only">
        {n
          ? `${n} daily snapshots from ${dayLabel(points[0]!.day, true)} to ${dayLabel(points.at(-1)!.day, true)}. Latest: ${format(points.at(-1)!.value)}. Highest: ${format(max)}.`
          : "No snapshots in this range."}{" "}
        Use the arrow keys to read each snapshot.
      </p>
      <p className="sr-only" aria-live="polite">
        {at ? `${dayLabel(at.day, true)}: ${format(at.value)}` : ""}
      </p>
    </div>
  );
}

/** A column with a 3px rounded top, square on the baseline. */
function columnPath(x: number, y: number, w: number, h: number): string {
  if (h <= 0) return "";
  const r = Math.min(3, w / 2, h);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

export type ColumnPoint = { key: string; label: string; long: string; value: number; note?: string };

/** One column per point (months of collected revenue). */
export function ColumnChart({ points, label, format, formatAxis = format, className }: { points: ColumnPoint[]; label: string; format: (v: number) => string; formatAxis?: (v: number) => string; className?: string }) {
  const [box, width] = useWidth<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);
  const descId = useId();
  const n = points.length;
  const max = points.reduce((m, p) => Math.max(m, p.value), 0);
  const sum = points.reduce((a, p) => a + p.value, 0);
  const { top, step } = niceScale(max);
  const plotW = Math.max(0, width - PAD.left - PAD.right);
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  const band = n ? plotW / n : 0;
  const barW = Math.min(36, Math.max(2, band * 0.62));
  const y = (v: number) => PAD.top + plotH - (v / top) * plotH;
  const ticks = Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step);
  const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(plotW / 44))));
  const at = active !== null ? points[active] : null;

  return (
    <div ref={box} className={cn("relative w-full", className)}>
      {width > 0 ? (
        <svg
          width={width}
          height={HEIGHT}
          role="img"
          aria-label={label}
          aria-describedby={descId}
          tabIndex={0}
          className="block rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
          onPointerMove={(e) => {
            const i = Math.floor((e.clientX - e.currentTarget.getBoundingClientRect().left - PAD.left) / band);
            setActive(i >= 0 && i < n ? i : null);
          }}
          onPointerLeave={() => setActive(null)}
          onKeyDown={(e) => arrowStep(e, n, setActive)}
          onBlur={() => setActive(null)}
        >
          <YGrid ticks={ticks} y={y} width={width} format={formatAxis} />
          {active !== null && <rect x={PAD.left + active * band} y={PAD.top} width={band} height={plotH} fill="var(--s-3)" />}
          {points.map((p, i) => (
            <path
              key={p.key}
              d={columnPath(PAD.left + i * band + (band - barW) / 2, y(p.value), barW, y(0) - y(p.value))}
              fill="var(--ok)"
              opacity={active === null || active === i ? 1 : 0.55}
            />
          ))}
          <line x1={PAD.left} x2={width - PAD.right} y1={y(0)} y2={y(0)} stroke="var(--line-strong)" strokeWidth={1} shapeRendering="crispEdges" />
          {points.map((p, i) =>
            i % every === 0 ? (
              <text key={p.key} x={PAD.left + i * band + band / 2} y={HEIGHT - 6} textAnchor="middle" fontSize={11} fill="var(--text-3)">
                {p.label}
              </text>
            ) : null,
          )}
        </svg>
      ) : (
        <div style={{ height: HEIGHT }} />
      )}
      {at && active !== null && (
        <Readout left={PAD.left + active * band + band / 2} width={width}>
          <span className="opacity-75">{at.long}</span> · <span className="font-medium tabular-nums">{format(at.value)}</span>
          {at.note && <span className="opacity-75"> · {at.note}</span>}
        </Readout>
      )}
      <p id={descId} className="sr-only">
        {`${format(sum)} in total over ${n} months.`} {max > 0 ? `Highest: ${format(max)} in ${points.find((p) => p.value === max)!.long}.` : "Nothing collected."} Use the arrow keys to read each month.
      </p>
      <p className="sr-only" aria-live="polite">
        {at ? `${at.long}: ${format(at.value)}${at.note ? `, ${at.note}` : ""}` : ""}
      </p>
    </div>
  );
}
