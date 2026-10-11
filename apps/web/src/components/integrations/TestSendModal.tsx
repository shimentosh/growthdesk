"use client";

import { useState, type FormEvent } from "react";
import { Send } from "lucide-react";
import type { z } from "zod";
import type { TestSendInput } from "@growthdesk/shared";
import { labelOf } from "@growthdesk/shared";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Modal } from "@/components/ui/Dialog";
import { Field, FormError } from "@/components/ui/Field";
import { Input, Textarea } from "@/components/ui/Input";
import { toast } from "@/components/ui/Toast";
import { useApiMutation } from "@/lib/query";
import { useMe, useWorkspace } from "@/lib/session";
import type { Mailbox, TestSendResult } from "@/lib/types/integrations";

type TestSendInputT = z.input<typeof TestSendInput>;

/**
 * Sends one real message through the normal send path (so it proves relaying,
 * not just the login). The API allows 20 tests per mailbox per hour. A send
 * the API declined comes back as `sent: false` with its reason, shown inline.
 */
export function TestSendModal({ mailbox, open, onOpenChange }: { mailbox: Pick<Mailbox, "id" | "email">; open: boolean; onOpenChange: (open: boolean) => void }) {
  const ws = useWorkspace();
  const me = useMe();
  const [to, setTo] = useState<string | null>(null);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [declined, setDeclined] = useState<TestSendResult | null>(null);

  const send = useApiMutation<TestSendResult, TestSendInputT>({
    path: ws.path(`/mailboxes/${mailbox.id}/test`),
    invalidate: [ws.key("mailboxes")],
    errorToast: false,
    onSuccess: (r) => {
      if (r.sent) {
        toast.success(`Test sent to ${r.to}`, { description: "Check that inbox (and its spam folder)." });
        setDeclined(null);
        onOpenChange(false);
      } else {
        setDeclined(r);
      }
    },
  });

  const recipient = to ?? me.data?.user.email ?? "";
  const fields = send.error?.fields ?? {};
  const close = (next: boolean) => {
    if (!next) {
      send.reset();
      setDeclined(null);
    }
    onOpenChange(next);
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setDeclined(null);
    send.mutate({ to: recipient.trim(), subject: subject.trim() || undefined, body: body.trim() || undefined });
  };

  return (
    <Modal
      open={open}
      onOpenChange={close}
      title="Send a test message"
      description={`From ${mailbox.email}`}
      footer={
        <>
          <Button onClick={() => close(false)} disabled={send.isPending}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="mailbox-test" icon={<Send />} loading={send.isPending}>
            Send test
          </Button>
        </>
      }
    >
      <form id="mailbox-test" onSubmit={submit} className="flex flex-col gap-3" noValidate>
        {send.error && !send.error.isPlanLimit && !Object.keys(fields).length && <FormError error={send.error.message} />}
        {declined && (
          <Callout tone="bad" title={`Not sent (${labelOf(declined.status)})`}>
            {declined.reason || "The mailbox did not send the message."}
          </Callout>
        )}
        <Field label="Send to" required error={fields.to}>
          <Input type="email" value={recipient} onChange={(e) => setTo(e.target.value)} autoComplete="email" />
        </Field>
        <Field label="Subject" hint={`Leave empty for “Test from ${mailbox.email}”.`} error={fields.subject}>
          <Input value={subject} onChange={(e) => setSubject(e.target.value)} />
        </Field>
        <Field label="Message" hint="Leave empty for a short standard test message." error={fields.body}>
          <Textarea rows={4} value={body} onChange={(e) => setBody(e.target.value)} />
        </Field>
      </form>
    </Modal>
  );
}
