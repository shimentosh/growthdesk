"use client";

import { useState, type FormEvent } from "react";
import { Settings2 } from "lucide-react";
import type { z } from "zod";
import type { UpdateMailboxInput } from "@growthdesk/shared";
import { Button } from "@/components/ui/Button";
import { Card, CardBody, CardFooter, CardHeader } from "@/components/ui/Card";
import { Field, FormError } from "@/components/ui/Field";
import { Input, Textarea } from "@/components/ui/Input";
import { useApiMutation } from "@/lib/query";
import { useWorkspace } from "@/lib/session";
import type { Mailbox } from "@/lib/types/integrations";

type UpdateMailboxInputT = z.input<typeof UpdateMailboxInput>;

const formOf = (b: Mailbox) => ({
  displayName: b.displayName,
  dailyLimit: String(b.dailyLimit),
  minDelaySeconds: String(b.minDelaySeconds),
  signature: b.signature,
  password: "",
});

/**
 * Sender name, limits and signature. SMTP mailboxes can also take a new
 * password, which the API proves against the servers before it replaces the
 * old one; OAuth mailboxes reconnect through their provider instead.
 */
export function MailboxSettingsCard({ mailbox, canManage }: { mailbox: Mailbox; canManage: boolean }) {
  const ws = useWorkspace();
  const [v, setV] = useState(() => formOf(mailbox));
  const [base, setBase] = useState(mailbox);
  // Follow a fresh copy from the server (after verify, another tab's edit) when nothing is being typed.
  if (base !== mailbox) {
    setBase(mailbox);
    const clean = JSON.stringify({ ...formOf(base), password: "" }) === JSON.stringify({ ...v, password: "" });
    if (clean) setV((prev) => ({ ...formOf(mailbox), password: prev.password }));
  }
  const set = <K extends keyof ReturnType<typeof formOf>>(k: K, value: string) => setV((prev) => ({ ...prev, [k]: value }));

  const save = useApiMutation<Mailbox, UpdateMailboxInputT>({
    method: "PATCH",
    path: ws.path(`/mailboxes/${mailbox.id}`),
    invalidate: [ws.key("mailboxes")],
    success: (_, vars) => (vars.password ? "Password checked and saved" : "Mailbox saved"),
    errorToast: false,
    onSuccess: (box) => setV(formOf(box)),
  });
  const fields = save.error?.fields ?? {};

  const initial = formOf(mailbox);
  const dirty = JSON.stringify(initial) !== JSON.stringify(v);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const body: UpdateMailboxInputT = {};
    if (v.displayName !== initial.displayName) body.displayName = v.displayName.trim();
    if (v.dailyLimit !== initial.dailyLimit) body.dailyLimit = v.dailyLimit.trim() === "" ? Number.NaN : Number(v.dailyLimit);
    if (v.minDelaySeconds !== initial.minDelaySeconds) body.minDelaySeconds = v.minDelaySeconds.trim() === "" ? Number.NaN : Number(v.minDelaySeconds);
    if (v.signature !== initial.signature) body.signature = v.signature.trim();
    if (v.password) body.password = v.password;
    save.mutate(body);
  };

  return (
    <Card>
      <CardHeader icon={<Settings2 />} title="Sending settings" description="How messages from this mailbox look and how fast they go out." />
      <form onSubmit={submit} noValidate>
        <CardBody className="flex flex-col gap-4">
          {save.error && !save.error.isPlanLimit && (fields.smtp || fields.imap || !Object.keys(fields).length) && <FormError error={save.error.message} />}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Sender name" hint="Shown as the From name." error={fields.displayName} className="sm:col-span-2">
              <Input value={v.displayName} onChange={(e) => set("displayName", e.target.value)} disabled={!canManage} />
            </Field>
            <Field label="Daily limit" hint="Messages per day, 1–2,000." error={fields.dailyLimit}>
              <Input inputMode="numeric" value={v.dailyLimit} onChange={(e) => set("dailyLimit", e.target.value.replace(/\D/g, ""))} disabled={!canManage} />
            </Field>
            <Field label="Minimum gap (seconds)" hint="Between two sends from this mailbox, 0–3,600." error={fields.minDelaySeconds}>
              <Input inputMode="numeric" value={v.minDelaySeconds} onChange={(e) => set("minDelaySeconds", e.target.value.replace(/\D/g, ""))} disabled={!canManage} />
            </Field>
            <Field label="Signature" hint="Added below every message sent from this mailbox." error={fields.signature} className="sm:col-span-2">
              <Textarea rows={4} value={v.signature} onChange={(e) => set("signature", e.target.value)} disabled={!canManage} />
            </Field>
            {mailbox.provider === "smtp" && canManage && (
              <Field
                label="New password"
                hint="Only to replace the stored one. We sign in with it before saving."
                error={fields.password}
                className="sm:col-span-2"
              >
                <Input type="password" autoComplete="new-password" value={v.password} onChange={(e) => set("password", e.target.value)} />
              </Field>
            )}
          </div>
        </CardBody>
        {canManage && (
          <CardFooter>
            {dirty && (
              <Button onClick={() => { setV(initial); save.reset(); }} disabled={save.isPending}>
                Discard
              </Button>
            )}
            <Button variant="primary" type="submit" loading={save.isPending} disabled={!dirty}>
              Save changes
            </Button>
          </CardFooter>
        )}
      </form>
    </Card>
  );
}
