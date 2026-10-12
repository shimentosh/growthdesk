"use client";

import { Braces, X } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { Button, IconButton } from "@/components/ui/Button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/DropdownMenu";
import { Input } from "@/components/ui/Input";
import { cn } from "@/lib/cn";

/*
 * Small controls for the block editor and the theme panel: a compact
 * segmented choice (alignment, heading size), the personalisation-token menu,
 * a colour field (swatch + hex) and a slider.
 */

/** Two or three mutually exclusive options. Icon-only options need a `label` for screen readers. */
export function Choice<V extends string | number>({
  value,
  onChange,
  options,
  disabled,
  "aria-label": ariaLabel,
}: {
  value: V;
  onChange: (value: V) => void;
  options: { value: V; label: string; icon?: ReactNode; iconOnly?: boolean }[];
  disabled?: boolean;
  "aria-label": string;
}) {
  return (
    <div role="group" aria-label={ariaLabel} className="inline-flex h-8 shrink-0 items-center self-start rounded-sm border border-line-strong bg-ctl-face p-0.5 shadow-sm">
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          disabled={disabled}
          aria-pressed={value === o.value}
          aria-label={o.iconOnly ? o.label : undefined}
          title={o.iconOnly ? o.label : undefined}
          onClick={() => onChange(o.value)}
          className={cn(
            "inline-flex h-full items-center justify-center gap-1.5 rounded-xs text-xs font-medium transition-colors disabled:opacity-60 [&_svg]:size-3.5",
            o.iconOnly ? "w-8" : "px-2.5",
            value === o.value ? "bg-s-4 text-text-hi" : "text-text-3 hover:text-text",
          )}
        >
          {o.icon}
          {!o.iconOnly && o.label}
        </button>
      ))}
    </div>
  );
}

/*
 * The tokens a marketing email can use. The sender fills them from the
 * contact; an empty value prints the fallback after the pipe, or nothing.
 */
const TOKENS = [
  { label: "First name", token: "{{first_name|there}}" },
  { label: "Last name", token: "{{last_name}}" },
  { label: "Full name", token: "{{full_name}}" },
  { label: "Email", token: "{{email}}" },
  { label: "Company", token: "{{company|your team}}" },
  { label: "Job title", token: "{{job_title}}" },
  { label: "City", token: "{{city}}" },
  { label: "Country", token: "{{country}}" },
];

/** "Personalise" — picks a token; the caller puts it at the caret. */
export function TokenMenu({ onPick, disabled }: { onPick: (token: string) => void; disabled?: boolean }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={disabled}>
        <Button size="sm" variant="ghost" icon={<Braces />} className="-my-1 h-6 px-1.5">
          Personalise
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuLabel>From the contact</DropdownMenuLabel>
        {TOKENS.map((t) => (
          <DropdownMenuItem key={t.token} onSelect={() => onPick(t.token)} shortcut={<span className="font-mono">{t.token.slice(2, -2)}</span>}>
            {t.label}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <p className="px-2 py-1.5 text-xs text-text-3">
          The word after the pipe is used when a contact has no value: <code className="font-mono text-text-2">{"{{first_name|there}}"}</code>. Without one, the token prints nothing.
        </p>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const HEX = /^#[0-9a-f]{6}$/i;

/**
 * A colour as a swatch (opens the system picker) and its hex code, typed or
 * pasted. `value` undefined means "not set": the swatch shows `fallback`
 * muted, and a clear button appears once a colour is chosen.
 */
export function ColorField({
  value,
  fallback,
  onChange,
  label,
  disabled,
  clearLabel = "Use default",
}: {
  value: string | undefined;
  fallback: string;
  onChange: (value: string | undefined) => void;
  label: string;
  disabled?: boolean;
  clearLabel?: string;
}) {
  const shown = (value ?? fallback).toLowerCase();
  const [text, setText] = useState(value ?? "");
  // Follow outside changes (a preset, a reset) unless the field holds a half-typed code for the same colour.
  useEffect(() => setText(value ?? ""), [value]);
  const commit = (raw: string) => {
    const v = raw.trim().startsWith("#") ? raw.trim() : `#${raw.trim()}`;
    if (raw.trim() === "") onChange(undefined);
    else if (HEX.test(v)) onChange(v.toLowerCase());
  };
  return (
    <div role="group" aria-label={label} className="flex h-8 min-w-0 items-center gap-1.5">
      <label
        title={`Pick ${label.toLowerCase()}`}
        className="relative inline-flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-sm border border-line-strong bg-ctl-face shadow-sm hover:bg-ctl-hover has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-60"
      >
        <span aria-hidden className={cn("size-5 rounded-full border border-black/10", !value && "opacity-60")} style={{ background: shown }} />
        <input
          type="color"
          aria-label={`Pick ${label.toLowerCase()}`}
          disabled={disabled}
          value={shown}
          onChange={(e) => onChange(e.target.value.toLowerCase())}
          className="absolute inset-0 size-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
        />
      </label>
      <Input
        aria-label={`${label} hex code`}
        invalid={text.trim() !== "" && !HEX.test(text.trim().startsWith("#") ? text.trim() : `#${text.trim()}`)}
        value={text}
        disabled={disabled}
        maxLength={7}
        spellCheck={false}
        placeholder={fallback.toLowerCase()}
        onChange={(e) => {
          setText(e.target.value);
          commit(e.target.value);
        }}
        onBlur={() => setText(value ?? "")}
        className="w-[5.75rem] font-mono text-xs tabular-nums"
      />
      {value && !disabled && <IconButton size="sm" label={clearLabel} icon={<X />} onClick={() => onChange(undefined)} />}
    </div>
  );
}

/** A range slider with its value and unit beside it. */
export function Slider({
  value,
  min,
  max,
  step,
  unit,
  label,
  disabled,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  unit: string;
  label: string;
  disabled?: boolean;
  onChange: (v: number) => void;
}) {
  return (
    <div className="flex items-center gap-3">
      <input
        type="range"
        aria-label={label}
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-8 min-w-0 flex-1 accent-accent disabled:opacity-60"
      />
      <span className="w-14 shrink-0 text-right text-sm text-text-2 tabular-nums">
        {value}
        <span className="text-text-3"> {unit}</span>
      </span>
    </div>
  );
}
