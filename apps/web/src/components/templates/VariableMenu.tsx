"use client";

import { Braces } from "lucide-react";
import { STANDARD_VARIABLES } from "@growthdesk/shared";
import { Button } from "@/components/ui/Button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/DropdownMenu";
import { useApiQuery } from "@/lib/query";
import { useWorkspace } from "@/lib/session";
import type { TemplateVariables } from "@/lib/types/templates";

/*
 * Personalisation tokens: a menu that lists what GET /templates/variables
 * offers (standard variables + the workspace's contact custom fields) and
 * helpers to drop the chosen token at the caret of an input or textarea.
 */

export const FALLBACK_SYNTAX = "{{first_name|there}}";

/** The variables a template may use. Without templates.read it falls back to the standard list. */
export function useTemplateVariables() {
  const ws = useWorkspace();
  const q = useApiQuery<TemplateVariables>(ws.key("templates", "variables"), ws.can("templates.read") ? ws.path("/templates/variables") : null, {
    staleTime: 60_000,
  });
  const fallback: TemplateVariables = {
    standard: STANDARD_VARIABLES.map((v) => ({ key: v.key, label: v.label, token: `{{${v.key}}}` })),
    custom: [],
    fallbackSyntax: FALLBACK_SYNTAX,
  };
  return { data: q.data ?? fallback, isPending: q.isPending && ws.can("templates.read") };
}

type TextControl = HTMLInputElement | HTMLTextAreaElement;

/** `value` with `token` put where the control's selection is (or at the end). */
export function spliceToken(el: TextControl | null, value: string, token: string): { value: string; caret: number } {
  const start = el?.selectionStart ?? value.length;
  const end = el?.selectionEnd ?? start;
  return { value: value.slice(0, start) + token + value.slice(end), caret: start + token.length };
}

/** Puts the caret back after a controlled update has rendered. */
export function focusAt(el: TextControl | null, caret: number) {
  requestAnimationFrame(() => {
    if (!el) return;
    el.focus();
    el.setSelectionRange(caret, caret);
  });
}

/** "Insert variable" — picks a token; the caller decides where it goes. */
export function VariableMenu({ onPick, disabled, size = "sm", label = "Insert variable" }: { onPick: (token: string) => void; disabled?: boolean; size?: "sm" | "md"; label?: string }) {
  const { data } = useTemplateVariables();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={disabled}>
        <Button size={size} variant="ghost" icon={<Braces />}>
          {label}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-[min(420px,var(--radix-dropdown-menu-content-available-height))] w-72 overflow-y-auto">
        <DropdownMenuLabel>Contact & sender</DropdownMenuLabel>
        {data.standard.map((v) => (
          <DropdownMenuItem key={v.key} onSelect={() => onPick(v.token)} shortcut={<span className="font-mono">{v.key}</span>}>
            {v.label}
          </DropdownMenuItem>
        ))}
        {data.custom.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Custom fields</DropdownMenuLabel>
            {data.custom.map((v) => (
              <DropdownMenuItem key={v.key} onSelect={() => onPick(v.token)} shortcut={<span className="font-mono">{v.key}</span>}>
                {v.label}
              </DropdownMenuItem>
            ))}
          </>
        )}
        <DropdownMenuSeparator />
        <p className="px-2 py-1.5 text-xs text-text-3">
          Add a fallback after a pipe, used when the contact has no value: <code className="font-mono text-text-2">{data.fallbackSyntax}</code>
        </p>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
