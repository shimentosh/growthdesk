"use client";

import { useState, type FormEvent, type ReactNode } from "react";
import { CircleAlert, ExternalLink, Pencil, Plug, Send, Unplug, Webhook } from "lucide-react";
import type { z } from "zod";
import { RESEND_REGIONS, SES_REGIONS, type EspConnectionInput, type EspProvider } from "@growthdesk/shared";
import { Badge, type Tone } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, CardBody, CardFooter, CardHeader } from "@/components/ui/Card";
import { ConfirmDialog } from "@/components/ui/Dialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { Field, FormError } from "@/components/ui/Field";
import { Input, NativeSelect } from "@/components/ui/Input";
import { KeyValueList } from "@/components/ui/KeyValue";
import { CopyValue } from "@/components/integrations/Copy";
import { useMarketing } from "@/components/marketing/common";
import { cn } from "@/lib/cn";
import { useApiMutation } from "@/lib/query";
import { useFormat } from "@/lib/session";
import type { EspConnection } from "@/lib/types/marketing";
import { formErrorOf } from "./errors";

type EspInputT = z.input<typeof EspConnectionInput>;
type Security = EspConnection["security"];

const PROVIDER_LABEL: Record<EspProvider, string> = { ses: "Amazon SES", smtp_relay: "SMTP relay", resend: "Resend" };

const SECURITY: { value: Security; label: string }[] = [
  { value: "starttls", label: "STARTTLS" },
  { value: "ssl", label: "SSL / TLS" },
  { value: "none", label: "None (unencrypted)" },
];
const SECURITY_LABEL = Object.fromEntries(SECURITY.map((s) => [s.value, s.label])) as Record<Security, string>;
/** The usual port for each mode, so switching the mode does not leave a mismatched port behind. */
const PORT: Record<Security, string> = { ssl: "465", starttls: "587", none: "25" };

const STATUS: Record<EspConnection["status"], { tone: Tone; label: string }> = {
  connected: { tone: "ok", label: "Connected" },
  error: { tone: "bad", label: "Error" },
  disconnected: { tone: "mute", label: "Disconnected" },
};

const formOf = (esp: EspConnection | null) => ({
  provider: (esp?.provider ?? "resend") as EspProvider,
  region: esp?.provider === "ses" ? (esp.region ?? "us-east-1") : "us-east-1",
  resendRegion: esp?.provider === "resend" ? (esp.region ?? "us-east-1") : "us-east-1",
  apiKey: "",
  host: esp?.provider === "smtp_relay" ? esp.host : "",
  port: esp?.provider === "smtp_relay" ? String(esp.port) : "587",
  security: (esp?.provider === "smtp_relay" ? esp.security : "starttls") as Security,
  username: esp?.username ?? "",
  password: "",
});
type Form = ReturnType<typeof formOf>;

/** Resend, Amazon SES or a plain SMTP relay. */
function ProviderSwitch({ value, onChange }: { value: EspProvider; onChange: (v: EspProvider) => void }) {
  return (
    <div role="radiogroup" aria-label="Email service" className="inline-flex self-start rounded-sm border border-line-strong bg-well p-0.5">
      {(["resend", "ses", "smtp_relay"] as const).map((p) => (
        <button
          key={p}
          type="button"
          role="radio"
          aria-checked={value === p}
          onClick={() => onChange(p)}
          className={cn(
            "inline-flex h-7 items-center rounded-xs px-3 text-sm transition-colors",
            value === p ? "bg-ctl-face font-medium text-text-hi shadow-sm" : "text-text-3 hover:text-text",
          )}
        >
          {PROVIDER_LABEL[p]}
        </button>
      ))}
    </div>
  );
}

/**
 * The connect form. The API signs in to the SMTP endpoint before it stores
 * anything, so a wrong password comes back as the server's own answer (a
 * 400), shown inline. With a stored password, leaving the field empty keeps it.
 */
