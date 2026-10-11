import { isUnlimited } from "@growthdesk/shared";
import { formatNumber } from "@/lib/format";
import { cn } from "@/lib/cn";

/**
 * Usage against a limit: a thin bar plus "used / allowed". A negative
 * `max` is a plan's "unlimited" and draws no bar. The bar turns amber at 80%
 * and red at 100% unless a tone is given.
 */
export function Meter({
  value,
  max,
  label,
  showValue = true,
  tone,
  className,
}: {
  value: number;
  max: number;
  label?: string;
  showValue?: boolean;
  tone?: "accent" | "warn" | "bad" | "ok";
  className?: string;
}) {
  const unlimited = isUnlimited(max);
  const ratio = unlimited || max <= 0 ? 0 : Math.min(1, value / max);
  const auto = ratio >= 1 ? "bad" : ratio >= 0.8 ? "warn" : "accent";
  const t = tone ?? auto;
  const bar = { accent: "bg-accent", warn: "bg-warn", bad: "bg-bad", ok: "bg-ok" }[t];
  return (
    <div className={cn("flex flex-col gap-1", className)}>
      {(label || showValue) && (
        <div className="flex items-baseline justify-between gap-2 text-xs">
          {label && <span className="text-text-2">{label}</span>}
          {showValue && (
            <span className="text-text-3 tabular-nums">
              {formatNumber(value)} / {unlimited ? "Unlimited" : formatNumber(max)}
            </span>
          )}
        </div>
      )}
      {!unlimited && (
        <div
          role="progressbar"
          aria-label={label}
          aria-valuemin={0}
          aria-valuemax={max}
          aria-valuenow={value}
          className="h-1.5 w-full overflow-hidden rounded-full bg-s-4"
        >
          <div className={cn("h-full rounded-full transition-[width]", bar)} style={{ width: `${ratio * 100}%` }} />
        </div>
      )}
    </div>
  );
}
