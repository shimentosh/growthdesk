"use client";

import { Checkbox as C } from "radix-ui";
import { Check, Minus } from "lucide-react";
import { useId, type ReactNode } from "react";
import { cn } from "@/lib/cn";

export type CheckboxProps = {
  checked: boolean | "indeterminate";
  onCheckedChange: (checked: boolean) => void;
  /** Visible label. Without one, pass aria-label. */
  label?: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
  id?: string;
  name?: string;
  "aria-label"?: string;
  className?: string;
};

/** A checkbox (Radix). Space toggles; "indeterminate" draws a dash (e.g. "some rows selected"). */
export function Checkbox({ checked, onCheckedChange, label, description, disabled, id, name, className, ...aria }: CheckboxProps) {
  const auto = useId();
  const boxId = id ?? `cb${auto.replace(/:/g, "")}`;
  const box = (
    <C.Root
      id={boxId}
      name={name}
      checked={checked}
      disabled={disabled}
      onCheckedChange={(v) => onCheckedChange(v === true)}
      aria-label={aria["aria-label"]}
      className={cn(
        "inline-flex size-4 shrink-0 items-center justify-center rounded-[4px] border border-line-strong bg-field transition-colors",
        "data-[state=checked]:border-accent data-[state=checked]:bg-accent data-[state=indeterminate]:border-accent data-[state=indeterminate]:bg-accent",
        "text-on-accent disabled:cursor-not-allowed disabled:opacity-50",
        !label && className,
      )}
    >
      <C.Indicator>
        {checked === "indeterminate" ? <Minus aria-hidden className="size-3" strokeWidth={3} /> : <Check aria-hidden className="size-3" strokeWidth={3} />}
      </C.Indicator>
    </C.Root>
  );
  if (!label) return box;
  return (
    <div className={cn("flex items-start gap-2", className)}>
      <span className="pt-0.5">{box}</span>
      <label htmlFor={boxId} className={cn("min-w-0 text-sm text-text select-none", disabled ? "opacity-60" : "cursor-pointer")}>
        {label}
        {description && <span className="block text-xs text-text-3">{description}</span>}
      </label>
    </div>
  );
}
