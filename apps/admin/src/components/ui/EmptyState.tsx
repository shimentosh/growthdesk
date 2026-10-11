import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { IconTile, type Tint } from "./IconTile";

/**
 * What a list or section shows when it has nothing in it: an icon, a title
 * that says what is missing, one sentence on why it matters or how to start,
 * and usually the action that fixes it.
 */
export function EmptyState({
  icon,
  title,
  description,
  action,
  compact,
  tint,
  className,
}: {
  /** A lucide icon element, e.g. <Users />. */
  icon?: ReactNode;
  /** Shows the icon on a coloured tile (see ENTITY in ./icons for each screen's colour). */
  tint?: Tint;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  /** Less padding — for empty states inside cards and tables. */
  compact?: boolean;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col items-center justify-center text-center", compact ? "gap-2 px-4 py-8" : "gap-3 px-6 py-16", className)}>
      {icon &&
        (tint ? (
          <IconTile icon={icon} tint={tint} size={compact ? "md" : "xl"} className={compact ? undefined : "mb-1"} />
        ) : (
          <div aria-hidden className="flex size-11 items-center justify-center rounded-full bg-s-3 text-text-3 [&_svg]:size-5">
            {icon}
          </div>
        ))}
      <div className="max-w-sm">
        <h3 className={cn("font-semibold text-text-hi", compact ? "text-sm" : "text-base tracking-[-0.01em]")}>{title}</h3>
        {description && <p className="mt-1 text-xs text-text-3">{description}</p>}
      </div>
      {action && <div className="mt-1 flex flex-wrap items-center justify-center gap-2">{action}</div>}
    </div>
  );
}
