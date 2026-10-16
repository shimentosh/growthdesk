"use client";

import { useState, type FormEvent } from "react";
import type { z } from "zod";
import type { CartesiaConnectInput } from "@growthdesk/shared";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Dialog";
import { Field, FormError } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { useApiMutation } from "@/lib/query";
import { useWorkspace } from "@/lib/session";
import type { AiCallingConnection } from "@/lib/types/ai-calling";

type CartesiaInputT = z.input<typeof CartesiaConnectInput>;

const EMPTY = { name: "", apiKey: "" };

/**
 * Connect (or reconnect) Cartesia. The API checks the key by listing the
 * account's phone numbers and registers the call-events webhook; Cartesia's
 * answer comes back inline when the key is wrong.
 */
export function CartesiaConnectModal({ open, onOpenChange, reconnect }: { open: boolean; onOpenChange: (open: boolean) => void; reconnect?: boolean }) {
  const ws = useWorkspace();
  const [v, setV] = useState(EMPTY);
  const set = (k: keyof typeof EMPTY, value: string) => setV((p) => ({ ...p, [k]: value }));
  const connect = useApiMutation<AiCallingConnection, CartesiaInputT>({
    path: ws.path("/ai-calling/cartesia"),
    invalidate: [ws.key("ai-calling"), ws.key("channels"), ws.key("call-agents")],
    success: (row) => (row.status === "connected" ? "Cartesia connected" : "Cartesia connected — it needs a phone number"),
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
    connect.mutate({ apiKey: v.apiKey.trim(), name: v.name.trim() || undefined });
  };

  return (
    <Modal
      open={open}
      onOpenChange={close}
      dismissOnOutside={false}
      title={reconnect ? "Replace the Cartesia API key" : "Connect Cartesia"}
      description={
        <>
          Create an API key at{" "}
          <a href="https://play.cartesia.ai/keys" target="_blank" rel="noreferrer noopener" className="font-medium text-accent-ink hover:text-accent-hi">
            play.cartesia.ai/keys
          </a>
          . The account needs a phone number to call from.
        </>
      }
      footer={
        <>
          <Button onClick={() => close(false)} disabled={connect.isPending}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="cartesia-connect" loading={connect.isPending}>
            {connect.isPending ? "Checking with Cartesia…" : "Connect"}
          </Button>
        </>
      }
    >
      <form id="cartesia-connect" onSubmit={submit} className="flex flex-col gap-3" noValidate>
        {connect.error && !connect.error.isPlanLimit && <FormError error={connect.error.message} />}
        <Field label="API key" required error={fields.apiKey}>
          <Input type="password" value={v.apiKey} onChange={(e) => set("apiKey", e.target.value)} className="font-mono" autoComplete="off" />
        </Field>
        <Field label="Name" hint="Optional. Defaults to “Cartesia”." error={fields.name}>
          <Input value={v.name} maxLength={80} onChange={(e) => set("name", e.target.value)} />
        </Field>
        <p className="text-xs text-text-3">
          The key is stored encrypted and never shown again. Cartesia bills the calls to this account.
          {reconnect && " Agents are saved to the account again before their next call."}
        </p>
      </form>
    </Modal>
  );
}
