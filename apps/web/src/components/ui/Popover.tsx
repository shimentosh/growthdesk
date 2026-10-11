"use client";

import { Popover as P } from "radix-ui";
import type { ComponentProps } from "react";
import { cn } from "@/lib/cn";

/*
 *   <Popover>
 *     <PopoverTrigger asChild><Button>Filters</Button></PopoverTrigger>
 *     <PopoverContent align="start">…</PopoverContent>
 *   </Popover>
 */
export const Popover = P.Root;
export const PopoverTrigger = P.Trigger;
export const PopoverAnchor = P.Anchor;
export const PopoverClose = P.Close;

export function PopoverContent({ className, sideOffset = 6, align = "center", ...rest }: ComponentProps<typeof P.Content>) {
  return (
    <P.Portal>
      <P.Content
        sideOffset={sideOffset}
        align={align}
        collisionPadding={8}
        {...rest}
        className={cn("z-[70] rounded-lg border border-line-strong bg-popover p-3 shadow-lg outline-none animate-pop-in", className)}
      />
    </P.Portal>
  );
}
