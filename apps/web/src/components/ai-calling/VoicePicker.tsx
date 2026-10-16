"use client";

import Link from "next/link";
import { useState } from "react";
import { AudioLines, Unplug } from "lucide-react";
import { labelOf, type AiAgentLanguage } from "@growthdesk/shared";
import { EntityPicker } from "@/components/pickers/Pickers";
import { controlClass } from "@/components/ui/Input";
import { cn } from "@/lib/cn";
import { useApiQuery } from "@/lib/query";
import { useWorkspace } from "@/lib/session";
import type { AiVoice } from "@/lib/types/ai-calling";
import { useAiCallingSetup } from "./hooks";

/** "Feminine · Warm, confident narrator" — what the list shows under a voice's name. */
const voiceLine = (v: AiVoice) => [v.gender ? labelOf(v.gender) : "", v.description].filter(Boolean).join(" · ");

/**
 * A Cartesia voice, searched on Cartesia as you type (GET /ai-calling/voices,
 * filtered to the agent's language). Stores the voice id and, for display
 * before the list loads, its name. Without a Cartesia connection there is no
 * list to choose from, so it says so and links to the settings.
 */
export function VoicePicker({
  value,
  valueName,
  language,
  onChange,
  disabled,
  className,
}: {
  value: string;
  valueName?: string;
  language?: AiAgentLanguage;
  onChange: (voiceId: string, voiceName: string) => void;
  disabled?: boolean;
  className?: string;
}) {
  const ws = useWorkspace();
  const setup = useAiCallingSetup();
  const [q, setQ] = useState("");
  const connected = Boolean(setup.data?.connection);
  const voices = useApiQuery<AiVoice[]>(ws.key("ai-calling", "voices"), connected && !disabled ? ws.path("/ai-calling/voices") : null, {
    query: { q: q.trim() || undefined, language },
    staleTime: 5 * 60_000,
    keepPrevious: true,
  });

  if (setup.data && !connected) {
    return (
      <div className={cn(controlClass, "flex h-8 items-center justify-between gap-2 px-2.5 text-text-3", className)} aria-disabled>
        <span className="flex min-w-0 items-center gap-2">
          <Unplug aria-hidden className="size-3.5 shrink-0" />
          <span className="truncate">Connect Cartesia first</span>
        </span>
        {ws.can("integrations.read") && (
          <Link href={ws.href("/settings/calling")} className="shrink-0 text-xs font-medium text-accent-ink hover:text-accent-hi">
            Settings
          </Link>
        )}
      </div>
    );
  }

  return (
    <EntityPicker
      value={value || null}
      valueLabel={valueName || (value ? "Chosen voice" : null)}
      placeholder="Choose a voice…"
      disabled={disabled || setup.isPending}
      clearable={false}
      icon={<AudioLines />}
      className={className}
      items={(voices.data ?? []).map((v) => ({ id: v.id, label: v.name, sublabel: voiceLine(v) }))}
      loading={voices.isFetching}
      search={q}
      onSearch={setQ}
      emptyText={voices.isError ? voices.error.message : q ? "No voice matches" : "No voices for this language"}
      onChange={(id, item) => id && onChange(id, item?.label ?? "")}
    />
  );
}
