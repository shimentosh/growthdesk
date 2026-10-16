"use client";

import { Braces } from "lucide-react";
import { AI_AGENT_STATIC_VARIABLES, AI_CALL_VARIABLES } from "@growthdesk/shared";
import { Button } from "@/components/ui/Button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/DropdownMenu";
import { useContactCustomFields } from "./hooks";

/*
 * "Insert variable" for an AI agent's script. Not the template menu: an AI
 * call has its own variable set (AI_CALL_VARIABLES, each with a built-in
 * fallback, so no "|fallback"), plus the agent's own name and business name,
 * plus the contact's custom fields as {{custom.key}}. Use spliceToken /
 * focusAt from components/templates/VariableMenu to place the token.
 */
export function AgentVariableMenu({ onPick, disabled, label = "Insert variable" }: { onPick: (token: string) => void; disabled?: boolean; label?: string }) {
  const custom = useContactCustomFields();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={disabled}>
        <Button size="sm" variant="ghost" icon={<Braces />}>
          {label}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-[min(420px,var(--radix-dropdown-menu-content-available-height))] w-72 overflow-y-auto">
        <DropdownMenuLabel>The person called</DropdownMenuLabel>
        {AI_CALL_VARIABLES.map((v) => (
          <DropdownMenuItem key={v.key} onSelect={() => onPick(`{{${v.key}}}`)} shortcut={<span className="font-mono">{v.key}</span>}>
            {v.label}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuLabel>This agent</DropdownMenuLabel>
        {AI_AGENT_STATIC_VARIABLES.map((v) => (
          <DropdownMenuItem key={v.key} onSelect={() => onPick(`{{${v.key}}}`)} shortcut={<span className="font-mono">{v.key}</span>}>
            {v.label}
          </DropdownMenuItem>
        ))}
        {custom.data && custom.data.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Custom fields</DropdownMenuLabel>
            {custom.data.map((f) => (
              <DropdownMenuItem key={f.id} onSelect={() => onPick(`{{custom.${f.key}}}`)} shortcut={<span className="font-mono">{f.key}</span>}>
                {f.label}
              </DropdownMenuItem>
            ))}
          </>
        )}
        <DropdownMenuSeparator />
        <p className="px-2 py-1.5 text-xs text-text-3">
          A missing value is replaced by a fallback, so the agent never reads out a blank: <code className="font-mono text-text-2">{"{{first_name}}"}</code> becomes &ldquo;there&rdquo;.
        </p>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
