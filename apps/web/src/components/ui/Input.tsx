"use client";

import { Children, Fragment, isValidElement, type ChangeEvent, type InputHTMLAttributes, type ReactElement, type ReactNode, type Ref, type TextareaHTMLAttributes } from "react";
import { cn } from "@/lib/cn";
import { sizedControlClass } from "./control";
import { useFieldControl } from "./Field";
import { Select, type SelectOption } from "./Select";

export { controlClass, fullUnlessSized } from "./control";

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
      className={cn(sizedControlClass(className), size === "md" ? "h-8 px-2.5" : "h-7 px-2 text-xs", className)}
    />
  );
}

export type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean; ref?: Ref<HTMLTextAreaElement> };

export function Textarea({ invalid, className, id, rows = 4, ...rest }: TextareaProps) {
  const field = useFieldControl({ id, invalid, "aria-describedby": rest["aria-describedby"] });
  return <textarea rows={rows} {...rest} {...field} className={cn(sizedControlClass(), "min-h-16 resize-y px-2.5 py-2 leading-relaxed", className)} />;
}

export type Option<V extends string = string> = { value: V; label: ReactNode; disabled?: boolean };

export type NativeSelectProps = {
  value: string | number | undefined;
  /** Called like a <select>'s change: read `e.target.value`. */
  onChange: (e: ChangeEvent<HTMLSelectElement>) => void;
  options?: { value: string; label: string; disabled?: boolean }[];
  /** A first, empty option ("Choose…"); shown muted while chosen. */
  placeholder?: string;
  size?: "sm" | "md";
  invalid?: boolean;
  disabled?: boolean;
  searchable?: boolean;
  id?: string;
  name?: string;
  "aria-label"?: string;
  "aria-describedby"?: string;
  className?: string;
  /** <option> and <optgroup> elements, as with a native <select>. */
  children?: ReactNode;
};

type OptionProps = { value?: string | number; disabled?: boolean; label?: string; children?: ReactNode };

function readOptions(children: ReactNode, group?: string, out: SelectOption[] = []) {
  Children.forEach(children, (child) => {
    if (!isValidElement(child)) return;
    const { props, type } = child as ReactElement<OptionProps>;
    if (type === Fragment) readOptions(props.children, group, out);
    else if (type === "optgroup") readOptions(props.children, props.label, out);
    else if (type === "option") out.push({ value: String(props.value ?? ""), label: props.children, disabled: props.disabled, group });
  });
  return out;
}

/**
 * A dropdown with the API of a <select>: `value`, `onChange={(e) => e.target.value}`,
 * and `options` or <option>/<optgroup> children. Renders the app's styled
 * Select, so every dropdown looks and behaves the same.
 */
export function NativeSelect({ value, onChange, options, placeholder, children, name, ...rest }: NativeSelectProps) {
  const all: SelectOption[] = [
    ...(placeholder !== undefined ? [{ value: "", label: placeholder }] : []),
    ...(options ?? []),
    ...readOptions(children),
  ];
  return (
    <Select
      {...rest}
      name={name}
      value={value === undefined ? undefined : String(value)}
      placeholder={placeholder}
      options={all}
      onValueChange={(v) => {
        const target = { value: v, name: name ?? "" } as HTMLSelectElement;
        onChange({ target, currentTarget: target } as ChangeEvent<HTMLSelectElement>);
      }}
    />
  );
}
