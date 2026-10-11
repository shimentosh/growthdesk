"use client";

import { useState } from "react";
import { useApiQuery } from "@/lib/query";
import { useWorkspace } from "@/lib/session";
import type { CallScript, CallSetup } from "@/lib/types/calls";

/** Connected Twilio accounts and whether click-to-call works here (GET /calls/setup). */
export function useCallSetup(enabled = true) {
  const ws = useWorkspace();
  return useApiQuery<CallSetup>(ws.key("calls", "setup"), enabled && ws.can("calls.read") ? ws.path("/calls/setup") : null, { staleTime: 60_000 });
}

export function useCallScripts(enabled = true) {
  const ws = useWorkspace();
  return useApiQuery<CallScript[]>(ws.key("calls", "scripts"), enabled && ws.can("calls.read") ? ws.path("/call-scripts") : null);
}

const AGENT_KEY = "gd.calls.agentNumber";

/**
 * The rep's own phone number for click-to-call. Kept in this browser only (a
 * convenience, never sent anywhere but the dial request); storage can be
 * unavailable, in which case it is simply not remembered.
 */
export function useAgentNumber(): [string, (v: string) => void] {
  const [value, setValue] = useState(() => {
    try {
      return typeof window === "undefined" ? "" : (window.localStorage.getItem(AGENT_KEY) ?? "");
    } catch {
      return "";
    }
  });
  const set = (v: string) => {
    setValue(v);
    try {
      window.localStorage.setItem(AGENT_KEY, v.trim());
    } catch {
      // Not remembered; the field still works for this call.
    }
  };
  return [value, set];
}

/** "4:05" or "4" (minutes) → seconds; "" → null; anything else → undefined (invalid). */
export function parseDuration(text: string): number | null | undefined {
  const t = text.trim();
  if (!t) return null;
  const m = /^(\d{1,3})(?::([0-5]?\d))?$/.exec(t);
  if (!m) return undefined;
  return Number(m[1]) * 60 + Number(m[2] ?? 0);
}

export function durationInput(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return "";
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
