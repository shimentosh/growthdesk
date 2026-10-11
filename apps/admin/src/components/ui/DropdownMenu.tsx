"use client";

import { DropdownMenu as M } from "radix-ui";
import { Check, Circle } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/cn";

/*
 * Menus (Radix): arrow keys, type-ahead, Escape, focus returns to the trigger.
 *
 *   <DropdownMenu>
 *     <DropdownMenuTrigger asChild><IconButton label="More" icon={<Ellipsis />} /></DropdownMenuTrigger>
 *     <DropdownMenuContent align="end">
 *       <DropdownMenuItem icon={<Pencil />} onSelect={edit}>Edit</DropdownMenuItem>
 *       <DropdownMenuSeparator />
 *       <DropdownMenuItem danger icon={<Trash />} onSelect={() => setConfirm(true)}>Delete</DropdownMenuItem>
 *     </DropdownMenuContent>
 *   </DropdownMenu>
 */

export const DropdownMenu = M.Root;
export const DropdownMenuTrigger = M.Trigger;
export const DropdownMenuGroup = M.Group;
export const DropdownMenuSub = M.Sub;

const ITEM =
  "relative flex h-8 cursor-default items-center gap-2 rounded-xs px-2 text-sm text-text outline-none select-none " +
  "data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[highlighted]:bg-hover " +
  // An IconTile keeps its own white glyph and size.
  "[&_svg:not([data-icon-tile]_svg)]:size-4 [&_svg]:shrink-0 [&_svg:not([data-icon-tile]_svg)]:text-text-3";

export function DropdownMenuContent({ className, sideOffset = 4, children, ...rest }: ComponentProps<typeof M.Content>) {
  return (
    <M.Portal>
      <M.Content
        sideOffset={sideOffset}
        collisionPadding={8}
        {...rest}
        className={cn("z-[70] min-w-48 overflow-hidden rounded-md border border-line-strong bg-popover p-1 shadow-lg animate-pop-in", className)}
      >
        {children}
      </M.Content>
    </M.Portal>
  );
}

export function DropdownMenuItem({
  icon,
  shortcut,
  danger,
  className,
  children,
  ...rest
}: ComponentProps<typeof M.Item> & { icon?: ReactNode; shortcut?: ReactNode; danger?: boolean }) {
  return (
    <M.Item {...rest} className={cn(ITEM, danger && "text-bad data-[highlighted]:bg-bad/10 [&_svg:not([data-icon-tile]_svg)]:text-bad", className)}>
      {icon}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {shortcut && <span className="ml-auto pl-3 text-2xs text-text-3">{shortcut}</span>}
    </M.Item>
  );
}

export function DropdownMenuCheckboxItem({ className, children, ...rest }: ComponentProps<typeof M.CheckboxItem>) {
  return (
    <M.CheckboxItem {...rest} className={cn(ITEM, "pl-7", className)}>
      <M.ItemIndicator className="absolute left-2 inline-flex">
        <Check aria-hidden className="!size-3.5 !text-accent" />
      </M.ItemIndicator>
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </M.CheckboxItem>
  );
}

export const DropdownMenuRadioGroup = M.RadioGroup;

export function DropdownMenuRadioItem({ className, children, ...rest }: ComponentProps<typeof M.RadioItem>) {
  return (
    <M.RadioItem {...rest} className={cn(ITEM, "pl-7", className)}>
      <M.ItemIndicator className="absolute left-2.5 inline-flex">
        <Circle aria-hidden className="!size-2 fill-current !text-accent" />
      </M.ItemIndicator>
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </M.RadioItem>
  );
}

export function DropdownMenuLabel({ className, ...rest }: ComponentProps<typeof M.Label>) {
  return <M.Label {...rest} className={cn("px-2 pt-1.5 pb-1 text-2xs font-semibold tracking-wide text-text-3 uppercase", className)} />;
}

export function DropdownMenuSeparator({ className, ...rest }: ComponentProps<typeof M.Separator>) {
  return <M.Separator {...rest} className={cn("-mx-1 my-1 h-px bg-line", className)} />;
}

export function DropdownMenuSubTrigger({ className, children, icon, ...rest }: ComponentProps<typeof M.SubTrigger> & { icon?: ReactNode }) {
  return (
    <M.SubTrigger {...rest} className={cn(ITEM, "data-[state=open]:bg-hover", className)}>
      {icon}
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </M.SubTrigger>
  );
}

export function DropdownMenuSubContent({ className, ...rest }: ComponentProps<typeof M.SubContent>) {
  return (
    <M.Portal>
      <M.SubContent {...rest} className={cn("z-[70] min-w-40 rounded-md border border-line-strong bg-popover p-1 shadow-lg animate-pop-in", className)} />
    </M.Portal>
  );
}
