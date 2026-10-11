"use client";

import { useState, type FormEvent } from "react";
import { Plug } from "lucide-react";
import type { z } from "zod";
import type { SmtpMailboxInput } from "@growthdesk/shared";
import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Checkbox";
import { Modal } from "@/components/ui/Dialog";
import { Field, FormError } from "@/components/ui/Field";
import { Input, NativeSelect, Textarea } from "@/components/ui/Input";
import { useApiMutation } from "@/lib/query";
import { useWorkspace, workspaceDetailKey } from "@/lib/session";
import type { MailSecurity, Mailbox } from "@/lib/types/integrations";

type SmtpMailboxInputT = z.input<typeof SmtpMailboxInput>;

const SECURITY: { value: MailSecurity; label: string }[] = [
  { value: "starttls", label: "STARTTLS" },
  { value: "ssl", label: "SSL / TLS" },
  { value: "none", label: "None (unencrypted)" },
];

/** The usual port for each security mode, so switching the mode does not leave a mismatched port behind. */
const SMTP_PORT: Record<MailSecurity, string> = { ssl: "465", starttls: "587", none: "25" };
const IMAP_PORT: Record<MailSecurity, string> = { ssl: "993", starttls: "143", none: "143" };

const EMPTY = {
  email: "",
  displayName: "",
  smtpHost: "",
  smtpPort: "587",
  smtpSecurity: "starttls" as MailSecurity,
  smtpUser: "",
  password: "",
  imapEnabled: true,
  imapHost: "",
  imapPort: "993",
  imapSecurity: "ssl" as MailSecurity,
  imapUser: "",
  dailyLimit: "50",
  minDelaySeconds: "90",
  signature: "",
};

const num = (s: string) => (s.trim() === "" ? Number.NaN : Number(s));

/**
 * Connect a mailbox by SMTP (+ IMAP for reply tracking). The API signs in to
 * both servers before it stores anything, so a wrong password or host comes
 * back as the server's own answer, shown here inline.
 */
