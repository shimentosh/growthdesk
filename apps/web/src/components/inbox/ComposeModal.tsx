"use client";

import { useState, type FormEvent } from "react";
import { labelOf } from "@growthdesk/shared";
import { AiComposeDraftButton } from "@/components/ai/AiComposeDraft";
import { ContactPicker } from "@/components/pickers/Pickers";
import { formLevelError, useOpenKey } from "@/components/pipeline/utils";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Modal } from "@/components/ui/Dialog";
import { Field, FormError } from "@/components/ui/Field";
import { Input, NativeSelect, Textarea } from "@/components/ui/Input";
import { useApiMutation, useApiQuery } from "@/lib/query";
import { useWorkspace } from "@/lib/session";
import type { Paged } from "@/lib/types";
import type { InboxChannel, InboxMessage } from "@/lib/types/inbox";
import type { Mailbox } from "@/lib/types/integrations";

const FIELDS = ["channel", "contactId", "mailboxId", "subject", "body", "templateId"] as const;

type Reachability = {
  reachable: boolean;
  reason: string;
  freeFormAllowed?: boolean;
};
type WaTemplate = {
  id: string;
  name: string;
  body: string;
  waTemplate: string;
  waLanguage: string;
};

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSent: (conversationId: string) => void;
};

/** A new message to a contact (POST /inbox/compose): email from a mailbox, or WhatsApp / Telegram through the connected account. */
export function ComposeModal(props: Props) {
  const key = useOpenKey(props.open);
  return <Inner key={key} {...props} />;
}

function Inner({ open, onOpenChange, onSent }: Props) {
  const ws = useWorkspace();
  const [contactId, setContactId] = useState<string | null>(null);
  const [channel, setChannel] = useState<InboxChannel>("email");
  const [mailboxId, setMailboxId] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [templateId, setTemplateId] = useState("");

  const isEmail = channel === "email";
  const mailboxes = useApiQuery<Mailbox[]>(ws.key("mailboxes", "list"), isEmail && ws.can("integrations.read") ? ws.path("/mailboxes") : null);
  const reach = useApiQuery<Reachability>(ws.key("inbox", "reachability", channel, contactId), !isEmail && contactId ? ws.path("/channels/reachability") : null, {
    query: { channel, contactId },
  });
  const templates = useApiQuery<Paged<WaTemplate>>(ws.key("templates", "whatsapp-approved"), channel === "whatsapp" && ws.can("templates.read") ? ws.path("/templates") : null, {
    query: { channel: "whatsapp", pageSize: 200 },
  });
  const approved = (templates.data?.items ?? []).filter((t) => t.waTemplate);

  const send = useApiMutation<InboxMessage, Record<string, unknown>>({
    path: ws.path("/inbox/compose"),
    invalidate: [ws.key("inbox"), ws.key("contacts")],
    success: "Sent",
    errorToast: false,
    onSuccess: (m) => {
      onOpenChange(false);
      onSent(m.conversationId);
    },
  });
  const fields = send.error?.fields ?? {};
  const formError = formLevelError(send.error, FIELDS);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!contactId) return;
    send.mutate({
      channel,
      contactId,
      body: body.trim(),
      ...(isEmail ? { subject: subject.trim(), ...(mailboxId ? { mailboxId } : {}) } : {}),
      ...(channel === "whatsapp" && templateId ? { templateId } : {}),
    });
  };

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="New message"
      size="lg"
      dismissOnOutside={false}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" type="submit" form="compose-form" loading={send.isPending} disabled={!contactId || !body.trim()}>
            Send
          </Button>
        </>
      }
    >
      <form id="compose-form" onSubmit={submit} className="flex flex-col gap-4">
        <FormError error={formError} />
        <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_180px]">
          <Field label="To" required error={fields.contactId}>
            <ContactPicker value={contactId} onChange={(id) => setContactId(id)} />
          </Field>
          <Field label="Channel" error={fields.channel}>
            <NativeSelect
              value={channel}
              onChange={(e) => {
                setChannel(e.target.value as InboxChannel);
                setTemplateId("");
              }}
              options={(["email", "whatsapp", "telegram"] as const).map((c) => ({ value: c, label: labelOf(c) }))}
            />
          </Field>
        </div>

        {!isEmail && contactId && reach.data && <Callout tone={!reach.data.reachable || reach.data.freeFormAllowed === false ? "warn" : "info"}>{reach.data.reason}</Callout>}

        {isEmail && (
          <div className="grid gap-4 sm:grid-cols-2">
            {ws.can("integrations.read") ? (
              <Field label="From" error={fields.mailboxId} hint={mailboxId ? undefined : "Automatic: the connected mailbox with the most room left today."}>
                <NativeSelect
                  value={mailboxId}
                  onChange={(e) => setMailboxId(e.target.value)}
                  placeholder="Automatic"
                  options={(mailboxes.data ?? []).map((b) => ({
                    value: b.id,
                    label: `${b.displayName ? `${b.displayName} <${b.email}>` : b.email}${b.status !== "connected" ? ` (${labelOf(b.status)})` : ""}`,
                  }))}
                />
              </Field>
            ) : (
              <Field label="From" hint="The connected mailbox with the most room left today.">
                <Input readOnly value="Automatic" />
              </Field>
            )}
            <Field label="Subject" required error={fields.subject}>
              <Input value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={300} />
            </Field>
          </div>
        )}

        {channel === "whatsapp" && ws.can("templates.read") && (
          <Field
            label="Approved WhatsApp template"
            error={fields.templateId}
            hint="WhatsApp only allows free-form text within 24 hours of their last message; outside it, send an approved template."
          >
            <NativeSelect
              value={templateId}
              onChange={(e) => {
                setTemplateId(e.target.value);
                const t = approved.find((x) => x.id === e.target.value);
                if (t && !body.trim()) setBody(t.body);
              }}
              placeholder="None — free-form text"
              options={approved.map((t) => ({
                value: t.id,
                label: `${t.name} (${t.waTemplate})`,
              }))}
            />
          </Field>
        )}

        <Field
          label="Message"
          required
          error={fields.body}
          labelAction={
            <AiComposeDraftButton
              contactId={contactId}
              channel={channel}
              brief={body}
              onDraft={(d) => {
                setBody(d.body);
                if (isEmail && d.subject && !subject.trim()) setSubject(d.subject);
              }}
            />
          }
        >
          <Textarea rows={7} value={body} onChange={(e) => setBody(e.target.value)} maxLength={50000} />
        </Field>
      </form>
    </Modal>
  );
}
