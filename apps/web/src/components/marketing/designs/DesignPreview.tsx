"use client";

import { useEffect, useRef, useState } from "react";
import { Eye, Monitor, Smartphone } from "lucide-react";
import { resolveTheme, type EmailBlock, type EmailTheme } from "@growthdesk/shared";
import { Card, CardHeader } from "@/components/ui/Card";
import { EmailPreview, PREVIEW_VARS } from "@/components/marketing/common";
import { Choice } from "@/components/marketing/designs/controls";
import { cn } from "@/lib/cn";
import { useWorkspace } from "@/lib/session";

/** The rendered email's natural width (600px column + the body's 12px gutters). */
const DESKTOP = 624;
const MOBILE = 375;

type Device = "desktop" | "mobile";

/**
 * The live preview beside the block editor: the exact email (shared
 * renderEmail, sample contact, the company profile's footer) at desktop
 * width, scaled down to fit when the column is narrower, or at phone width.
 */
export function DesignPreview({ blocks, theme, preheader, className }: { blocks: EmailBlock[]; theme?: EmailTheme | null; preheader?: string; className?: string }) {
  const ws = useWorkspace();
  const [device, setDevice] = useState<Device>("desktop");
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const profile = ws.detail.profile;
  const mobile = device === "mobile";
  // The phone sits in the well with 16px around it and a 5px bezel.
  const gutter = mobile ? 32 : 0;
  const bezel = mobile ? 10 : 0;
  const natural = (mobile ? MOBILE : DESKTOP) + bezel;
  const scale = size ? Math.min(1, Math.max(size.w - gutter, 1) / natural) : 1;
  // Desktop fills a wide column; otherwise the email keeps its natural width and shrinks to fit.
  const width = !mobile && scale === 1 && size ? size.w : natural;
  const height = size ? (size.h - gutter) / scale : 0;
  const page = resolveTheme(theme).background;

  return (
    <Card className={cn("flex flex-col overflow-hidden", className)}>
      <CardHeader
        icon={<Eye />}
        title="Preview"
        description={`Exactly as sent, with ${PREVIEW_VARS.full_name} as the sample contact.`}
        actions={
          <Choice<Device>
            aria-label="Preview width"
            value={device}
            onChange={setDevice}
            options={[
              { value: "desktop", label: "Desktop", icon: <Monitor />, iconOnly: true },
              { value: "mobile", label: "Mobile", icon: <Smartphone />, iconOnly: true },
            ]}
          />
        }
      />
      <div ref={box} className={cn("relative min-h-0 flex-1 overflow-hidden", mobile && "bg-well")} style={mobile ? undefined : { background: page }}>
        {size && (
          <div
            className={cn("absolute left-1/2 origin-top", mobile ? "top-4 overflow-hidden rounded-[26px] border-[5px] border-s-5 shadow-card" : "top-0")}
            style={{ width, height, transform: `translateX(-50%) scale(${scale})` }}
          >
            <EmailPreview
              blocks={blocks}
              theme={theme}
              preheader={preheader}
              legalName={profile.legalName.trim() || ws.name}
              postalAddress={profile.postalAddress.trim() || "Your postal address"}
              className="block size-full border-0"
            />
          </div>
        )}
      </div>
    </Card>
  );
}
