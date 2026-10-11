"use client";

import { Tooltip as T } from "radix-ui";
import type { ReactNode } from "react";

/** Mounted once in the root providers. */
export function TooltipProvider({ children }: { children: ReactNode }) {
  return (
    <T.Provider delayDuration={350} skipDelayDuration={200}>
      {children}
    </T.Provider>
  );
}

/**
 * A hover/focus hint for a control whose meaning is not obvious. Never put
 * information here that is not available another way — touch screens never
 * see it. The child must accept a ref (any DOM element or our Button).
 */
export function Tooltip({
  content,
  children,
  side = "top",
  align = "center",
}: {
  content: ReactNode;
  children: ReactNode;
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
}) {
  if (content === null || content === undefined || content === "") return <>{children}</>;
  return (
    <T.Root>
      <T.Trigger asChild>{children}</T.Trigger>
      <T.Portal>
        <T.Content
          side={side}
          align={align}
          sideOffset={6}
          collisionPadding={8}
          className="z-[90] max-w-72 rounded-sm bg-solid px-2 py-1 text-xs text-on-solid shadow-md animate-fade-in"
        >
          {content}
        </T.Content>
      </T.Portal>
    </T.Root>
  );
}
