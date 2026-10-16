"use client";

import { useEffect, useRef, type PointerEvent } from "react";
import { Eraser } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";

/** Ink and paper are fixed (not theme colours): the PNG must read the same on the document in light, dark and print. */
const INK = "#111827";
const PAPER = "#ffffff";

/** Sizes the canvas to its box at the device's pixel ratio and fills it with paper. */
function paper(el: HTMLCanvasElement) {
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  const { width, height } = el.getBoundingClientRect();
  el.width = Math.round(width * ratio);
  el.height = Math.round(height * ratio);
  const ctx = el.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, width, height);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.lineWidth = 2.2;
  ctx.strokeStyle = INK;
}

/**
 * Draw a signature with a mouse, finger or pen. Reports a PNG data URL after
 * each stroke, or null once cleared. The canvas is drawn at the device's
 * pixel ratio so the signature stays crisp when printed.
 */
export function SignaturePad({ onChange, disabled, className }: { onChange: (dataUrl: string | null) => void; disabled?: boolean; className?: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const inked = useRef(false);

  const reset = () => {
    if (canvas.current) paper(canvas.current);
    inked.current = false;
  };

  useEffect(() => {
    if (canvas.current) paper(canvas.current);
  }, []);

  const point = (e: PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const down = (e: PointerEvent<HTMLCanvasElement>) => {
    if (disabled) return;
    const ctx = e.currentTarget.getContext("2d");
    if (!ctx) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drawing.current = true;
    const p = point(e);
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    // A dot for a tap.
    ctx.lineTo(p.x + 0.01, p.y + 0.01);
    ctx.stroke();
  };

  const move = (e: PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current) return;
    const ctx = e.currentTarget.getContext("2d");
    if (!ctx) return;
    const p = point(e);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    inked.current = true;
  };

  const up = () => {
    if (!drawing.current) return;
    drawing.current = false;
    if (inked.current && canvas.current) onChange(canvas.current.toDataURL("image/png"));
  };

  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <canvas
        ref={canvas}
        aria-label="Signature pad: draw your signature"
        role="img"
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
        onPointerLeave={up}
        style={{ background: PAPER, touchAction: "none" }}
        className={cn("h-36 w-full cursor-crosshair rounded-md border border-line-strong", disabled && "cursor-not-allowed opacity-60")}
      />
      <div className="flex items-center justify-between text-xs text-text-3">
        <span>Sign inside the box.</span>
        <Button
          size="sm"
          variant="ghost"
          icon={<Eraser />}
          disabled={disabled}
          onClick={() => {
            reset();
            onChange(null);
          }}
        >
          Clear
        </Button>
      </div>
    </div>
  );
}
