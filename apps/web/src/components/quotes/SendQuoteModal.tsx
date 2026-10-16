"use client";

import { useState, type FormEvent } from "react";
import { Mail, Send } from "lucide-react";
import { formLevelError, useOpenKey } from "@/components/pipeline/utils";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Modal } from "@/components/ui/Dialog";
import { Field, FormError } from "@/components/ui/Field";
import { Input, NativeSelect, Textarea } from "@/components/ui/Input";
import { LoadingBlock } from "@/components/ui/Skeleton";
import { useApiMutation, useApiQuery } from "@/lib/query";
import { useWorkspace } from "@/lib/session";
import type { QuoteDetail, QuoteSendOptions } from "@/lib/types/quotes";

const FIELDS = ["mailboxId", "to", "subject", "message"] as const;

type Props = { open: boolean; onOpenChange: (open: boolean) => void; quote: QuoteDetail };

/**
 * Email the buyer a link to the quote (POST /quotes/:id/send) from one of the
 * workspace's mailboxes. It goes out like any email written in the inbox, so
 * it lands in the contact's conversations and their replies come back there.
 */
export function SendQuoteModal(props: Props) {
  const key = useOpenKey(props.open);
  return <Inner key={key} {...props} />;
}

function Inner({ open, onOpenChange, quote }: Props) {
  const ws = useWorkspace();
  const options = useApiQuery<QuoteSendOptions>(ws.key("quotes", quote.id, "send-options"), open ? ws.path(`/quotes/${quote.id}/send-options`) : null, { staleTime: 0 });
  const [draft, setDraft] = useState<{ mailboxId: string; to: string; subject: string; message: string } | null>(null);
  const o = options.data;
  // The form starts from the API's defaults once they arrive.
  const d = draft ?? (o ? { mailboxId: o.defaultMailboxId ?? "", to: o.to, subject: o.subject, message: o.message } : null);
  const set = (k: "mailboxId" | "to" | "subject" | "message", v: string) => d && setDraft({ ...d, [k]: v });
  const resend = quote.status !== "draft";

  const send = useApiMutation<QuoteDetail, Record<string, unknown>>({
    path: ws.path(`/quotes/${quote.id}/send`),
    invalidate: [ws.key("quotes"), ws.key("inbox")],
    success: `Quote ${quote.numberLabel} sent`,
    errorToast: false,
    onSuccess: () => onOpenChange(false),
  });
  const fields = send.error?.fields ?? {};

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!d) return;
    send.mutate({ ...(d.mailboxId ? { mailboxId: d.mailboxId } : {}), to: d.to.trim(), subject: d.subject.trim(), message: d.message.trim() });
  };

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      dismissOnOutside={false}
      title={resend ? `Send ${quote.numberLabel} again` : `Send ${quote.numberLabel}`}
      description="The buyer gets a link to view, accept and sign the quote online."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" type="submit" form="send-quote-form" icon={<Send />} loading={send.isPending} disabled={!d || !d.to.trim() || !o?.mailboxes.length}>
            Send
          </Button>
        </>
      }
    >
      {options.isPending ? (
        <LoadingBlock />
      ) : options.isError ? (
        <FormError error={options.error.message} />
      ) : (
        d &&
        o && (
          <form id="send-quote-form" onSubmit={submit} noValidate className="flex flex-col gap-4">
            <FormError error={formLevelError(send.error, FIELDS)} />
            {!o.mailboxes.length && (
              <Callout tone="warn" title="No connected mailbox">
                Connect one in Settings → Mailboxes to email quotes, or close this and use Copy link to share it yourself.
              </Callout>
            )}
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="From" error={fields.mailboxId}>
                <NativeSelect
                  value={d.mailboxId}
                  icon={<Mail />}
                  onChange={(e) => set("mailboxId", e.target.value)}
                  options={o.mailboxes.map((m) => ({ value: m.id, label: m.displayName ? `${m.displayName} <${m.email}>` : m.email }))}
                  placeholder={o.mailboxes.length ? undefined : "No mailbox"}
                />
              </Field>
              <Field label="To" required error={fields.to} hint={o.toName && d.to === o.to ? o.toName : undefined}>
                <Input type="email" value={d.to} maxLength={254} onChange={(e) => set("to", e.target.value)} placeholder="buyer@company.com" />
              </Field>
            </div>
            <Field label="Subject" error={fields.subject}>
              <Input value={d.subject} maxLength={300} onChange={(e) => set("subject", e.target.value)} />
            </Field>
            <Field label="Message" error={fields.message} hint="The link to the quote is added under your message, with its total.">
              <Textarea rows={7} value={d.message} maxLength={5000} onChange={(e) => set("message", e.target.value)} />
            </Field>
            <p className="truncate rounded-md border border-line bg-well px-3 py-2 font-mono text-xs text-text-3">{o.publicUrl}</p>
          </form>
        )
      )}
    </Modal>
  );
}
