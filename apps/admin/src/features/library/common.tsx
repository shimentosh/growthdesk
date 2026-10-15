"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { renderLibraryPreview, resolveTheme, type EmailBlock, type EmailTheme } from "@growthdesk/shared";
import { Badge } from "@/components/ui/Badge";
import { cn } from "@/lib/cn";
import type { LibraryDesign } from "./types";

/* Pieces the template library screens share: the status chip and the scaled email preview. */

/** The rendered email's full width (600px column + the body's 12px gutters). */
const EMAIL_WIDTH = 624;

export function LibraryStatusBadge({ status }: { status: LibraryDesign["status"] }) {
  return status === "published" ? (
    <Badge tone="ok" dot title="Offered to every workspace in its template gallery">
      Published
    </Badge>
  ) : (
    <Badge tone="mute" dot title="Only platform staff see it">
      Draft
    </Badge>
  );
}

/**
 * The email exactly as a workspace's preview shows it (shared renderer,
 * sample contact, placeholder footer) in a sandboxed frame, scaled to the
 * box's width. `height` is the frame's natural height before scaling.
 */
export function LibraryPreview({ blocks, theme, height = 1100, className }: { blocks: EmailBlock[]; theme?: EmailTheme | null; height?: number; className?: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0);
  const html = useMemo(() => renderLibraryPreview(blocks, theme).html, [blocks, theme]);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => setScale(Math.min(1, el.clientWidth / EMAIL_WIDTH));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <div ref={box} className={cn("relative overflow-hidden", className)} style={{ background: resolveTheme(theme).background }}>
      {scale > 0 && (
        <div className="pointer-events-none absolute top-0 left-1/2 origin-top" style={{ width: EMAIL_WIDTH, height, transform: `translateX(-50%) scale(${scale})` }}>
          <iframe title="Email preview" sandbox="" srcDoc={html} tabIndex={-1} className="size-full border-0" />
        </div>
      )}
    </div>
  );
}
