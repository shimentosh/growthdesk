import { CircleAlert, CircleCheck, Info, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export type CalloutTone = "info" | "ok" | "warn" | "bad";

const TONES: Record<CalloutTone, { box: string; ink: string; Icon: typeof Info }> = {
  info: { box: "border-info-edge bg-info-wash", ink: "text-accent-ink", Icon: Info },
  ok: { box: "border-ok-edge bg-ok-wash", ink: "text-ok-ink", Icon: CircleCheck },
  warn: { box: "border-warn-edge bg-warn-wash", ink: "text-warn-ink", Icon: TriangleAlert },
  bad: { box: "border-bad-edge bg-bad-wash", ink: "text-bad-ink", Icon: CircleAlert },
};

/** An inline notice: a tinted box with an icon, an optional title and an optional action. */
export function Callout({
  tone = "info",
  title,
  children,
  action,
  className,
}: {
  tone?: CalloutTone;
  title?: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  const t = TONES[tone];
  return (
    <div role={tone === "bad" ? "alert" : undefined} className={cn("flex items-start gap-2.5 rounded-md border px-3 py-2.5 text-sm", t.box, className)}>
      <t.Icon aria-hidden className={cn("mt-0.5 size-4 shrink-0", t.ink)} />
      <div className="min-w-0 flex-1">
        {title && <div className={cn("font-medium", t.ink)}>{title}</div>}
        {children && <div className={cn("text-text-2", title && "mt-0.5 text-xs")}>{children}</div>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}
