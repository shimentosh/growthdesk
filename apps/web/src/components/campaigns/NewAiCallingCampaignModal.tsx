"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { AudioLines, ExternalLink } from "lucide-react";
import { AiAgentSelect } from "@/components/calls/AiAgentSelect";
import { useAiAgents } from "@/components/calls/callHooks";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Modal } from "@/components/ui/Dialog";
import { Field, FormError } from "@/components/ui/Field";
import { IconTile } from "@/components/ui/IconTile";
import { Input } from "@/components/ui/Input";
import { cn } from "@/lib/cn";
import { useApiMutation } from "@/lib/query";
import { useWorkspace, workspaceDetailKey } from "@/lib/session";
import type { CampaignCreateBody, CampaignDetail } from "@/lib/types/campaigns";
import { cleanSteps, type SequenceStep } from "@/lib/types/sequences";

type Flow = "one" | "retry" | "follow_up";

const FOLLOW_UP_BODY = `Hi {{first_name|there}},

I tried to reach you by phone yesterday and wanted to follow up here instead.

Would a short call this week be useful? Reply with a time that suits you, or let me know if someone else is better placed to talk.

Thanks`;

/** The steps each flow starts with (shared StepInput); all of them can be edited on the campaign afterwards. */
function flowSteps(flow: Flow, agentId: string): SequenceStep[] {
  const call: SequenceStep = { type: "ai_call", config: { agentId } };
  switch (flow) {
    case "one":
      return [call];
    case "retry":
      return [
        call,
        { type: "wait", config: { delayMinutes: 120 } },
        {
          type: "branch",
          config: {
            logic: {
              match: "any",
              rules: [
                { field: "call_outcome", op: "is", value: "no_answer" },
                { field: "call_outcome", op: "is", value: "busy" },
                { field: "call_outcome", op: "is", value: "left_voicemail" },
              ],
            },
            thenLength: 2,
            elseLength: 0,
          },
        },
        { type: "wait", config: { delayMinutes: 1440 } },
        { type: "ai_call", config: { agentId } },
      ];
    case "follow_up":
      return [call, { type: "wait", config: { delayMinutes: 1440 } }, { type: "email", config: { subject: "Following up on my call", body: FOLLOW_UP_BODY } }];
  }
}

/**
 * Name an AI calling campaign, choose the agent and a ready-made flow, and
 * create it (POST /campaigns with the flow's steps). It is an ordinary
 * outreach campaign: the audience, calling window and launch happen on its
 * page, which opens on success.
 */
