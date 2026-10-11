import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/** A keyboard key: <Kbd>⌘</Kbd><Kbd>K</Kbd>. */
export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        "inline-flex h-5 min-w-5 items-center justify-center rounded-xs border border-line-strong bg-ctl-face px-1 font-mono text-2xs font-medium text-text-2",
        className,
      )}
    >
      {children}
    </kbd>
  );
}
