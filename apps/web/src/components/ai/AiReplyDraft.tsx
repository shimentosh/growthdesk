"use client";

import { useState } from "react";
import { RotateCcw, Sparkles } from "lucide-react";
import { AI_TONES, labelOf } from "@growthdesk/shared";
import { Button } from "@/components/ui/Button";
import { Input, NativeSelect } from "@/components/ui/Input";
import { Tooltip } from "@/components/ui/Tooltip";
import { useApiMutation } from "@/lib/query";
import { useWorkspace } from "@/lib/session";
import type { AiReplyDraft } from "@/lib/types/ai";
import { useAiGate } from "./useAi";

/*
 * "Draft with AI" for the inbox reply form. The suggestion is shown first and
 * only reaches the reply box when the person chooses "Use draft"; sending is
 * still their Send button.
 */
export function AiReplyDraftButton({ conversationId, hasText, onUse }: { conversationId: string; hasText: boolean; onUse: (body: string) => void }) {
  const ws = useWorkspace();
  const gate = useAiGate();
  const [open, setOpen] = useState(false);
  const [instructions, setInstructions] = useState("");
  const [tone, setTone] = useState<(typeof AI_TONES)[number]>("professional");
  const [draft, setDraft] = useState<AiReplyDraft | null>(null);

  const generate = useApiMutation<AiReplyDraft, { fresh: boolean }>({
    path: ws.path(`/ai/conversations/${conversationId}/draft-reply`),
    body: ({ fresh }) => ({
      instructions: instructions.trim() || undefined,
      tone,
      fresh,
    }),
    invalidate: [ws.key("ai", "status")],
    onSuccess: (d) => setDraft(d),
  });

  if (gate.state === "hidden") return null;
  if (gate.state === "disabled") {
    return (
      <div className="flex">
        <Tooltip content={gate.reason}>
          <span>
            <Button type="button" size="sm" variant="ghost" icon={<Sparkles />} disabled>
              Draft with AI
            </Button>
          </span>
        </Tooltip>
      </div>
    );
  }
  if (!open) {
    return (
      <div className="flex">
        <Button type="button" size="sm" variant="ghost" icon={<Sparkles />} onClick={() => setOpen(true)}>
          Draft with AI
        </Button>
      </div>
    );
  }

  return (
    <div className="flex w-full flex-col gap-2 rounded-md border border-line bg-well p-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          size="sm"
          className="min-w-48 flex-1"
          aria-label="What should the reply say?"
          placeholder="What should the reply say? (optional)"
          value={instructions}
          maxLength={1000}
          onChange={(e) => setInstructions(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              generate.mutate({ fresh: false });
            }
          }}
        />
        <NativeSelect
          size="sm"
          aria-label="Tone"
          className="w-36"
          value={tone}
          onChange={(e) => setTone(e.target.value as typeof tone)}
          options={AI_TONES.map((t) => ({ value: t, label: labelOf(t) }))}
        />
        <Button type="button" size="sm" variant="tinted" icon={<Sparkles />} loading={generate.isPending} onClick={() => generate.mutate({ fresh: Boolean(draft) })}>
          {draft ? "Try again" : "Generate"}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => (setOpen(false), setDraft(null))}>
          Close
        </Button>
      </div>
      {draft && (
        <>
          <div className="max-h-56 overflow-y-auto rounded-sm border border-line bg-panel px-3 py-2 text-sm whitespace-pre-wrap text-text">{draft.body}</div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-2xs text-text-3">AI suggestion{draft.cached ? " (reused)" : ""} — check facts and placeholders in [brackets] before sending.</span>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              icon={hasText ? <RotateCcw /> : undefined}
              onClick={() => {
                onUse(draft.body);
                setOpen(false);
                setDraft(null);
              }}
            >
              {hasText ? "Replace reply with draft" : "Use draft"}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
