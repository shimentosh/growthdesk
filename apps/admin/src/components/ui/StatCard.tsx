import Link from "next/link";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { IconBadge, type Tint } from "./IconTile";
import { Skeleton } from "./Skeleton";

/**
 * One figure with its label. Values come from the API — never pass a
 * placeholder number; pass `loading` until the real one arrives.
 */
export function StatCard({
  label,
  value,
  hint,
  icon,
  href,
  loading,
  tone,
  tint,
  className,
}: {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  icon?: ReactNode;
  /** Makes the card a link to the list behind the number. */
  href?: string;
  loading?: boolean;
  /** Colours the value when the number itself is a warning (e.g. overdue > 0). */
  tone?: "warn" | "bad" | "ok";
  /** Shows the icon in a soft circle of this system colour instead of plain grey. */
  tint?: Tint;
  className?: string;
}) {
  const body = (
    <>
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-text-3">{label}</span>
        {icon && (tint ? <IconBadge icon={icon} tint={tint} className="-my-1" /> : <span aria-hidden className="text-text-3 [&_svg]:size-4">{icon}</span>)}
      </div>
      {loading ? (
        <Skeleton className="mt-2 h-7 w-20" />
      ) : (
        <div
          className={cn(
            "mt-1.5 text-2xl font-semibold tracking-[-0.025em] tabular-nums",
            tone === "warn" ? "text-warn-ink" : tone === "bad" ? "text-bad-ink" : tone === "ok" ? "text-ok-ink" : "text-text-hi",
          )}
        >
          {value}
        </div>
      )}
      {hint && <div className="mt-0.5 text-xs text-text-3">{hint}</div>}
    </>
  );
  const cls = cn(
    "block min-w-0 rounded-xl border border-line bg-panel px-4 py-3.5 shadow-card",
    href && "transition-[border-color,box-shadow,transform] hover:border-line-strong hover:shadow-md active:scale-[0.995]",
    className,
  );
  return href ? (
    <Link href={href} className={cls}>
      {body}
    </Link>
  ) : (
    <div className={cls}>{body}</div>
  );
}
