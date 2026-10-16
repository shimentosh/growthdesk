"use client";

import { Badge } from "@/components/ui/Badge";
import { Select, type SelectOption } from "@/components/ui/Select";
import type { AiAgent } from "@/lib/types/ai-calling";

/** Whether the agent's latest version is saved on Cartesia, as a chip; null when it is. */
export function AgentSyncBadge({ agent }: { agent: Pick<AiAgent, "sync"> }) {
  if (agent.sync.saved) return null;
  return agent.sync.error ? (
    <Badge tone="bad" title={agent.sync.error}>
      Not synced
    </Badge>
  ) : (
    <Badge tone="warn">Syncing</Badge>
  );
}

/**
 * Pick an AI agent. Archived agents are left out unless one is the current
 * value (a saved step that still points at it), which is marked.
 */
export function AiAgentSelect({
  agents,
  value,
  onChange,
  pending,
  invalid,
  placeholder = "Choose an agent",
  "aria-label": ariaLabel,
}: {
  agents: AiAgent[];
  value: string;
  onChange: (id: string) => void;
  pending?: boolean;
  invalid?: boolean;
  placeholder?: string;
  "aria-label"?: string;
}) {
  const usable = agents.filter((a) => !a.archivedAt || a.id === value);
  const options: SelectOption[] = usable.map((a) => ({
    value: a.id,
    label: (
      <span className="flex min-w-0 items-center gap-2">
        <span className="truncate">
          {a.name}
          {a.archivedAt ? " (archived)" : ""}
        </span>
        <AgentSyncBadge agent={a} />
      </span>
    ),
    text: a.name,
    description: a.personaName && a.personaName !== a.name ? `Speaks as ${a.personaName}` : undefined,
  }));
  if (value && !usable.some((a) => a.id === value) && !pending) options.push({ value, label: "An agent that no longer exists" });
  return (
    <Select
      value={value}
      placeholder={pending ? "Loading agents…" : placeholder}
      disabled={pending}
      invalid={invalid}
      searchable={usable.length > 8}
      aria-label={ariaLabel}
      onValueChange={onChange}
      options={options}
    />
  );
}
