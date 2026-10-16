"use client";

import { useRef, type KeyboardEvent, type PointerEvent } from "react";
import { cn } from "@/lib/cn";

/**
 * A vertical drag handle on a pane's right edge: drag (or ←/→ with focus) to
 * change `width` between `min` and `max`. `onChange` fires while dragging;
 * `onCommit` once at the end (to remember it).
 */
export function ResizeHandle({
  width,
  min,
  max,
  onChange,
  onCommit,
  label,
  className,
}: {
  width: number;
  min: number;
  max: number;
  onChange: (width: number) => void;
  onCommit: (width: number) => void;
  label: string;
  className?: string;
}) {
  const drag = useRef<{ x: number; width: number; last: number } | null>(null);
  const clamp = (w: number) => Math.round(Math.min(max, Math.max(min, w)));

  const down = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, width, last: width };
  };
  const move = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    d.last = clamp(d.width + e.clientX - d.x);
    onChange(d.last);
  };
  const up = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    onCommit(d.last);
  };
  const key = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 64 : 16;
    const next = e.key === "ArrowLeft" ? width - step : e.key === "ArrowRight" ? width + step : e.key === "Home" ? min : e.key === "End" ? max : null;
    if (next === null) return;
    e.preventDefault();
    onChange(clamp(next));
    onCommit(clamp(next));
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={width}
      tabIndex={0}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      onKeyDown={key}
      onDoubleClick={() => {
        onChange(clamp(360));
        onCommit(clamp(360));
      }}
      title="Drag to resize · double-click to reset"
      className={cn(
        "group relative z-10 -mx-1 w-2 shrink-0 cursor-col-resize touch-none outline-none",
        "after:absolute after:inset-y-0 after:left-1/2 after:w-px after:-translate-x-1/2 after:bg-transparent after:transition-colors hover:after:bg-accent focus-visible:after:bg-accent",
        className,
      )}
    />
  );
}
