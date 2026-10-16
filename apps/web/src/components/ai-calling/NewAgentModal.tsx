"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent, type ReactNode } from "react";
import { ChevronLeft, ChevronRight, PenLine } from "lucide-react";
import { AI_AGENT_GOAL_LABELS, AI_AGENT_LANGUAGES, AI_AGENT_TEMPLATES, agentFromTemplate, type AiAgentInputT, type AiAgentLanguage, type AiAgentTemplate } from "@growthdesk/shared";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Dialog";
import { Field, FormError } from "@/components/ui/Field";
import { ENTITY, EntityTile } from "@/components/ui/icons";
import { IconTile } from "@/components/ui/IconTile";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { useApiMutation } from "@/lib/query";
import { useWorkspace } from "@/lib/session";
import type { AiAgentDetail } from "@/lib/types/ai-calling";
import { VoicePicker } from "./VoicePicker";

/**
 * A blank agent that still saves: the API needs a greeting, an AI disclosure
 * and an "About", so it starts with placeholders the person rewrites.
 */
const SCRATCH: AiAgentTemplate = {
  key: "",
  name: "",
  summary: "",
  bestFor: "",
  goal: "book_meeting",
  greeting: "Hi {{first_name}}, this is {{agent_name}} from {{business_name}}.",
  disclosure: "I'm an AI assistant, and this call may be recorded.",
  about:
    "{{business_name}} helps [who you help] to [the result you deliver]. Replace this paragraph with two or three short facts: what you offer, who it is for, and one proof point. The agent will only say what is written here.",
  goalDetails: "",
  questions: [],
  objections: [],
  voicemailMessage: "",
  extraInstructions: "",
  maxCallMinutes: 5,
};

type Fill = { name: string; personaName: string; businessName: string; language: AiAgentLanguage; voiceId: string; voiceName: string };

/** The keys the details step shows; any other field error goes in the form-level message. */
const SHOWN = ["name", "personaName", "businessName", "language", "voiceId"];

/**
 * "New agent": pick a ready-made agent (or a blank one), then name it and
 * choose its voice. The script itself is edited on the agent's page, where
 * it can be tested before any campaign uses it.
 */
