"use client";

import { Cpu, Plug, Sparkles, Workflow, type LucideIcon } from "lucide-react";
import { Avatar } from "@/components/ui/Avatar";
import { cn } from "@/lib/cn";

/*
 * Who did it, in one glance: a teammate (their initials), an AI agent (and
 * the teammate it acted for), a workflow, an integration (API key) or
 * Growthdesk itself. Same words and marks on every timeline and in the team
 * activity feed. The API side is apps/api/src/common/actor.ts.
 */

export type ActorType = "user" | "ai_agent" | "workflow" | "integration" | "system";

export const ACTOR_META: Record<ActorType, { label: string; plural: string; icon: LucideIcon | null; tone: string }> = {
  user: { label: "Teammate", plural: "Teammates", icon: null, tone: "text-text-2" },
  ai_agent: { label: "AI agent", plural: "AI agents", icon: Sparkles, tone: "text-[var(--tint-purple)]" },
  workflow: { label: "Workflow", plural: "Workflows", icon: Workflow, tone: "text-[var(--tint-indigo)]" },
  integration: { label: "Integration", plural: "Integrations", icon: Plug, tone: "text-[var(--tint-teal)]" },
  system: { label: "System", plural: "System", icon: Cpu, tone: "text-text-3" },
};

export type ActorView = {
  type: string;
  name: string;
  /** The teammate an AI agent acted for. */
  onBehalfOf?: { name: string } | null;
};

const asType = (t: string): ActorType => (t in ACTOR_META ? (t as ActorType) : "system");

/** "Priya Nair", "✦ Claude · for Priya Nair", "⚙ Round-robin new leads", "🔌 Clientdesk", "Growthdesk". */
export function ActorLabel({ actor, className }: { actor: ActorView; className?: string }) {
  const type = asType(actor.type);
  const meta = ACTOR_META[type];
  const name = actor.name || (type === "system" ? "Growthdesk" : meta.label);
  const Icon = meta.icon;
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1", className)} title={`${meta.label}: ${name}${actor.onBehalfOf?.name ? ` (for ${actor.onBehalfOf.name})` : ""}`}>
      {type === "user" ? (
        <Avatar size="xs" name={name} className="size-4 text-[8px]" />
      ) : Icon ? (
        <Icon aria-hidden className={cn("size-3.5 shrink-0", meta.tone)} strokeWidth={2.25} />
      ) : null}
      <span className={cn("truncate", type === "user" ? "text-text-2" : meta.tone, type !== "user" && type !== "system" && "font-medium")}>{name}</span>
      {type === "workflow" && <span className="shrink-0 text-text-3">· workflow</span>}
      {type === "ai_agent" && actor.onBehalfOf?.name && <span className="shrink-0 truncate text-text-3">· for {actor.onBehalfOf.name}</span>}
    </span>
  );
}