function EspForm({ esp, onDone, onCancel }: { esp: EspConnection | null; onDone: () => void; onCancel?: () => void }) {
  const mk = useMarketing();
  const [v, setV] = useState<Form>(() => formOf(esp));
  const set = <K extends keyof Form>(k: K, value: Form[K]) => setV((prev) => ({ ...prev, [k]: value }));

  const connect = useApiMutation<EspConnection, EspInputT>({
    method: "PUT",
    path: mk.path("/esp"),
    invalidate: [mk.key("setup")],
    success: (r) => `${PROVIDER_LABEL[r.provider]} connected`,
    errorToast: false,
    onSuccess: onDone,
  });
  const fields = connect.error?.fields ?? {};
  const formError = formErrorOf(connect.error);
  // Keeping the saved password only works against the same service, host and username (the API checks).
  const keepsPassword = Boolean(esp?.hasPassword) && esp?.provider === v.provider;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const password = v.password || undefined;
    if (v.provider === "resend") {
      connect.mutate({ provider: "resend", region: v.resendRegion as (typeof RESEND_REGIONS)[number], apiKey: v.apiKey.trim() || undefined });
      return;
    }
    connect.mutate(
      v.provider === "ses"
        ? { provider: "ses", region: v.region as (typeof SES_REGIONS)[number], username: v.username.trim(), password }
        : {
            provider: "smtp_relay",
            host: v.host.trim(),
            port: v.port.trim() === "" ? Number.NaN : Number(v.port),
            security: v.security,
            username: v.username.trim(),
            password,
          },
    );
  };

  const passwordHint = keepsPassword ? "Password saved. Leave empty to keep it." : v.provider === "ses" ? "The SMTP password generated with the credentials." : "Leave empty if the relay takes no sign-in.";

  return (
    <form onSubmit={submit} noValidate>
      <CardBody className="flex flex-col gap-4">
        <ProviderSwitch
          value={v.provider}
          onChange={(p) => {
            setV((prev) => ({ ...prev, provider: p }));
            connect.reset();
          }}
        />
        <FormError error={formError} />
        {v.provider === "resend" ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="API key"
              required={!keepsPassword}
              error={fields.apiKey}
              hint={keepsPassword ? "Key saved. Leave empty to keep it." : "A Full access key — domains are created in your Resend account with it."}
              labelAction={
                <a href="https://resend.com/api-keys" target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 text-xs text-accent-hi hover:underline">
                  Create a key
                  <ExternalLink aria-hidden className="size-3" />
                </a>
              }
            >
              <Input type="password" autoComplete="new-password" value={v.apiKey} onChange={(e) => set("apiKey", e.target.value)} placeholder="re_…" className="font-mono" />
            </Field>
            <Field label="Region" error={fields.region} hint="Where domains added from here send from.">
              <NativeSelect value={v.resendRegion} options={RESEND_REGIONS.map((r) => ({ value: r, label: r }))} onChange={(e) => set("resendRegion", e.target.value)} />
            </Field>
            <p className="text-xs text-text-3 sm:col-span-2">
              Resend is for marketing to people who opted in; its terms forbid cold outreach, which goes through your mailboxes instead.
            </p>
          </div>
        ) : v.provider === "ses" ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Region" required error={fields.region} hint="Where your SES account sends from." className="sm:col-span-2">
              <NativeSelect value={v.region} options={SES_REGIONS.map((r) => ({ value: r, label: r }))} onChange={(e) => set("region", e.target.value)} className="sm:w-60" />
            </Field>
            <Field label="SMTP username" required error={fields.username} hint="From SES → SMTP settings → Create SMTP credentials.">
              <Input value={v.username} autoComplete="off" onChange={(e) => set("username", e.target.value)} className="font-mono" />
            </Field>
            <Field label="SMTP password" required={!keepsPassword} error={fields.password} hint={passwordHint}>
              <Input type="password" autoComplete="new-password" value={v.password} onChange={(e) => set("password", e.target.value)} />
            </Field>
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-6">
            <Field label="Server" required error={fields.host} className="sm:col-span-3">
              <Input value={v.host} onChange={(e) => set("host", e.target.value)} placeholder="smtp.yourservice.com" autoComplete="off" className="font-mono" />
            </Field>
            <Field label="Security" error={fields.security} className="sm:col-span-2">
              <NativeSelect
                value={v.security}
                options={SECURITY}
                onChange={(e) => {
                  const s = e.target.value as Security;
                  setV((prev) => ({ ...prev, security: s, port: Object.values(PORT).includes(prev.port) ? PORT[s] : prev.port }));
                }}
              />
            </Field>
            <Field label="Port" required error={fields.port} className="sm:col-span-1">
              <Input inputMode="numeric" value={v.port} onChange={(e) => set("port", e.target.value.replace(/\D/g, ""))} />
            </Field>
            <Field label="Username" error={fields.username} hint="Leave empty if the relay takes no sign-in." className="sm:col-span-3">
              <Input value={v.username} autoComplete="off" onChange={(e) => set("username", e.target.value)} />
            </Field>
            <Field label="Password" error={fields.password} hint={keepsPassword ? "Password saved. Leave empty to keep it." : undefined} className="sm:col-span-3">
              <Input type="password" autoComplete="new-password" value={v.password} onChange={(e) => set("password", e.target.value)} />
            </Field>
          </div>
        )}
      </CardBody>
      <CardFooter>
        {onCancel && (
          <Button onClick={onCancel} disabled={connect.isPending}>
            Cancel
          </Button>
        )}
        <Button variant="primary" type="submit" icon={<Plug />} loading={connect.isPending}>
          {connect.isPending ? "Checking the sign-in…" : esp ? "Save and reconnect" : "Connect"}
        </Button>
      </CardFooter>
    </form>
  );
}

