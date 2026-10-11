import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/cn";

/** A content pane: white (lifted in dark) on the grey ground, hairline, soft shadow, large radius. */
export function Card({ className, children, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div {...rest} className={cn("min-w-0 rounded-xl border border-line bg-panel shadow-card", className)}>
      {children}
    </div>
  );
}

/** Alias of Card, for panes that are a page region rather than an item. */
export const Panel = Card;

export function CardHeader({
  title,
  description,
  actions,
  icon,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  /** A bare lucide glyph (<Send />) or a small tile (<EntityTile of="deals" size="sm" />) before the title. */
  icon?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-wrap items-start justify-between gap-3 border-b border-line px-4 py-3", className)}>
      <div className="flex min-w-0 items-start gap-2.5">
        {icon && <span aria-hidden className="mt-0.5 flex shrink-0 text-text-2 [&>svg]:size-4">{icon}</span>}
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-text-hi">{title}</h2>
          {description && <p className="mt-0.5 text-xs text-text-3">{description}</p>}
        </div>
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

export function CardBody({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn("p-4", className)}>{children}</div>;
}

/** Footer on the recessed "well" ground, actions right-aligned — the save row of a settings card. */
export function CardFooter({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn("flex flex-wrap items-center justify-end gap-2 rounded-b-xl border-t border-line bg-well px-4 py-3", className)}>{children}</div>;
}
