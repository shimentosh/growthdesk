"use client";

import { Select as S } from "radix-ui";
import { Check, ChevronDown } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { useFieldControl } from "./Field";
import { controlClass } from "./Input";

export type SelectOption<V extends string = string> = { value: V; label: ReactNode; disabled?: boolean; description?: ReactNode };

export type SelectProps<V extends string = string> = {
  value: V | undefined;
  onValueChange: (value: V) => void;
  options: SelectOption<V>[];
  placeholder?: string;
  disabled?: boolean;
  size?: "sm" | "md";
  invalid?: boolean;
  id?: string;
  name?: string;
  "aria-label"?: string;
  className?: string;
};

/**
 * A styled single-select (Radix). Keyboard: arrows, type-ahead, Enter.
 * Radix forbids "" as an item value — model "none" as a real value such as
 * "none" or use NativeSelect with a placeholder.
 */
export function Select<V extends string = string>({
  value,
  onValueChange,
  options,
  placeholder = "Choose…",
  disabled,
  size = "md",
  invalid,
  id,
  name,
  className,
  ...aria
}: SelectProps<V>) {
  const field = useFieldControl({ id, invalid });
  return (
    <S.Root value={value} onValueChange={(v) => onValueChange(v as V)} disabled={disabled} name={name}>
      <S.Trigger
        {...field}
        aria-label={aria["aria-label"]}
        className={cn(
          controlClass,
          "inline-flex items-center justify-between gap-2 text-left data-[placeholder]:text-text-3",
          size === "md" ? "h-8 px-2.5" : "h-7 px-2 text-xs",
          className,
        )}
      >
        <span className="truncate">
          <S.Value placeholder={placeholder} />
        </span>
        <S.Icon>
          <ChevronDown aria-hidden className="size-3.5 shrink-0 text-text-3" />
        </S.Icon>
      </S.Trigger>
      <S.Portal>
        <S.Content
          position="popper"
          sideOffset={4}
          className="z-[70] max-h-[min(360px,var(--radix-select-content-available-height))] min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-md border border-line-strong bg-popover shadow-lg animate-pop-in"
        >
          <S.Viewport className="p-1">
            {options.map((o) => (
              <S.Item
                key={o.value}
                value={o.value}
                disabled={o.disabled}
                className="relative flex cursor-default items-start gap-2 rounded-xs py-1.5 pr-2 pl-7 text-sm text-text outline-none select-none data-[disabled]:opacity-50 data-[highlighted]:bg-hover"
              >
                <S.ItemIndicator className="absolute top-2 left-2">
                  <Check aria-hidden className="size-3.5 text-accent" />
                </S.ItemIndicator>
                <div className="min-w-0">
                  <S.ItemText>{o.label}</S.ItemText>
                  {o.description && <div className="text-xs text-text-3">{o.description}</div>}
                </div>
              </S.Item>
            ))}
          </S.Viewport>
        </S.Content>
      </S.Portal>
    </S.Root>
  );
}
