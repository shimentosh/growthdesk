"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { Send } from "lucide-react";
import { labelOf } from "@growthdesk/shared";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Card, CardBody } from "@/components/ui/Card";
import { Modal } from "@/components/ui/Dialog";
import { Field, FormError } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { toast } from "@/components/ui/Toast";
import { ContactPicker, contactLabel } from "@/components/pickers/Pickers";
import { StepsEditor } from "@/components/sequences/StepsEditor";
import { useApiMutation } from "@/lib/query";
import { useMe, useWorkspace } from "@/lib/session";
import type { CampaignDetail, StepTestBody, StepTestResult } from "@/lib/types/campaigns";
import { cleanSteps, stepsOf, type SequenceStep } from "@/lib/types/sequences";
import { lockedReason, useCampaignPatch } from "./common";

/**
 * The campaign's own copy of its steps, edited with the shared sequence
 * StepsEditor and saved as a whole list (PATCH steps). Editable while draft
 * or paused; the API re-validates and answers field errors keyed
 * steps.<i>.config.<key>, which the editor shows on the step.
 *
 * Once anyone is enrolled the existing steps keep their number, kind and
 * branch sizes (an enrollment's place is a step number): content and timing
 * can change and steps can be added at the end. The same rule is checked
 * here, to say so before saving, and enforced by the API.
 */
export function CampaignSteps({ campaign }: { campaign: CampaignDetail }) {
  const ws = useWorkspace();
  const [baseline, setBaseline] = useState<SequenceStep[]>(() => stepsOf(campaign.steps));
  const [steps, setSteps] = useState<SequenceStep[]>(baseline);
  const save = useCampaignPatch(campaign.id, "Steps saved");
  const locked = lockedReason(campaign.status);
  const readOnly = Boolean(locked) || !ws.can("campaigns.write");
  const dirty = JSON.stringify(baseline) !== JSON.stringify(steps);
  const startedBefore = campaign.status === "paused" && campaign.stats.enrolled > 0;
  const restructured = startedBefore && dirty && changesStructure(baseline, steps);
  const fields = save.error?.fields ?? {};
  const [testing, setTesting] = useState<number | null>(null);
  const canTest = ws.can("campaigns.write");
  // Tests send the saved step, so they are offered for saved email steps while nothing is unsaved.
  const testButton = (step: SequenceStep, index: number) =>
    canTest && step.type === "email" && baseline[index]?.type === "email" ? (
      <Button
        size="sm"
        variant="ghost"
        icon={<Send />}
        disabled={dirty}
        title={dirty ? "Save or discard your changes first: the test sends the saved step." : "Send this email to yourself as the engine would"}
        onClick={() => setTesting(index)}
      >
        Send test
      </Button>
    ) : null;

  return (
    <div className="flex flex-col gap-3">
      {locked && <Callout tone="info">{locked}</Callout>}
      {!locked && startedBefore && (
        <Callout tone={restructured ? "bad" : "info"}>
          Contacts are already enrolled, and each one&apos;s place is kept by step number. You can edit what a step sends and when, and add steps at the end, but not insert,
          remove, reorder or change the kind of existing steps. Duplicate the campaign to restructure it.
        </Callout>
      )}
      <ChannelNotes steps={steps} />
      {save.error && !save.error.isPlanLimit && !Object.keys(fields).some((k) => k.startsWith("steps")) && <FormError error={save.error.message} />}
      <Card>
        <CardBody>
          <StepsEditor steps={steps} onChange={setSteps} readOnly={readOnly} errors={fields} stepActions={testButton} />
        </CardBody>
      </Card>
      {!readOnly && (
        <div className="flex items-center justify-end gap-2">
          {dirty && <span className="text-xs text-text-3">Unsaved changes</span>}
          {dirty && (
            <Button
              onClick={() => {
                setSteps(baseline);
                save.reset();
              }}
              disabled={save.isPending}
            >
              Discard
            </Button>
          )}
          <Button
            variant="primary"
            disabled={!dirty || restructured}
            loading={save.isPending}
            onClick={() =>
              save.mutate(
                { steps: cleanSteps(steps) },
                {
                  onSuccess: (c) => {
                    const next = stepsOf(c.steps);
                    setBaseline(next);
                    setSteps(next);
                  },
                },
              )
            }
          >
            Save steps
          </Button>
        </div>
      )}
      {testing !== null && <StepTestModal campaign={campaign} position={testing} onClose={() => setTesting(null)} />}
    </div>
  );
}

/**
 * POST /steps/:position/test: the saved email step rendered as the engine
 * would (personalized for a contact when one is picked, with the unsubscribe
 * footer), marked "[Test]" and counted nowhere. A send the API declined comes
 * back as `sent: false` with its reason, shown inline.
 */
