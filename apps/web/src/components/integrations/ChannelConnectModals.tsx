"use client";

import { useState, type FormEvent } from "react";
import { Plug } from "lucide-react";
import type { z } from "zod";
import type { TelegramConnectInput, WhatsAppConnectInput } from "@growthdesk/shared";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Dialog";
import { Field, FormError } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { useApiMutation } from "@/lib/query";
import { useWorkspace } from "@/lib/session";
import type { ChannelIntegration } from "@/lib/types/integrations";

type WhatsAppInputT = z.input<typeof WhatsAppConnectInput>;
type TelegramInputT = z.input<typeof TelegramConnectInput>;

type ModalProps = { open: boolean; onOpenChange: (open: boolean) => void; onConnected?: (row: ChannelIntegration) => void };

const EMPTY_WA = { name: "", phoneNumberId: "", businessAccountId: "", accessToken: "", appSecret: "" };

/**
 * WhatsApp Cloud API. Meta is asked about the number before anything is
 * stored; its answer comes back inline when the details are wrong. After
 * connecting, the card shows the webhook URL and verify token to paste into
 * Meta's dashboard.
 */
export function WhatsAppConnectModal({ open, onOpenChange, onConnected }: ModalProps) {
  const ws = useWorkspace();
  const [v, setV] = useState(EMPTY_WA);
  const set = (k: keyof typeof EMPTY_WA, value: string) => setV((p) => ({ ...p, [k]: value }));
  const connect = useApiMutation<ChannelIntegration, WhatsAppInputT>({
    path: ws.path("/channels/whatsapp"),
    invalidate: [ws.key("channels")],
    success: (row) => `${row.name} connected — finish the webhook setup on its card`,
    errorToast: false,
    onSuccess: (row) => {
      setV(EMPTY_WA);
      onOpenChange(false);
      onConnected?.(row);
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
      phoneNumberId: v.phoneNumberId.trim(),
      businessAccountId: v.businessAccountId.trim() || undefined,
      accessToken: v.accessToken.trim(),
      appSecret: v.appSecret.trim(),
    });
  };

  return (
    <Modal
      open={open}
      onOpenChange={close}
      dismissOnOutside={false}
      title="Connect WhatsApp"
      description="Uses Meta's WhatsApp Cloud API. You'll find these in your Meta app under WhatsApp → API Setup."
      footer={
        <>
          <Button onClick={() => close(false)} disabled={connect.isPending}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="wa-connect" icon={<Plug />} loading={connect.isPending}>
            {connect.isPending ? "Checking with Meta…" : "Connect"}
          </Button>
        </>
      }
    >
      <form id="wa-connect" onSubmit={submit} className="flex flex-col gap-3" noValidate>
        {connect.error && !connect.error.isPlanLimit && !Object.keys(fields).length && <FormError error={connect.error.message} />}
        <Field label="Phone number ID" required hint="The numeric ID Meta shows next to the number — not the phone number itself." error={fields.phoneNumberId}>
          <Input value={v.phoneNumberId} onChange={(e) => set("phoneNumberId", e.target.value)} className="font-mono" autoComplete="off" />
        </Field>
        <Field label="WhatsApp Business Account ID" hint="Optional." error={fields.businessAccountId}>
          <Input value={v.businessAccountId} onChange={(e) => set("businessAccountId", e.target.value)} className="font-mono" autoComplete="off" />
        </Field>
        <Field label="Access token" required hint="A permanent System User token; temporary tokens expire within a day." error={fields.accessToken}>
          <Input type="password" value={v.accessToken} onChange={(e) => set("accessToken", e.target.value)} autoComplete="off" />
        </Field>
        <Field label="App secret" required hint="App settings → Basic. Used to check that webhooks really come from Meta." error={fields.appSecret}>
          <Input type="password" value={v.appSecret} onChange={(e) => set("appSecret", e.target.value)} autoComplete="off" />
        </Field>
        <Field label="Name" hint="Optional. Defaults to the number's verified name." error={fields.name}>
          <Input value={v.name} onChange={(e) => set("name", e.target.value)} />
        </Field>
        <p className="text-xs text-text-3">Tokens and secrets are stored encrypted and never shown again.</p>
      </form>
    </Modal>
  );
}

/** Telegram bot. The API checks the token with Telegram and registers message delivery itself. */
export function TelegramConnectModal({ open, onOpenChange, onConnected }: ModalProps) {
  const ws = useWorkspace();
  const [name, setName] = useState("");
  const [botToken, setBotToken] = useState("");
  const connect = useApiMutation<ChannelIntegration, TelegramInputT>({
    path: ws.path("/channels/telegram"),
    invalidate: [ws.key("channels")],
    success: (row) => `${row.name} connected`,
    errorToast: false,
    onSuccess: (row) => {
      setName("");
      setBotToken("");
      onOpenChange(false);
      onConnected?.(row);
    },
  });
  const fields = connect.error?.fields ?? {};
  const close = (next: boolean) => {
    if (!next) connect.reset();
    onOpenChange(next);
  };

  return (
    <Modal
      open={open}
      onOpenChange={close}
      dismissOnOutside={false}
      title="Connect a Telegram bot"
      description="Create a bot with @BotFather (/newbot), then paste the token it gives you."
      footer={
        <>
          <Button onClick={() => close(false)} disabled={connect.isPending}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="tg-connect" icon={<Plug />} loading={connect.isPending}>
            {connect.isPending ? "Checking with Telegram…" : "Connect"}
          </Button>
        </>
      }
    >
      <form
        id="tg-connect"
        onSubmit={(e) => {
          e.preventDefault();
          connect.mutate({ name: name.trim() || undefined, botToken: botToken.trim() });
        }}
        className="flex flex-col gap-3"
        noValidate
      >
        {connect.error && !connect.error.isPlanLimit && !Object.keys(fields).length && <FormError error={connect.error.message} />}
        <Field label="Bot token" required hint="Looks like 123456789:AA… — keep it private." error={fields.botToken}>
          <Input type="password" value={botToken} onChange={(e) => setBotToken(e.target.value)} className="font-mono" autoComplete="off" />
        </Field>
        <Field label="Name" hint="Optional. Defaults to the bot's @username." error={fields.name}>
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <p className="text-xs text-text-3">
          A bot can only message people who have opened a chat with it and pressed Start. The token is stored encrypted and never shown again.
        </p>
      </form>
    </Modal>
  );
}