export function SmtpConnectModal({ open, onOpenChange, onConnected }: { open: boolean; onOpenChange: (open: boolean) => void; onConnected?: (box: Mailbox) => void }) {
  const ws = useWorkspace();
  const [v, setV] = useState(EMPTY);
  const [userTouched, setUserTouched] = useState(false);
  const set = <K extends keyof typeof EMPTY>(k: K, value: (typeof EMPTY)[K]) => setV((prev) => ({ ...prev, [k]: value }));

  const connect = useApiMutation<Mailbox, SmtpMailboxInputT>({
    path: ws.path("/mailboxes/smtp"),
    invalidate: [ws.key("mailboxes"), workspaceDetailKey(ws.id)],
    success: (box) => `${box.email} connected`,
    errorToast: false,
    onSuccess: (box) => {
      setV(EMPTY);
      setUserTouched(false);
      onOpenChange(false);
      onConnected?.(box);
    },
  });

  const fields = connect.error?.fields ?? {};
  const close = (next: boolean) => {
    if (!next) connect.reset();
    onOpenChange(next);
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const body: SmtpMailboxInputT = {
      email: v.email.trim(),
      displayName: v.displayName.trim() || undefined,
      smtpHost: v.smtpHost.trim(),
      smtpPort: num(v.smtpPort),
      smtpSecurity: v.smtpSecurity,
      smtpUser: (v.smtpUser.trim() || v.email.trim()),
      password: v.password,
      imapEnabled: v.imapEnabled,
      ...(v.imapEnabled
        ? { imapHost: v.imapHost.trim(), imapPort: num(v.imapPort), imapSecurity: v.imapSecurity, imapUser: v.imapUser.trim() || undefined }
        : {}),
      dailyLimit: num(v.dailyLimit),
      minDelaySeconds: num(v.minDelaySeconds),
      signature: v.signature.trim() || undefined,
    };
    connect.mutate(body);
  };

  // The probe's own error ("The SMTP server did not accept the sign-in: …") is the message; fields cover the inputs.
  const probe = fields.smtp || fields.imap ? connect.error?.message : null;
  const formError = connect.error && !connect.error.isPlanLimit && (probe || !Object.keys(fields).length) ? connect.error.message : null;

  return (
    <Modal
      open={open}
      onOpenChange={close}
      size="lg"
      dismissOnOutside={false}
      title="Connect an SMTP / IMAP mailbox"
      description="We sign in to both servers before saving, so a mailbox shows as connected only when it really is."
      footer={
        <>
          <Button onClick={() => close(false)} disabled={connect.isPending}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="smtp-connect" icon={<Plug />} loading={connect.isPending}>
            {connect.isPending ? "Checking the servers…" : "Connect mailbox"}
          </Button>
        </>
      }
    >
      <form id="smtp-connect" onSubmit={submit} className="flex flex-col gap-5" noValidate>
        <FormError error={formError} />

        <fieldset className="grid gap-3 sm:grid-cols-2">
          <legend className="mb-2 text-xs font-semibold text-text-hi">Address</legend>
          <Field label="Email address" required error={fields.email}>
            <Input
              type="email"
              autoComplete="off"
              value={v.email}
              onChange={(e) => {
                set("email", e.target.value);
                if (!userTouched) set("smtpUser", e.target.value);
              }}
              placeholder="you@yourcompany.com"
            />
          </Field>
          <Field label="Sender name" hint="Shown as the From name." error={fields.displayName}>
            <Input value={v.displayName} onChange={(e) => set("displayName", e.target.value)} placeholder="Jane from Acme" />
          </Field>
        </fieldset>

        <fieldset className="grid gap-3 sm:grid-cols-6">
          <legend className="mb-2 text-xs font-semibold text-text-hi">Sending (SMTP)</legend>
          <Field label="Server" required error={fields.smtpHost} className="sm:col-span-3">
            <Input value={v.smtpHost} onChange={(e) => set("smtpHost", e.target.value)} placeholder="smtp.yourprovider.com" autoComplete="off" className="font-mono" />
          </Field>
          <Field label="Security" error={fields.smtpSecurity} className="sm:col-span-2">
            <NativeSelect
              value={v.smtpSecurity}
              options={SECURITY}
              onChange={(e) => {
                const s = e.target.value as MailSecurity;
                setV((prev) => ({ ...prev, smtpSecurity: s, smtpPort: Object.values(SMTP_PORT).includes(prev.smtpPort) ? SMTP_PORT[s] : prev.smtpPort }));
              }}
            />
          </Field>
          <Field label="Port" required error={fields.smtpPort} className="sm:col-span-1">
            <Input inputMode="numeric" value={v.smtpPort} onChange={(e) => set("smtpPort", e.target.value.replace(/\D/g, ""))} />
          </Field>
          <Field label="Username" required hint="Usually the email address." error={fields.smtpUser} className="sm:col-span-3">
            <Input
              value={v.smtpUser}
              autoComplete="off"
              onChange={(e) => {
                setUserTouched(true);
                set("smtpUser", e.target.value);
              }}
            />
          </Field>
          <Field label="Password" required hint="An app password if the account uses two-step sign-in." error={fields.password} className="sm:col-span-3">
            <Input type="password" autoComplete="new-password" value={v.password} onChange={(e) => set("password", e.target.value)} />
          </Field>
        </fieldset>

        <fieldset className="flex flex-col gap-3">
          <legend className="mb-2 text-xs font-semibold text-text-hi">Replies (IMAP)</legend>
          <Checkbox
            checked={v.imapEnabled}
            onCheckedChange={(c) => set("imapEnabled", c)}
            label="Track replies"
            description="Reads the inbox over IMAP so replies are filed against contacts and stop their sequences. Uses the same password."
          />
          {v.imapEnabled && (
            <div className="grid gap-3 sm:grid-cols-6">
              <Field label="Server" required error={fields.imapHost} className="sm:col-span-3">
                <Input value={v.imapHost} onChange={(e) => set("imapHost", e.target.value)} placeholder="imap.yourprovider.com" autoComplete="off" className="font-mono" />
              </Field>
              <Field label="Security" error={fields.imapSecurity} className="sm:col-span-2">
                <NativeSelect
                  value={v.imapSecurity}
                  options={SECURITY}
                  onChange={(e) => {
                    const s = e.target.value as MailSecurity;
                    setV((prev) => ({ ...prev, imapSecurity: s, imapPort: Object.values(IMAP_PORT).includes(prev.imapPort) ? IMAP_PORT[s] : prev.imapPort }));
                  }}
                />
              </Field>
              <Field label="Port" error={fields.imapPort} className="sm:col-span-1">
                <Input inputMode="numeric" value={v.imapPort} onChange={(e) => set("imapPort", e.target.value.replace(/\D/g, ""))} />
              </Field>
              <Field label="Username" hint="Leave empty to use the SMTP username." error={fields.imapUser} className="sm:col-span-3">
                <Input value={v.imapUser} autoComplete="off" onChange={(e) => set("imapUser", e.target.value)} />
              </Field>
            </div>
          )}
        </fieldset>

        <fieldset className="grid gap-3 sm:grid-cols-2">
          <legend className="mb-2 text-xs font-semibold text-text-hi">Sending limits</legend>
          <Field label="Daily limit" hint="Messages per day, 1–2,000." error={fields.dailyLimit}>
            <Input inputMode="numeric" value={v.dailyLimit} onChange={(e) => set("dailyLimit", e.target.value.replace(/\D/g, ""))} />
          </Field>
          <Field label="Minimum gap (seconds)" hint="Between two sends from this mailbox, 0–3,600." error={fields.minDelaySeconds}>
            <Input inputMode="numeric" value={v.minDelaySeconds} onChange={(e) => set("minDelaySeconds", e.target.value.replace(/\D/g, ""))} />
          </Field>
          <Field label="Signature" hint="Added below every message sent from this mailbox." error={fields.signature} className="sm:col-span-2">
            <Textarea rows={3} value={v.signature} onChange={(e) => set("signature", e.target.value)} />
          </Field>
        </fieldset>
      </form>
    </Modal>
  );
}
