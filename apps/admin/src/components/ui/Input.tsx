"use client";

import { ChevronDown } from "lucide-react";
import type { InputHTMLAttributes, ReactNode, Ref, SelectHTMLAttributes, TextareaHTMLAttributes } from "react";
import { cn } from "@/lib/cn";
import { useFieldControl } from "./Field";

/** Shared by every text-like control so they line up: 32px, 13px, strong hairline, accent on focus. */
export const controlClass =
  "w-full rounded-sm border border-line-strong bg-field text-sm text-text transition-colors " +
  "placeholder:text-text-3 focus:border-accent disabled:cursor-not-allowed disabled:opacity-60 " +
  "read-only:bg-well aria-invalid:border-bad";

/*
 * `cn` does not merge conflicting utilities, so a caller's `w-48` next to the
 * built-in `w-full` would lose on stylesheet order. When the caller sizes the
 * control (an unprefixed w-*), the default width is dropped.
 */
const sizedByCaller = (className?: string) => /(^|\s)w-/.test(className ?? "");
export const fullUnlessSized = (className?: string) => (sizedByCaller(className) ? "" : "w-full");

export type InputProps = Omit<InputHTMLAttributes<HTMLInputElement>, "size"> & {
  size?: "sm" | "md";
  /** Marks the control invalid (a surrounding Field with an error does this for you). */
  invalid?: boolean;
  ref?: Ref<HTMLInputElement>;
};

export function Input({ size = "md", invalid, className, id, ...rest }: InputProps) {
  const field = useFieldControl({ id, invalid, "aria-describedby": rest["aria-describedby"] });
  return (
    <input
      {...rest}
      {...field}
      className={cn(controlClass.replace("w-full ", fullUnlessSized(className) && "w-full "), size === "md" ? "h-8 px-2.5" : "h-7 px-2 text-xs", className)}
    />
  );
}

export type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean; ref?: Ref<HTMLTextAreaElement> };

export function Textarea({ invalid, className, id, rows = 4, ...rest }: TextareaProps) {
  const field = useFieldControl({ id, invalid, "aria-describedby": rest["aria-describedby"] });
  return <textarea rows={rows} {...rest} {...field} className={cn(controlClass, "min-h-16 resize-y px-2.5 py-2 leading-relaxed", className)} />;
}

export type Option<V extends string = string> = { value: V; label: ReactNode; disabled?: boolean };

export type NativeSelectProps = Omit<SelectHTMLAttributes<HTMLSelectElement>, "size"> & {
  options?: { value: string; label: string; disabled?: boolean }[];
  /** A first, empty option ("Choose…"). */
  placeholder?: string;
  size?: "sm" | "md";
  invalid?: boolean;
  ref?: Ref<HTMLSelectElement>;
};

/**
 * The browser's own <select>, styled. Best for long lists (time zones,
 * currencies) and anywhere the native picker on phones is an advantage.
 */
export function NativeSelect({ options, placeholder, size = "md", invalid, className, id, children, ...rest }: NativeSelectProps) {
  const field = useFieldControl({ id, invalid, "aria-describedby": rest["aria-describedby"] });
  return (
    <div className={cn("relative", fullUnlessSized(className), className)}>
      <select
        {...rest}
        {...field}
        className={cn(controlClass, "appearance-none pr-8", size === "md" ? "h-8 pl-2.5" : "h-7 pl-2 text-xs")}
      >
        {placeholder !== undefined && <option value="">{placeholder}</option>}
        {options?.map((o) => (
          <option key={o.value} value={o.value} disabled={o.disabled}>
            {o.label}
          </option>
        ))}
        {children}
      </select>
      <ChevronDown aria-hidden className="pointer-events-none absolute top-1/2 right-2.5 size-3.5 -translate-y-1/2 text-text-3" />
    </div>
  );
}
