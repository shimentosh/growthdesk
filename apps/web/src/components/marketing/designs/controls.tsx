"use client";

import { Braces } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/Button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/DropdownMenu";
import { cn } from "@/lib/cn";

/*
 * Small controls for the block editor: a compact segmented choice (alignment,
 * heading size) and the personalisation-token menu.
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
