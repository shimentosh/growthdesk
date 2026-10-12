"use client";

import { useEffect, useRef, useState } from "react";
import { resolveTheme, type EmailBlock, type EmailTheme } from "@growthdesk/shared";
import { cn } from "@/lib/cn";
import { useWorkspace } from "@/lib/session";
import { EmailPreview } from "@/components/marketing/common";

/** The rendered email's full width (600px column + the body's 12px gutters). */
const EMAIL_WIDTH = 624;
const FRAME_HEIGHT = 1100;

/**
 * A live, scaled-down rendering of a design for gallery cards: the real
 * email in its sandboxed frame, shrunk to the card's width and cropped.
 */
export function DesignThumbnail({ blocks, theme, className }: { blocks: EmailBlock[]; theme?: EmailTheme | null; className?: string }) {
  const ws = useWorkspace();
  const box = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => setScale(el.clientWidth / EMAIL_WIDTH);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <div ref={box} aria-hidden className={cn("relative overflow-hidden", className)} style={{ background: resolveTheme(theme).background }}>
      {scale > 0 && (
        <div inert className="pointer-events-none absolute top-0 left-0 origin-top-left" style={{ width: EMAIL_WIDTH, height: FRAME_HEIGHT, transform: `scale(${scale})` }}>
          <EmailPreview blocks={blocks} theme={theme} legalName={ws.detail.profile.legalName.trim() || ws.name} postalAddress={ws.detail.profile.postalAddress.trim() || "Your postal address"} className="size-full border-0" />
        </div>
      )}
    </div>
  );
}
