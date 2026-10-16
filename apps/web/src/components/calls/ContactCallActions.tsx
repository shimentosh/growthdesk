"use client";

import { useState, type FormEvent } from "react";
import { AudioLines, ListPlus, Phone } from "lucide-react";
import { aiCallBlocker } from "@growthdesk/shared";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Modal } from "@/components/ui/Dialog";
import { Field, FormError } from "@/components/ui/Field";
import { IconTile } from "@/components/ui/IconTile";
import { toast } from "@/components/ui/Toast";
import { useApiMutation } from "@/lib/query";
import { useWorkspace } from "@/lib/session";
import type { AiAgent } from "@/lib/types/ai-calling";
import type { CallRow } from "@/lib/types/calls";
import type { ContactDetail } from "@/lib/types/crm";
import { AddToQueueModal } from "./AddToQueueModal";
import { AiAgentSelect } from "./AiAgentSelect";
import { CallDrawer } from "./CallDrawer";
import { useAiAgents } from "./callHooks";

/**
 * "Call", "AI call" and "Add to call list" for a contact record's header. The
 * drawer places the call through Twilio when it is connected (or explains how
 * to dial and log it); either way the API re-checks do-not-contact first. "AI
 * call" shows once the workspace has an AI agent.
 */
export function ContactCallActions({ contact }: { contact: ContactDetail }) {
  const ws = useWorkspace();
  const [calling, setCalling] = useState(false);
  const [queueing, setQueueing] = useState(false);
  const [aiCalling, setAiCalling] = useState(false);
  const canCall = ws.can("calls.make");
  const agents = useAiAgents(canCall && ws.hasFeature("calling"));
  const usable = (agents.data ?? []).filter((a) => !a.archivedAt);
  if (!canCall) return null;
  const blocked = contact.doNotContact ? "Marked do not contact." : null;
  const aiBlocked = aiCallBlocker({ phone: contact.phone, consentStatus: contact.consentStatus, doNotContact: contact.doNotContact });
  return (
    <>
      <Button icon={<Phone />} onClick={() => setCalling(true)} disabled={Boolean(blocked)} title={blocked ?? undefined}>
        {contact.phone ? "Call" : "Log call"}
      </Button>
      {usable.length > 0 && (
        <Button icon={<AudioLines />} onClick={() => setAiCalling(true)} disabled={Boolean(aiBlocked)} title={aiBlocked ?? "An AI agent calls this contact now"}>
          AI call
        </Button>
      )}
      <Button
        icon={<ListPlus />}
        onClick={() => setQueueing(true)}
        disabled={Boolean(blocked) || !contact.phone}
        title={blocked ?? (!contact.phone ? "No phone number on file" : undefined)}
      >
        Add to call list
      </Button>
      <CallDrawer open={calling} onOpenChange={setCalling} contact={contact} blocked={blocked} />
      <AddToQueueModal open={queueing} onOpenChange={setQueueing} initial={[contact]} />
      {aiCalling && <AiCallModal contact={contact} agents={usable} onClose={() => setAiCalling(false)} />}
    </>
  );
}

/**
 * Pick an agent and POST /call-agents/:id/call. The API applies the same rules
 * as a campaign step (consent, do-not-contact, calling hours) and answers 409
 * with the reason when one says no, shown here as it comes.
 */
function AiCallModal({ contact, agents, onClose }: { contact: ContactDetail; agents: AiAgent[]; onClose: () => void }) {
  const ws = useWorkspace();
  const [picked, setPicked] = useState(agents.length === 1 ? agents[0]!.id : "");
  const [tried, setTried] = useState(false);
  const call = useApiMutation<CallRow, { agentId: string }>({
    path: (v) => ws.path(`/call-agents/${v.agentId}/call`),
    body: () => ({ contactId: contact.id }),
    invalidate: [ws.key("calls"), ws.key("contacts", "detail", contact.id)],
    errorToast: false,
    onSuccess: (c) => {
      toast.success(`${c.agent?.name ?? "The agent"} is calling ${contact.fullName || contact.phone || "the contact"}`, {
        description: "The outcome, summary and transcript appear on the call when it ends.",
        action: { label: "View call", href: ws.href(`/calls?tab=history&call=${c.id}`) },
      });
      onClose();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTried(true);
    if (picked) call.mutate({ agentId: picked });
  };
  const agentError = call.error?.fields?.contactId ?? (tried && !picked ? "Choose the agent that makes the call." : undefined);
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      size="sm"
      icon={<IconTile icon={<AudioLines />} tint="cyan" size="md" />}
      title="AI call"
      description={`An AI agent calls ${contact.fullName || "this contact"} at ${contact.phone ?? "their number"} now.`}
      footer={
        <>
          <Button onClick={onClose} disabled={call.isPending}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="ai-call" icon={<AudioLines />} loading={call.isPending}>
            Call now
          </Button>
        </>
      }
    >
      <form id="ai-call" onSubmit={submit} noValidate className="flex flex-col gap-3">
        {call.error && !call.error.isPlanLimit && !agentError && <FormError error={call.error.message} />}
        <Field label="AI agent" required error={agentError}>
          <AiAgentSelect agents={agents} value={picked} invalid={Boolean(agentError)} onChange={setPicked} />
        </Field>
        <Callout tone="info">
          Calls are placed only within calling hours in the contact&apos;s time zone{contact.timezone ? ` (${contact.timezone})` : ""}, and the agent says it is an AI.
        </Callout>
      </form>
    </Modal>
  );
}