export function NewAiCallingCampaignModal({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const ws = useWorkspace();
  const router = useRouter();
  const [name, setName] = useState("");
  const [picked, setPicked] = useState("");
  const [flow, setFlow] = useState<Flow>("one");
  const [tried, setTried] = useState(false);
  const agents = useAiAgents(open);
  const usable = (agents.data ?? []).filter((a) => !a.archivedAt);
  // With a single agent there is nothing to choose.
  const agentId = picked || (usable.length === 1 ? usable[0]!.id : "");
  const canBranch = ws.hasFeature("branching");
  const create = useApiMutation<CampaignDetail, CampaignCreateBody>({
    path: ws.path("/campaigns"),
    invalidate: [ws.key("campaigns"), workspaceDetailKey(ws.id)],
    success: "Campaign created",
    errorToast: false,
    onSuccess: (c) => {
      onOpenChange(false);
      router.push(ws.href(`/campaigns/${c.id}`));
    },
  });
  const change = (next: boolean) => {
    if (!next) {
      setName("");
      setPicked("");
      setFlow("one");
      setTried(false);
      create.reset();
    }
    onOpenChange(next);
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTried(true);
    if (!agentId) return;
    create.mutate({ name: name.trim(), steps: cleanSteps(flowSteps(flow, agentId)) });
  };
  const fields = create.error?.fields ?? {};
  const agentError = Object.entries(fields).find(([k]) => k.endsWith(".agentId"))?.[1] ?? (tried && !agentId ? "Choose the agent that makes the calls." : undefined);
  const stepsError = Object.entries(fields).find(([k]) => k.startsWith("steps") && !k.endsWith(".agentId"))?.[1];
  const canList = ws.can("calls.read");
  const noAgents = canList && !agents.isPending && !agents.isError && usable.length === 0;

  const flows: { value: Flow; label: string; description: string; disabled?: string }[] = [
    { value: "one", label: "One call", description: "The agent calls each contact once." },
    {
      value: "retry",
      label: "Call, retry next day if unanswered",
      description: "When nobody picks up, the line is busy or it reaches voicemail, the agent tries once more the next day.",
      disabled: canBranch ? undefined : "Needs a plan with conditional branches.",
    },
    {
      value: "follow_up",
      label: "Call, then a follow-up email next day",
      description: "Enrollments stop on their own when the person books, declines or opts out, so the email only reaches the rest. Needs a mailbox to send from.",
    },
  ];

  return (
    <Modal
      open={open}
      onOpenChange={change}
      icon={<IconTile icon={<AudioLines />} tint="cyan" size="md" />}
      title="New AI calling campaign"
      description="An AI voice agent calls your leads and records how each call went."
      footer={
        <>
          <Button onClick={() => change(false)} disabled={create.isPending}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="new-ai-campaign" loading={create.isPending} disabled={noAgents || !canList}>
            Create campaign
          </Button>
        </>
      }
    >
      <form id="new-ai-campaign" onSubmit={submit} noValidate className="flex flex-col gap-4">
        {create.error && !create.error.isPlanLimit && !Object.keys(fields).length && <FormError error={create.error.message} />}
        <Field label="Name" required error={fields.name}>
          <Input value={name} maxLength={120} autoFocus onChange={(e) => setName(e.target.value)} placeholder="Webinar leads: qualifying calls" />
        </Field>
        {!canList ? (
          <Callout tone="warn">Your role cannot list AI agents, so it cannot choose one for a campaign.</Callout>
        ) : noAgents ? (
          <Callout
            tone="warn"
            title="Create an AI agent first"
            action={
              ws.can("calls.agents") ? (
                <Button size="sm" variant="ghost" href={ws.href("/ai-agents")} onClick={() => change(false)}>
                  AI agents
                </Button>
              ) : undefined
            }
          >
            {ws.can("calls.agents")
              ? "An agent holds the voice and the script the calls follow. Create one, then come back to this campaign."
              : "An agent holds the voice and the script the calls follow. Ask someone who manages AI agents to create one."}
          </Callout>
        ) : (
          <Field
            label="AI agent"
            required
            error={agentError ?? (agents.isError ? `Agents could not be loaded: ${agents.error.message}` : undefined)}
            labelAction={
              <a href={ws.href("/ai-agents")} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-text-3 hover:text-text">
                Manage AI agents <ExternalLink aria-hidden className="size-3" />
              </a>
            }
          >
            <AiAgentSelect agents={usable} value={agentId} pending={agents.isPending} invalid={Boolean(agentError)} onChange={setPicked} />
          </Field>
        )}
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1.5 text-xs font-medium text-text-2">Flow</legend>
          {flows.map((o) => (
            <label
              key={o.value}
              className={cn(
                "flex items-start gap-2.5 rounded-md border px-3 py-2.5 transition-colors",
                o.disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer",
                flow === o.value ? "border-accent bg-tint-pick" : "border-line hover:bg-hover",
              )}
            >
              <input
                type="radio"
                name="ai-campaign-flow"
                value={o.value}
                checked={flow === o.value}
                disabled={Boolean(o.disabled)}
                onChange={() => setFlow(o.value)}
                className="mt-0.5 accent-[var(--accent)]"
              />
              <span>
                <span className="block text-sm font-medium text-text">{o.label}</span>
                <span className="block text-xs text-text-3">{o.disabled ?? o.description}</span>
              </span>
            </label>
          ))}
          {stepsError && <p className="text-xs text-bad-ink">{stepsError}</p>}
        </fieldset>
        <p className="text-xs text-text-3">
          It starts as a draft: choose who to call (only contacts with recorded consent and a phone number are called) and the calling window, then launch.
        </p>
      </form>
    </Modal>
  );
}
