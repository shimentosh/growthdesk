"use client";

import { Switch as S } from "radix-ui";
import { useId, type ReactNode } from "react";
import { cn } from "@/lib/cn";

export type SwitchProps = {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label?: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
  id?: string;
  "aria-label"?: string;
  size?: "sm" | "md";
  className?: string;
};

/** An on/off setting that applies immediately (use a Checkbox inside forms that are saved with a button). */
export function Switch({ checked, onCheckedChange, label, description, disabled, id, size = "md", className, ...aria }: SwitchProps) {
  const auto = useId();
  const switchId = id ?? `sw${auto.replace(/:/g, "")}`;
  const control = (
    <S.Root
      id={switchId}
      checked={checked}
      onCheckedChange={onCheckedChange}
      disabled={disabled}
      aria-label={aria["aria-label"]}
      className={cn(
        "relative inline-flex shrink-0 items-center rounded-full bg-s-6 transition-colors data-[state=checked]:bg-accent disabled:cursor-not-allowed disabled:opacity-50",
        size === "md" ? "h-5 w-9" : "h-4 w-7",
      )}
    >
      <S.Thumb
        className={cn(
          "block rounded-full bg-white shadow-sm transition-transform",
          size === "md" ? "size-4 translate-x-0.5 data-[state=checked]:translate-x-[18px]" : "size-3 translate-x-0.5 data-[state=checked]:translate-x-[14px]",
        )}
      />
    </S.Root>
  );
  if (!label) return <span className={className}>{control}</span>;
  return (
    <div className={cn("flex items-start justify-between gap-4", className)}>
      <label htmlFor={switchId} className={cn("min-w-0 text-sm text-text", disabled ? "opacity-60" : "cursor-pointer")}>
        {label}
        {description && <span className="block text-xs text-text-3">{description}</span>}
      </label>
      {control}
    </div>
  );
}
