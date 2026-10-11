"use client";

import { useState } from "react";
import { Sparkles } from "lucide-react";
import { AI_TONES, labelOf } from "@growthdesk/shared";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Modal } from "@/components/ui/Dialog";
import { Field } from "@/components/ui/Field";
import { NativeSelect, Textarea } from "@/components/ui/Input";
import { Tooltip } from "@/components/ui/Tooltip";
import { useApiMutation } from "@/lib/query";
import { useWorkspace } from "@/lib/session";
import type { AiWritten } from "@/lib/types/ai";
import { useAiGate } from "./useAi";

/*
 * "Write with AI" for template and sequence-step editors. Writes a new draft
 * from a brief, or improves the current text. The result is previewed with
 * any personalisation problems listed; "Use this" puts it into the editor,
 * which still has to be saved (and is validated again by the server).
 */
export function AiWriteButton({
  target,
  channel,
  subject,
  body,
  stepNumber,
  onApply,
  size = "sm",
}: {
  target: "template" | "sequence_step";
  channel: string;
  subject?: string;
  body?: string;
  stepNumber?: number;
  onApply: (out: { subject: string; body: string }) => void;
  size?: "sm" | "md";
}) {
  const gate = useAiGate();
  const [open, setOpen] = useState(false);
  if (gate.state === "hidden") return null;
  if (gate.state === "disabled") {
    return (
      <Tooltip content={gate.reason}>
        <span>
          <Button type="button" size={size} variant="ghost" icon={<Sparkles />} disabled>
            Write with AI
          </Button>
        </span>
      </Tooltip>
    );
  }
  return (
    <>
      <Button type="button" size={size} variant="ghost" icon={<Sparkles />} onClick={() => setOpen(true)}>
        Write with AI
      </Button>
      {open && (
        <AiWriteDialog
          open={open}
          onOpenChange={setOpen}
          target={target}
          channel={channel}
          subject={subject ?? ""}
          body={body ?? ""}
          stepNumber={stepNumber}
          onApply={(out) => {
            onApply(out);
            setOpen(false);
          }}
        />
      )}
    </>
  );
}

function AiWriteDialog({
  open,
  onOpenChange,
  target,
  channel,
  subject,
  body,
  stepNumber,
  onApply,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  target: "template" | "sequence_step";
  channel: string;
  subject: string;
  body: string;
  stepNumber?: number;
  onApply: (out: { subject: string; body: string }) => void;
}) {
  const ws = useWorkspace();
  const hasText = body.trim().length > 0;
  const [mode, setMode] = useState<"write" | "improve">(hasText ? "improve" : "write");
  const [brief, setBrief] = useState("");
  const [tone, setTone] = useState<(typeof AI_TONES)[number]>("professional");
  const [result, setResult] = useState<AiWritten | null>(null);
  const email = channel === "email";
  const aiChannel = channel === "whatsapp" || channel === "telegram" ? channel : "email";

  const generate = useApiMutation<AiWritten, { fresh: boolean }>({
    path: ws.path("/ai/write"),
    body: ({ fresh }) => ({
      target,
      mode,
      channel: aiChannel,
      tone,
      brief: brief.trim() || undefined,
      ...(mode === "improve" ? { subject: email ? subject : undefined, body } : {}),
      ...(stepNumber ? { stepNumber } : {}),
      fresh,
    }),
    errorToast: false,
    invalidate: [ws.key("ai", "status")],
    onSuccess: (d) => setResult(d),
  });
  const err = generate.error && !generate.error.isPlanLimit ? (generate.error.fields.brief ?? generate.error.fields.body ?? generate.error.message) : null;

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      dismissOnOutside={false}
      title="Write with AI"
      description="The AI drafts text for you to review. Nothing is saved until you save the editor."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            variant={result ? "secondary" : "primary"}
            icon={<Sparkles />}
            loading={generate.isPending}
            disabled={mode === "write" && !brief.trim()}
            onClick={() => generate.mutate({ fresh: Boolean(result) })}
          >
            {result ? "Try again" : mode === "write" ? "Write it" : "Improve it"}
          </Button>
          {result && (
            <Button
              variant="primary"
              onClick={() =>
                onApply({
                  subject: email ? result.subject : "",
                  body: result.body,
                })
              }
            >
              Use this
            </Button>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="What to do">
            <NativeSelect
              value={mode}
              onChange={(e) => setMode(e.target.value as "write" | "improve")}
              options={[
                { value: "write", label: "Write a new draft from a brief" },
                {
                  value: "improve",
                  label: "Improve the current text",
                  disabled: !hasText,
                },
              ]}
            />
          </Field>
          <Field label="Tone">
            <NativeSelect value={tone} onChange={(e) => setTone(e.target.value as typeof tone)} options={AI_TONES.map((t) => ({ value: t, label: labelOf(t) }))} />
          </Field>
        </div>
        <Field
          label={mode === "write" ? "Brief" : "Extra direction (optional)"}
          hint={
            mode === "write"
              ? "Who it is for, what you offer, and the one thing you want them to do. Facts you do not give will be left as [placeholders]."
              : "e.g. shorter, warmer, mention the free trial"
          }
        >
          <Textarea rows={3} value={brief} maxLength={2000} onChange={(e) => setBrief(e.target.value)} />
        </Field>
        {err && <Callout tone="bad">{err}</Callout>}
        {result && (
          <div className="flex flex-col gap-2">
            {result.unknownVariables.length > 0 && (
              <Callout tone="warn" title="Unknown personalization variables">
                {result.unknownVariables.map((v) => `{{${v}}}`).join(", ")} — fix or remove them before saving; the editor will refuse them.
              </Callout>
            )}
            {result.droppedVariables.length > 0 && (
              <Callout tone="info" title="Variables the new version no longer uses">
                {result.droppedVariables.map((v) => `{{${v}}}`).join(", ")}
              </Callout>
            )}
            {email && result.subject && (
              <div className="rounded-sm border border-line bg-well px-3 py-2 text-sm">
                <span className="text-text-3">Subject: </span>
                <span className="text-text">{result.subject}</span>
              </div>
            )}
            <div className="max-h-80 overflow-y-auto rounded-sm border border-line bg-well px-3 py-2 text-sm whitespace-pre-wrap text-text">{result.body}</div>
            <p className="text-2xs text-text-3">AI suggestion{result.cached ? " (reused)" : ""} — check every claim and [placeholder] before using it.</p>
          </div>
        )}
      </div>
    </Modal>
  );
}
