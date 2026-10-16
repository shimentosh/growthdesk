"use client";

import { useState, type FormEvent } from "react";
import type { z } from "zod";
import type { AiTestCallInput } from "@growthdesk/shared";
import { useAgentNumber } from "@/components/calls/callHooks";
import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Checkbox";
import { Modal } from "@/components/ui/Dialog";
import { Field, FormError } from "@/components/ui/Field";
import { EntityTile } from "@/components/ui/icons";
import { Input } from "@/components/ui/Input";
import { toast } from "@/components/ui/Toast";
import { useApiMutation } from "@/lib/query";
import { useWorkspace } from "@/lib/session";
import type { AiAgent } from "@/lib/types/ai-calling";
import type { CallRow } from "@/lib/types/calls";

type TestCallInputT = z.input<typeof AiTestCallInput>;

/**
 * The agent rings a phone the person vouches for, with sample values for
 * {{first_name}} and {{company}}. It runs the saved version of the agent, and
 * the call lands in the call history like any other.
 */
export function TestCallModal({ agent, open, onOpenChange }: { agent: Pick<AiAgent, "id" | "name">; open: boolean; onOpenChange: (open: boolean) => void }) {
  const ws = useWorkspace();
  // The rep's own number from click-to-call, when this browser remembers one: the usual phone to test on.
  const [mine] = useAgentNumber();
  const [toNumber, setToNumber] = useState(mine);
  const [firstName, setFirstName] = useState("");
  const [company, setCompany] = useState("");
  const [consent, setConsent] = useState(false);
  const call = useApiMutation<CallRow, TestCallInputT>({
    path: ws.path(`/call-agents/${agent.id}/test-call`),
    invalidate: [ws.key("calls"), ws.key("call-agents")],
    errorToast: false,
    onSuccess: (row) => {
      toast.success(`Calling ${row.toNumber || toNumber.trim()} — answer to hear the agent`, {
        description: "The transcript and result appear on the call once it ends.",
        action: { label: "Open call", href: ws.href(`/calls?call=${row.id}`) },
        duration: 10_000,
      });
      setConsent(false);
      onOpenChange(false);
    },
  });
  const fields = call.error?.fields ?? {};
  const close = (next: boolean) => {
    if (!next) call.reset();
    onOpenChange(next);
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const variables: Record<string, string> = {};
    if (firstName.trim()) variables.first_name = firstName.trim();
    if (company.trim()) variables.company = company.trim();
    // consent is a literal true in the schema; the button stays disabled until it is ticked.
    call.mutate({ toNumber: toNumber.trim(), variables, consent: true });
  };

  return (
    <Modal
      open={open}
      onOpenChange={close}
      dismissOnOutside={false}
      icon={<EntityTile of="aiAgents" size="md" />}
      title="Test call"
      description={`${agent.name} calls this number now and runs its saved script. Calling hours do not apply to a test.`}
      footer={
        <>
          <Button onClick={() => close(false)} disabled={call.isPending}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="ai-test-call" loading={call.isPending} disabled={!consent || !toNumber.trim()}>
            Call now
          </Button>
        </>
      }
    >
      <form id="ai-test-call" onSubmit={submit} className="flex flex-col gap-3" noValidate>
        {call.error && !call.error.isPlanLimit && !fields.toNumber && !fields.consent && <FormError error={call.error.message} />}
        <Field label="Phone number" required hint="International format, e.g. +14155550100." error={fields.toNumber}>
          <Input value={toNumber} onChange={(e) => setToNumber(e.target.value)} inputMode="tel" autoComplete="tel" placeholder="+14155550100" />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="First name" hint="Optional. Fills {{first_name}}." error={fields["variables.first_name"]}>
            <Input value={firstName} maxLength={300} onChange={(e) => setFirstName(e.target.value)} placeholder="there" />
          </Field>
          <Field label="Company" hint="Optional. Fills {{company}}." error={fields["variables.company"]}>
            <Input value={company} maxLength={300} onChange={(e) => setCompany(e.target.value)} placeholder="your company" />
          </Field>
        </div>
        <Checkbox checked={consent} onCheckedChange={setConsent} label="This is my number, or its owner agreed to a test call" />
        {fields.consent && <p className="text-xs text-bad-ink">{fields.consent}</p>}
      </form>
    </Modal>
  );
}
