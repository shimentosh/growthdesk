"use client";

import { Sparkles } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Tooltip } from "@/components/ui/Tooltip";
import { useApiMutation } from "@/lib/query";
import { useWorkspace } from "@/lib/session";
import type { AiMessageDraft } from "@/lib/types/ai";
import { useAiGate } from "./useAi";

/*
 * "Draft with AI" for a new message (inbox compose). Whatever is already in
 * the message box is sent as the brief and replaced by the draft; the subject
 * is filled only when empty. Sending stays with the Send button.
 */
export function AiComposeDraftButton({
  contactId,
  channel,
  brief,
  onDraft,
}: {
  contactId: string | null;
  channel: "email" | "whatsapp" | "telegram";
  brief: string;
  onDraft: (d: { subject: string; body: string }) => void;
}) {
  const ws = useWorkspace();
  const gate = useAiGate();
  const draft = useApiMutation<AiMessageDraft, void>({
    path: ws.path("/ai/draft-message"),
    body: () => ({
      contactId,
      channel,
      goal: brief.trim().slice(0, 1000) || undefined,
    }),
    invalidate: [ws.key("ai", "status")],
    onSuccess: (d) => onDraft({ subject: d.subject, body: d.body }),
  });
  if (gate.state === "hidden") return null;
  const hint =
    gate.state === "disabled"
      ? gate.reason
      : !contactId
        ? "Choose who it is to first."
        : brief.trim()
          ? "Turns what you have typed into a full draft (it replaces the message)."
          : "Drafts a first message from the contact's CRM details.";
  return (
    <Tooltip content={hint}>
      <span>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          icon={<Sparkles />}
          loading={draft.isPending}
          disabled={gate.state === "disabled" || !contactId}
          onClick={() => draft.mutate()}
        >
          Draft with AI
        </Button>
      </span>
    </Tooltip>
  );
}
