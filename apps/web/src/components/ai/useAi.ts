"use client";

import { useApiQuery } from "@/lib/query";
import { useWorkspace } from "@/lib/session";
import type { AiStatus } from "@/lib/types/ai";

/*
 * Whether to show AI controls, and in what state:
 *   hidden    the role lacks ai.use, or no provider is configured on this
 *             installation (nothing the customer can do about it)
 *   disabled  the plan lacks AI or the month's credits are used up — the
 *             control stays visible with the reason as its hint
 *   ready     usable
 * The API enforces all of this regardless.
 */
export type AiGate = { state: "hidden" | "disabled" | "ready"; reason: string | null; status: AiStatus | null };

export function useAiStatus() {
  const ws = useWorkspace();
  return useApiQuery<AiStatus>(ws.key("ai", "status"), ws.can("ai.use") ? ws.path("/ai/status") : null, { staleTime: 60_000 });
}

export function useAiGate(): AiGate {
  const ws = useWorkspace();
  const status = useAiStatus();
  const s = status.data ?? null;
  if (!ws.can("ai.use") || !s || !s.configured || !s.permitted) return { state: "hidden", reason: null, status: s };
  return s.available ? { state: "ready", reason: null, status: s } : { state: "disabled", reason: s.reason, status: s };
}
