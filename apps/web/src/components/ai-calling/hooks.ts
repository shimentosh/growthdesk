"use client";

import { useApiQuery } from "@/lib/query";
import { useWorkspace } from "@/lib/session";
import type { CustomFieldDefinition } from "@/lib/types/crm-settings";
import type { AiAgent, AiCallingSetup } from "@/lib/types/ai-calling";

/*
 * Queries the AI calling screens share. Keys: everything about the Cartesia
 * connection lives under ws.key("ai-calling"), agents under
 * ws.key("call-agents"), so one invalidation refreshes every screen.
 */

/** The Cartesia connection, whether AI calls can be placed now, and why not (GET /ai-calling/setup). */
export function useAiCallingSetup(enabled = true) {
  const ws = useWorkspace();
  return useApiQuery<AiCallingSetup>(ws.key("ai-calling", "setup"), enabled && ws.can("calls.read") ? ws.path("/ai-calling/setup") : null, { staleTime: 60_000 });
}

export type ArchivedFilter = "exclude" | "only" | "all";

/** The workspace's AI agents with their call stats (GET /call-agents). */
export function useAiAgents(archived: ArchivedFilter = "exclude", enabled = true) {
  const ws = useWorkspace();
  return useApiQuery<AiAgent[]>(ws.key("call-agents", "list", archived), enabled && ws.can("calls.read") ? ws.path("/call-agents") : null, {
    query: { archived },
    keepPrevious: true,
  });
}

/** Contact custom fields, for {{custom.key}} in a script. Without contacts.read there are none to offer. */
export function useContactCustomFields() {
  const ws = useWorkspace();
  return useApiQuery<CustomFieldDefinition[]>(ws.key("custom-fields", "contact"), ws.can("contacts.read") ? ws.path("/custom-fields") : null, {
    query: { entity: "contact" },
    staleTime: 60_000,
  });
}