/** Where bounces and complaints go, with what to set up on the service's side. */
function WebhookBlock({ esp }: { esp: EspConnection }) {
  let how: ReactNode;
  if (esp.provider === "resend")
    how = (
      <>
        In Resend → <span className="font-medium text-text">Webhooks</span>, add an endpoint with this URL and the <span className="font-mono text-2xs">email.bounced</span> and{" "}
        <span className="font-mono text-2xs">email.complained</span> events.
      </>
    );
  else if (esp.provider === "ses")
    how = (
      <>
        In Amazon SNS, create a topic with an <span className="font-medium text-text">HTTPS</span> subscription to this URL (we confirm it automatically). Then, in SES, send the
        sending identity&apos;s <span className="font-medium text-text">Bounce</span> and <span className="font-medium text-text">Complaint</span> notifications to that topic.
      </>
    );
  else
    how = (
      <>
        Add this URL as a webhook on your relay. <span className="font-medium text-text">Postmark</span> (Bounce, Spam complaint and Subscription change),{" "}
        <span className="font-medium text-text">SendGrid</span> (Event Webhook: Bounced, Spam reports, Unsubscribes) and <span className="font-medium text-text">Mailgun</span>{" "}
        (Permanent failure, Spam complaints, Unsubscribes) are read as they are, unsubscribes included. Any other relay can POST JSON:{" "}
        <code className="font-mono text-2xs">{`{ "type": "bounce" | "complaint", "email": "…" }`}</code>.
      </>
    );
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-1.5 text-xs font-medium text-text-2">
        <Webhook aria-hidden className="size-3.5 text-text-3" />
        Bounce and complaint notifications
      </div>
      <CopyValue value={esp.webhookUrl} label="Copy webhook URL" copied="Webhook URL copied" />
      <p className="text-xs text-text-3">{how} Addresses that bounce or complain are suppressed from marketing automatically.</p>
    </div>
  );
}

/** The workspace's email service for marketing: status, the connect form, the bounce webhook. */
export function EspCard({ esp, canManage }: { esp: EspConnection | null; canManage: boolean }) {
  const mk = useMarketing();
  const f = useFormat();
  const [editing, setEditing] = useState(false);
  const [confirm, setConfirm] = useState(false);

  const disconnect = useApiMutation<{ disconnected: boolean }, void>({
    method: "DELETE",
    path: mk.path("/esp"),
    invalidate: [mk.key("setup")],
    success: "Email service disconnected",
    errorToast: false,
  });

  const status = esp ? STATUS[esp.status] : null;
  const showForm = canManage && (!esp || editing);

  return (
    <Card>
      <CardHeader
        icon={<Send />}
        title="Email service"
        description="The service that delivers marketing email. It is kept apart from the mailboxes outreach sends from."
        actions={
          status ? (
            <Badge tone={status.tone} dot>
              {status.label}
            </Badge>
          ) : (
            <Badge tone="mute">Not connected</Badge>
          )
        }
      />
      {showForm ? (
        <EspForm esp={esp} onDone={() => setEditing(false)} onCancel={esp ? () => setEditing(false) : undefined} />
      ) : !esp ? (
        <EmptyState
          compact
          icon={<Send />}
          title="No email service connected"
          description="Marketing campaigns can't send until a workspace admin connects Resend, Amazon SES or an SMTP relay."
        />
      ) : (
        <>
          <CardBody className="flex flex-col gap-4">
            {esp.lastError && (
              <p className="flex items-start gap-1.5 text-xs text-bad-ink">
                <CircleAlert aria-hidden className="mt-px size-3.5 shrink-0" />
                <span className="min-w-0 break-words">{esp.lastError}</span>
              </p>
            )}
            <KeyValueList
              columns={2}
              items={[
                { label: "Service", value: PROVIDER_LABEL[esp.provider] },
                ...(esp.provider === "resend"
                  ? [
                      { label: "Region", value: esp.region },
                      { label: "API key", value: esp.hasPassword ? "Key saved" : <span className="text-text-3">None</span> },
                    ]
                  : [
                      esp.provider === "ses" ? { label: "Region", value: esp.region } : { label: "Security", value: SECURITY_LABEL[esp.security] },
                      { label: "Server", value: <span className="font-mono text-xs">{`${esp.host}:${esp.port}`}</span> },
                      { label: "Username", value: esp.username ? <span className="font-mono text-xs">{esp.username}</span> : <span className="text-text-3">None</span> },
                      { label: "Password", value: esp.hasPassword ? "Password saved" : <span className="text-text-3">None</span> },
                    ]),
                { label: "Last checked", value: esp.lastCheckedAt ? f.relative(esp.lastCheckedAt) : "Never" },
              ]}
            />
            <WebhookBlock esp={esp} />
          </CardBody>
          {canManage && (
            <CardFooter className="justify-between">
              <Button variant="ghost" icon={<Unplug />} onClick={() => setConfirm(true)}>
                Disconnect
              </Button>
              <Button icon={<Pencil />} onClick={() => setEditing(true)}>
                Change settings
              </Button>
            </CardFooter>
          )}
        </>
      )}
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title="Disconnect the email service?"
        description="Marketing campaigns can't send until a service is connected again. The webhook URL changes when you reconnect, so update it on the service's side too."
        confirmLabel="Disconnect"
        onConfirm={() => disconnect.mutateAsync()}
      />
    </Card>
  );
}