function StepTestModal({ campaign, position, onClose }: { campaign: CampaignDetail; position: number; onClose: () => void }) {
  const ws = useWorkspace();
  const me = useMe();
  const [to, setTo] = useState<string | null>(null);
  const [contact, setContact] = useState<{ id: string; label: string } | null>(null);
  const contactId = contact?.id ?? null;
  const [declined, setDeclined] = useState<StepTestResult | null>(null);
  const send = useApiMutation<StepTestResult, StepTestBody>({
    path: ws.path(`/campaigns/${campaign.id}/steps/${position}/test`),
    errorToast: false,
    onSuccess: (r) => {
      if (!r.sent) return setDeclined(r);
      toast.success(`Test sent to ${r.to}`, {
        description: r.missing.length ? `From ${r.from}. No value for ${r.missing.map((v) => `{{${v}}}`).join(", ")}, so those show as written.` : `From ${r.from}.`,
      });
      onClose();
    },
  });
  const recipient = to ?? me.data?.user.email ?? "";
  const fields = send.error?.fields ?? {};
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setDeclined(null);
    send.mutate({ to: recipient.trim(), contactId });
  };
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Send step ${position + 1} as a test`}
      description="Sent from a mailbox the campaign may use, marked [Test]. It is not counted in the campaign's numbers."
      footer={
        <>
          <Button onClick={onClose} disabled={send.isPending}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="step-test" icon={<Send />} loading={send.isPending}>
            Send test
          </Button>
        </>
      }
    >
      <form id="step-test" onSubmit={submit} noValidate className="flex flex-col gap-3">
        {send.error && !send.error.isPlanLimit && !Object.keys(fields).length && <FormError error={send.error.message} />}
        {declined && (
          <Callout tone="bad" title={`Not sent (${labelOf(declined.status)})`}>
            {declined.reason || "The mailbox did not send the message."}
          </Callout>
        )}
        <Field label="Send to" required error={fields.to}>
          <Input type="email" value={recipient} onChange={(e) => setTo(e.target.value)} autoComplete="email" />
        </Field>
        <Field label="Personalize as" error={fields.contactId} hint="Optional. Without a contact, tokens without a fallback are left as written.">
          <ContactPicker
            value={contactId}
            valueLabel={contact?.label}
            placeholder="Search a contact"
            onChange={(id, c) => setContact(id ? { id, label: c ? contactLabel(c) : "Contact" } : null)}
          />
        </Field>
      </form>
    </Modal>
  );
}

const lanes = (s: SequenceStep) => `${Number(s.config.thenLength ?? 0)}/${Number(s.config.elseLength ?? 0)}`;

/** Mirrors the API's structureChange: true when an existing step is removed, moved, swapped or its branch resized. */
function changesStructure(before: SequenceStep[], after: SequenceStep[]): boolean {
  if (after.length < before.length) return true;
  return before.some((s, i) => s.type !== after[i]!.type || (s.type === "branch" && lanes(s) !== lanes(after[i]!)));
}

/** What each non-email channel needs before its steps can reach anyone. */
const CHANNEL_NOTES: { type: "whatsapp" | "telegram" | "call_task"; title: string; text: string; href?: string }[] = [
  {
    type: "whatsapp",
    title: "WhatsApp",
    text: "Needs a connected WhatsApp Business number. The first message to someone must use an approved template; free text only works inside a 24-hour reply window.",
    href: "/settings/channels",
  },
  {
    type: "telegram",
    title: "Telegram",
    text: "Only reaches people who have messaged your bot first. For anyone else, use a manual task step instead.",
    href: "/settings/channels",
  },
  { type: "call_task", title: "Calls", text: "A call step creates a call task for the owner, with click-to-call when calling is set up.", href: "/settings/calling" },
];

function ChannelNotes({ steps }: { steps: SequenceStep[] }) {
  const ws = useWorkspace();
  const used = new Set(steps.map((s) => s.type));
  const notes = CHANNEL_NOTES.filter((n) => used.has(n.type));
  if (!notes.length) return null;
  return (
    <Callout tone="info" title="Channel requirements">
      <ul className="flex flex-col gap-1">
        {notes.map((n) => (
          <li key={n.type}>
            <span className="font-medium text-text">{n.title}:</span> {n.text}
            {n.href && ws.can("integrations.read") && (
              <>
                {" "}
                <Link href={ws.href(n.href)} className="text-accent-ink hover:text-accent-hi">
                  Set up
                </Link>
              </>
            )}
          </li>
        ))}
      </ul>
    </Callout>
  );
}
