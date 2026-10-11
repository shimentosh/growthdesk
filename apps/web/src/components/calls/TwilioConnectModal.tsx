"use client";

import { useState, type FormEvent } from "react";
import type { z } from "zod";
import type { TwilioConnectInput } from "@growthdesk/shared";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Dialog";
import { Field, FormError } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { useApiMutation } from "@/lib/query";
import { useWorkspace } from "@/lib/session";
import type { ChannelIntegration } from "@/lib/types/integrations";

type TwilioInputT = z.input<typeof TwilioConnectInput>;

const EMPTY = { name: "", accountSid: "", authToken: "", callerId: "" };

/**
 * Twilio Programmable Voice. The API asks Twilio about the account before
 * anything is stored; Twilio's answer comes back inline when the details are
 * wrong. Nothing needs configuring in Twilio's console: each call tells
 * Twilio where to fetch its instructions and send its status.
 */
export function TwilioConnectModal({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const ws = useWorkspace();
  const [v, setV] = useState(EMPTY);
  const set = (k: keyof typeof EMPTY, value: string) => setV((p) => ({ ...p, [k]: value }));
  const connect = useApiMutation<ChannelIntegration, TwilioInputT>({
    path: ws.path("/calls/twilio"),
    invalidate: [ws.key("channels"), ws.key("calls")],
    success: (row) => `${row.name} connected`,
    errorToast: false,
    onSuccess: () => {
      setV(EMPTY);
      onOpenChange(false);
    },
  });
  const fields = connect.error?.fields ?? {};
  const close = (next: boolean) => {
    if (!next) connect.reset();
    onOpenChange(next);
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    connect.mutate({
      name: v.name.trim() || undefined,
      accountSid: v.accountSid.trim(),
      authToken: v.authToken.trim(),
      callerId: v.callerId.trim(),
    });
  };

  return (
    <Modal
      open={open}
      onOpenChange={close}
      dismissOnOutside={false}
      title="Connect Twilio"
      description="Find the Account SID and Auth Token on your Twilio console's dashboard."
      footer={
        <>
          <Button onClick={() => close(false)} disabled={connect.isPending}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="twilio-connect" loading={connect.isPending}>
            {connect.isPending ? "Checking with Twilio…" : "Connect"}
          </Button>
        </>
      }
    >
      <form id="twilio-connect" onSubmit={submit} className="flex flex-col gap-3" noValidate>
        {connect.error && !connect.error.isPlanLimit && !Object.keys(fields).length && <FormError error={connect.error.message} />}
        <Field label="Account SID" required hint="Starts with AC." error={fields.accountSid}>
          <Input value={v.accountSid} onChange={(e) => set("accountSid", e.target.value)} className="font-mono" autoComplete="off" />
        </Field>
        <Field label="Auth token" required error={fields.authToken}>
          <Input type="password" value={v.authToken} onChange={(e) => set("authToken", e.target.value)} autoComplete="off" />
        </Field>
        <Field
          label="Caller ID"
          required
          hint="The number contacts see, in international format (+14155550100). It must be a Twilio number on this account or a caller ID you verified with Twilio."
          error={fields.callerId}
        >
          <Input value={v.callerId} onChange={(e) => set("callerId", e.target.value)} inputMode="tel" autoComplete="off" />
        </Field>
        <Field label="Name" hint="Optional. Defaults to the Twilio account's name." error={fields.name}>
          <Input value={v.name} onChange={(e) => set("name", e.target.value)} />
        </Field>
        <p className="text-xs text-text-3">The auth token is stored encrypted and never shown again. Twilio bills calls to this account.</p>
      </form>
    </Modal>
  );
}
