import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

const WIDTHS = {
  /** Tables and boards: use the whole window. */
  full: "",
  /** Dashboards and reports: figures read better in a frame. */
  capped: "max-w-[1400px]",
  /** Settings forms, a record's single column, a template body. */
  narrow: "max-w-[820px]",
} as const;

/** The page frame every screen inside the app renders first: gutters and an optional max width. */
export function Page({ width = "full", className, children }: { width?: keyof typeof WIDTHS; className?: string; children: ReactNode }) {
  return <div className={cn("mx-auto w-full px-4 py-5 nav:px-6 nav:py-6", WIDTHS[width], className)}>{children}</div>;
}

/** Title row of a page: optional back link, icon, title, one-line description, actions on the right. */
export function PageHeader({
  title,
  description,
  actions,
  back,
  meta,
  icon,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  back?: { href: string; label: string };
  /** Small things beside the title (a status badge). */
  meta?: ReactNode;
  /** The screen's tile, e.g. <EntityTile of="contacts" /> (components/ui/icons). */
  icon?: ReactNode;
  className?: string;
}) {
  return (
    <header className={cn("mb-6 flex flex-wrap items-start justify-between gap-x-4 gap-y-3", className)}>
      {/* Takes the free width so a long description wraps beside the actions; drops below them only on narrow screens. */}
      <div className="min-w-[min(100%,20rem)] flex-1">
        {back && (
          <Link href={back.href} className="mb-2 inline-flex items-center gap-0.5 rounded-xs text-xs font-medium text-accent-ink hover:text-accent-hi">
            <ChevronLeft aria-hidden className="size-3.5" />
            {back.label}
          </Link>
        )}
        <div className="flex items-center gap-3">
          {icon && <div className="shrink-0">{icon}</div>}
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-2xl font-semibold tracking-[-0.022em] text-text-hi">{title}</h1>
              {meta}
            </div>
            {description && <p className="max-w-2xl text-sm text-text-3">{description}</p>}
          </div>
        </div>
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

/** A titled block within a page (settings sections, record panels). */
export function Section({
  title,
  description,
  actions,
  icon,
  className,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  /** A bare lucide glyph shown before the title, e.g. <Send />. */
  icon?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={cn("flex flex-col gap-3", className)}>
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div className="min-w-0">
          <h2 className="flex items-center gap-1.5 text-base font-semibold tracking-[-0.01em] text-text-hi">
            {icon && <span aria-hidden className="text-text-3 [&_svg]:size-4">{icon}</span>}
            {title}
          </h2>
          {description && <p className="mt-0.5 text-xs text-text-3">{description}</p>}
        </div>
        {actions && <div className="flex items-center gap-2">{actions}</div>}
      </div>
      {children}
    </section>
  );
}