export function NewAgentModal({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const ws = useWorkspace();
  const router = useRouter();
  const business = ws.detail.profile?.marketingFromName?.trim() || ws.name;
  const [template, setTemplate] = useState<AiAgentTemplate | null>(null);
  const [fill, setFill] = useState<Fill>({ name: "", personaName: "Ava", businessName: business, language: "en", voiceId: "", voiceName: "" });
  const set = <K extends keyof Fill>(k: K, v: Fill[K]) => setFill((f) => ({ ...f, [k]: v }));

  const create = useApiMutation<AiAgentDetail, AiAgentInputT>({
    path: ws.path("/call-agents"),
    invalidate: [ws.key("call-agents")],
    success: (a) => `${a.name} created`,
    errorToast: false,
    onSuccess: (a) => {
      onOpenChange(false);
      router.push(ws.href(`/ai-agents/${a.id}`));
    },
  });
  const fields = create.error?.fields ?? {};
  const otherError = create.error && !create.error.isPlanLimit && !SHOWN.some((k) => fields[k]);

  const pick = (t: AiAgentTemplate) => {
    create.reset();
    setTemplate(t);
    setFill((f) => ({ ...f, name: t.name }));
  };
  const close = (next: boolean) => {
    if (!next) {
      create.reset();
      setTemplate(null);
    }
    onOpenChange(next);
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!template) return;
    const base = agentFromTemplate(template, { personaName: fill.personaName.trim(), businessName: fill.businessName.trim(), voiceId: fill.voiceId, voiceName: fill.voiceName });
    create.mutate({ ...base, templateKey: template.key || undefined, name: fill.name.trim(), language: fill.language });
  };

  return (
    <Modal
      open={open}
      onOpenChange={close}
      size={template ? "md" : "xl"}
      dismissOnOutside={!template}
      icon={<EntityTile of="aiAgents" size="md" />}
      title={template ? template.name || "New agent" : "New AI agent"}
      description={template ? "Name it and choose its voice. You can edit the whole script next." : "Start from a ready-made agent and adapt its script, or start from a blank one."}
      footer={
        template ? (
          <>
            <Button variant="ghost" icon={<ChevronLeft />} className="mr-auto" onClick={() => setTemplate(null)} disabled={create.isPending}>
              All agents
            </Button>
            <Button onClick={() => close(false)} disabled={create.isPending}>
              Cancel
            </Button>
            <Button variant="primary" type="submit" form="new-ai-agent" loading={create.isPending}>
              Create agent
            </Button>
          </>
        ) : undefined
      }
    >
      {template ? (
        <form id="new-ai-agent" onSubmit={submit} className="flex flex-col gap-3" noValidate>
          {otherError && <FormError error={create.error?.message} />}
          <Field label="Agent name" required hint="For you: shown in campaigns and the call history." error={fields.name}>
            <Input value={fill.name} maxLength={80} onChange={(e) => set("name", e.target.value)} placeholder="Speed-to-lead qualifier" autoFocus />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Name it says" required hint="It still says it is an AI." error={fields.personaName}>
              <Input value={fill.personaName} maxLength={40} onChange={(e) => set("personaName", e.target.value)} placeholder="Ava" />
            </Field>
            <Field label="Business name" required error={fields.businessName}>
              <Input value={fill.businessName} maxLength={120} onChange={(e) => set("businessName", e.target.value)} placeholder="Acme" autoComplete="organization" />
            </Field>
          </div>
          <Field label="Language" error={fields.language}>
            <Select<AiAgentLanguage>
              value={fill.language}
              onValueChange={(v) => setFill((f) => ({ ...f, language: v, voiceId: "", voiceName: "" }))}
              options={AI_AGENT_LANGUAGES.map((l) => ({ value: l.code, label: l.label }))}
            />
          </Field>
          <Field label="Voice" required hint="Voices that speak the language above." error={fields.voiceId}>
            <VoicePicker value={fill.voiceId} valueName={fill.voiceName} language={fill.language} onChange={(id, name) => setFill((f) => ({ ...f, voiceId: id, voiceName: name }))} />
          </Field>
        </form>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {AI_AGENT_TEMPLATES.map((t) => (
            <TemplateCard key={t.key} title={t.name} goal={AI_AGENT_GOAL_LABELS[t.goal]} summary={t.summary} bestFor={t.bestFor} onPick={() => pick(t)} />
          ))}
          <TemplateCard
            title="Start from scratch"
            icon={<PenLine />}
            summary="A blank agent with only the greeting and the AI disclosure filled in."
            bestFor="Writing your own script from the ground up."
            onPick={() => pick(SCRATCH)}
          />
        </div>
      )}
    </Modal>
  );
}

function TemplateCard({ title, goal, summary, bestFor, icon, onPick }: { title: string; goal?: string; summary: string; bestFor: string; icon?: ReactNode; onPick: () => void }) {
  const Glyph = ENTITY.aiAgents.icon;
  return (
    <button type="button" onClick={onPick} className="group flex flex-col gap-2.5 rounded-lg border border-line p-4 text-left hover:border-accent hover:bg-tint-pick">
      <div className="flex items-center gap-3">
        <IconTile icon={icon ?? <Glyph />} tint={icon ? "gray" : ENTITY.aiAgents.tint} size="md" />
        <span className="flex-1 text-sm font-semibold text-text-hi">{title}</span>
        <ChevronRight aria-hidden className="size-4 text-text-3 group-hover:text-accent-ink" />
      </div>
      <p className="text-sm text-text-2">{summary}</p>
      <p className="text-xs text-text-3">
        <span className="font-medium text-text-2">Best for: </span>
        {bestFor}
      </p>
      {goal && <span className="mt-auto inline-flex h-6 w-fit items-center rounded-xs bg-mute-chip px-2 text-2xs font-medium text-text-2">{goal}</span>}
    </button>
  );
}
