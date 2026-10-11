"use client";

import { Dialog as D } from "radix-ui";
import { X } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

const WIDTHS = { sm: "max-w-[380px]", md: "max-w-[480px]", lg: "max-w-[640px]", xl: "max-w-[820px]" } as const;

export type DrawerProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  /** A tile before the title, e.g. <EntityTile of="tasks" size="md" />. */
  icon?: ReactNode;
  description?: ReactNode;
  /** Buttons in the header, left of the close mark (e.g. "Open full record"). */
  actions?: ReactNode;
  footer?: ReactNode;
  width?: keyof typeof WIDTHS;
  side?: "right" | "left";
  /** Keep the page behind interactive-looking but inert (default) — set false for a non-modal side panel. */
  modal?: boolean;
  className?: string;
  children?: ReactNode;
};

/** A side sheet — record previews from a table, quick edits. Full height, scrolling body. */
export function Drawer({ open, onOpenChange, title, icon, description, actions, footer, width = "md", side = "right", modal = true, className, children }: DrawerProps) {
  return (
    <D.Root open={open} onOpenChange={onOpenChange} modal={modal}>
      <D.Portal>
        {modal && <D.Overlay className="fixed inset-0 z-50 bg-scrim animate-fade-in" />}
        <D.Content
          {...(description ? {} : { "aria-describedby": undefined })}
          className={cn(
            "fixed inset-y-0 z-50 flex w-full flex-col border-line-strong bg-popover shadow-sheet",
            side === "right" ? "right-0 border-l animate-slide-in-right" : "left-0 border-r animate-slide-in-left",
            WIDTHS[width],
            className,
          )}
        >
          <div className="flex shrink-0 items-start gap-3 border-b border-line px-5 py-3.5">
            {icon && <div className="shrink-0">{icon}</div>}
            <div className="min-w-0 flex-1">
              <D.Title className="truncate text-base font-semibold text-text-hi">{title}</D.Title>
              {description && <D.Description className="mt-0.5 text-xs text-text-3">{description}</D.Description>}
            </div>
            {actions && <div className="flex shrink-0 items-center gap-1.5">{actions}</div>}
            <D.Close aria-label="Close" className="-mr-1.5 rounded-sm p-1 text-text-3 hover:bg-hover hover:text-text">
              <X aria-hidden className="size-4" />
            </D.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
          {footer && <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-line bg-well px-5 py-3">{footer}</div>}
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}
