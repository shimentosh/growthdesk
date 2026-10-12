"use client";

import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { AtSign, Gauge, Globe, KeyRound, MailCheck, RefreshCw, Send, Server, ShieldCheck, Webhook } from "lucide-react";
import { Badge, type Tone } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Card, CardBody, CardFooter, CardHeader } from "@/components/ui/Card";
import { ConfirmDialog, Modal } from "@/components/ui/Dialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { QueryState } from "@/components/ui/ErrorState";
import { Field, FormError } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { Switch } from "@/components/ui/Switch";
import { KeyValueList } from "@/components/ui/KeyValue";
import { Page, PageHeader } from "@/components/ui/PageHeader";
import { SkeletonText } from "@/components/ui/Skeleton";
import { cn } from "@/lib/cn";
import { useApiMutation, useApiQuery } from "@/lib/query";
import { PlatformTile, platformKey, table, usePlatform } from "@/features/common/platform";
import { CopyButton, CopyValue } from "./common";
import type { EmailSettings as Settings, EmailSettingsPatch, MailProviderId, ResendDomain, SendResult } from "./types";

/*
 * /email/settings — how platform mail leaves: provider (Resend with SMTP as the
 * fallback), keys (write-only), senders, the Resend webhook and sending domains,
 * and a test send to yourself. The "effective" block is what the API would do
 * right now, so it never claims more than the running system does.
 */

const SETTINGS_KEY = platformKey("email-settings");
const RESEND_EVENTS = [
  "email.sent",
  "email.delivered",
  "email.delivery_delayed",
  "email.bounced",
  "email.complained",
  "email.opened",
  "email.clicked",
  "email.failed",
  "email.suppressed",
];

function useSave(success = "Email settings saved") {
  return useApiMutation<Settings, EmailSettingsPatch>({
    method: "PATCH",
    path: "/admin/email/settings",
    invalidate: [SETTINGS_KEY, platformKey("email-domains")],
    success,
    errorToast: false,
  });
}

// ─── Delivery (provider) ─────────────────────────────────────────────────────

function ProviderOption({ id, title, description, selected, disabled, onSelect }: { id: MailProviderId; title: string; description: string; selected: boolean; disabled: boolean; onSelect: (id: MailProviderId) => void }) {
  return (
    <label
      className={cn(
        "flex cursor-pointer items-start gap-3 rounded-lg border px-3.5 py-3 transition-colors",
        selected ? "border-accent bg-accent/5 ring-1 ring-accent/40" : "border-line hover:bg-hover",
        disabled && "cursor-not-allowed opacity-70",
      )}
    >
      <input type="radio" name="mail-provider" value={id} checked={selected} disabled={disabled} onChange={() => onSelect(id)} className="mt-1 accent-[var(--color-accent)]" />
      <span className="min-w-0">
        <span className="block text-sm font-semibold text-text-hi">{title}</span>
        <span className="block text-xs text-text-3">{description}</span>
      </span>
    </label>
  );
}

function Delivery({ s }: { s: Settings }) {
  const { canChange } = usePlatform();
  const save = useSave();
  // Optimistic: the choice shows at once and reverts if the save fails.
  const [choice, setChoice] = useState<MailProviderId | null>(null);
  const selected = choice ?? s.mailProvider;
  const choose = (v: MailProviderId) => {
    if (v === selected) return;
    setChoice(v);
    save.mutate({ mailProvider: v }, { onSettled: () => setChoice(null) });
  };
  const resend = s.effective.provider === "resend";
  return (
    <Card>
      <CardHeader icon={<MailCheck />} title="Delivery" description="Which service sends system email: verification, password resets, invitations, billing notices and notifications." />
      <CardBody className="flex flex-col gap-4">
        <div className={cn("flex flex-wrap items-center gap-3 rounded-lg border px-4 py-3", resend ? "border-ok-edge bg-ok-wash" : "border-info-edge bg-info-wash")}>
          <span className={cn("flex size-9 items-center justify-center rounded-full [&_svg]:size-4.5", resend ? "bg-ok/15 text-ok-ink" : "bg-accent/15 text-accent-ink")}>
            {resend ? <Send /> : <Server />}
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold text-text-hi">Sending through {resend ? "Resend" : "SMTP"} right now</div>
            <div className="text-xs text-text-2">{s.effective.reason}.</div>
          </div>
          <div className="min-w-0 text-xs text-text-2">
            <div className="truncate">
              <span className="text-text-3">From </span>
              {s.effective.transactionalFrom}
            </div>
            {s.effective.replyTo && (
              <div className="truncate">
                <span className="text-text-3">Reply-To </span>
                {s.effective.replyTo}
              </div>
            )}
          </div>
        </div>
        <FormError error={save.error?.message} />
        <div role="radiogroup" aria-label="Provider" className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <ProviderOption
            id="resend"
            title="Resend"
            description="HTTP API with delivery, open, click, bounce and complaint events. Recommended."
            selected={selected === "resend"}
            disabled={!canChange}
            onSelect={choose}
          />
          <ProviderOption
            id="smtp"
            title="SMTP"
            description={`The server set below (${s.smtp.host}:${s.smtp.port}). No delivery events.`}
            selected={selected === "smtp"}
            disabled={!canChange}
            onSelect={choose}
          />
        </div>
        <Callout tone="info" title="When SMTP takes over">
          With Resend selected, SMTP sends only when Resend has no API key or refuses it (401/403) — nothing went out, so nothing is sent twice. After a timeout or a Resend server error the message may already have gone, so it is retried through Resend with the same idempotency key, never through SMTP.
        </Callout>
      </CardBody>
    </Card>
  );
}

// ─── Resend keys ─────────────────────────────────────────────────────────────

function SecretField({
  label,
  help,
  set,
  fromEnv,
  envName,
  placeholder,
  field,
}: {
  label: string;
  help: ReactNode;
  set: boolean;
  fromEnv: boolean;
  envName: string;
  placeholder: string;
  field: "resendApiKey" | "resendWebhookSecret";
}) {
  const { canChange } = usePlatform();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [clearing, setClearing] = useState(false);
  const save = useSave(`${label} saved`);
  const clear = useSave(`${label} cleared`);
  const state: { tone: Tone; text: string } = !set
    ? { tone: "warn", text: "Not set" }
    : fromEnv
      ? { tone: "info", text: `From ${envName}` }
      : { tone: "ok", text: "Saved" };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!value.trim()) return;
    save.mutate(
      { [field]: value.trim() },
      {
        onSuccess: () => {
          setValue("");
          setEditing(false);
        },
      },
    );
  };
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-line p-3.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-text-hi">{label}</span>
          <Badge tone={state.tone} dot>
            {state.text}
          </Badge>
        </div>
        {canChange && !editing && (
          <div className="flex gap-1.5">
            <Button size="sm" onClick={() => setEditing(true)}>
              {set ? "Replace" : "Add"}
            </Button>
            {set && !fromEnv && (
              <Button size="sm" variant="ghost" onClick={() => setClearing(true)}>
                Clear
              </Button>
            )}
          </div>
        )}
      </div>
      <p className="text-xs text-text-3">{help}</p>
      {editing && (
        <form onSubmit={submit} className="flex flex-col gap-2">
          <Field error={save.error?.fields[field] ?? save.error?.message}>
            <Input type="password" autoComplete="off" spellCheck={false} value={value} onChange={(e) => setValue(e.target.value)} placeholder={placeholder} autoFocus className="font-mono" />
          </Field>
          <div className="flex justify-end gap-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setEditing(false);
                setValue("");
                save.reset();
              }}
            >
              Cancel
            </Button>
            <Button size="sm" variant="primary" type="submit" loading={save.isPending} disabled={!value.trim()}>
              Save
            </Button>
          </div>
        </form>
      )}
      <ConfirmDialog
        open={clearing}
        onOpenChange={setClearing}
        title={`Clear the ${label.toLowerCase()}?`}
        description={field === "resendApiKey" ? `Without a key, mail goes through SMTP${fromEnv ? "" : " (or RESEND_API_KEY, if the server has one)"}.` : "Resend webhooks will be refused until a secret is saved again."}
        confirmLabel="Clear"
        onConfirm={() => clear.mutateAsync({ [field]: "" })}
      />
    </div>
  );
}

function ResendKeys({ s }: { s: Settings }) {
  const { canChange } = usePlatform();
  const [rate, setRate] = useState(String(s.resendRateLimitPerSec));
  useEffect(() => setRate(String(s.resendRateLimitPerSec)), [s.resendRateLimitPerSec]);
  const save = useSave("Rate limit saved");
  return (
    <Card>
      <CardHeader icon={<KeyRound />} title="Resend" description="Keys are write-only: they are stored encrypted and never shown again. A key saved here overrides the server's environment." />
      <CardBody className="flex flex-col gap-3">
        <SecretField
          label="API key"
          field="resendApiKey"
          set={s.resendApiKeySet}
          fromEnv={s.resendApiKeyFromEnv}
          envName="RESEND_API_KEY"
          placeholder="re_…"
          help={
            <>
              Create one in Resend → API Keys with <b>Full access</b> (sending access alone cannot list or verify domains).
            </>
          }
        />
        <SecretField
          label="Webhook signing secret"
          field="resendWebhookSecret"
          set={s.resendWebhookSecretSet}
          fromEnv={s.resendWebhookSecretFromEnv}
          envName="RESEND_WEBHOOK_SECRET"
          placeholder="whsec_…"
          help="Shown on the webhook's page in Resend after you add the endpoint below. Every event is checked against it."
        />
        <form
          className="flex flex-col gap-2 rounded-lg border border-line p-3.5"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate({ resendRateLimitPerSec: Number(rate) });
          }}
        >
          <div className="flex items-center gap-2 text-sm font-medium text-text-hi">
            <Gauge aria-hidden className="size-4 text-text-3" /> Send rate
          </div>
          <Field
            error={save.error?.fields.resendRateLimitPerSec ?? save.error?.message}
            hint="Requests per second, shared by every worker. Resend's default team limit is 10 per second; stay at or below your plan's."
          >
            <div className="flex items-center gap-2">
              <Input type="number" min={1} max={100} value={rate} onChange={(e) => setRate(e.target.value)} disabled={!canChange} className="w-24" />
              <span className="text-sm text-text-3">per second</span>
              {canChange && (
                <Button size="sm" type="submit" loading={save.isPending} disabled={rate === String(s.resendRateLimitPerSec) || !rate}>
                  Save
                </Button>
              )}
            </div>
          </Field>
        </form>
      </CardBody>
    </Card>
  );
}

// ─── Senders ─────────────────────────────────────────────────────────────────

function Senders({ s }: { s: Settings }) {
  const { canChange } = usePlatform();
  const [form, setForm] = useState({ transactionalFrom: s.transactionalFrom, marketingFrom: s.marketingFrom, replyTo: s.replyTo });
  useEffect(() => setForm({ transactionalFrom: s.transactionalFrom, marketingFrom: s.marketingFrom, replyTo: s.replyTo }), [s.transactionalFrom, s.marketingFrom, s.replyTo]);
  const save = useSave("Senders saved");
  const fields = save.error?.fields ?? {};
  const dirty = form.transactionalFrom !== s.transactionalFrom || form.marketingFrom !== s.marketingFrom || form.replyTo !== s.replyTo;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate({ transactionalFrom: form.transactionalFrom.trim(), marketingFrom: form.marketingFrom.trim(), replyTo: form.replyTo.trim() });
  };
  return (
    <form onSubmit={submit}>
      <Card>
        <CardHeader icon={<AtSign />} title="Senders" description='An address, or "Name <address>". Without a name, the product name from Branding is used. The domain must be verified in Resend.' />
        <CardBody className="flex flex-col gap-4">
          <FormError error={save.error && !Object.keys(fields).length ? save.error.message : null} />
          <Field label="System email from" error={fields.transactionalFrom} hint={<>Now: {s.effective.transactionalFrom}{!s.transactionalFrom && " (MAIL_FROM)"}</>}>
            <Input value={form.transactionalFrom} onChange={(e) => setForm({ ...form, transactionalFrom: e.target.value })} placeholder={s.defaults.mailFrom} disabled={!canChange} />
          </Field>
          <Field
            label="Product updates from"
            error={fields.marketingFrom}
            hint={<>For broadcasts and onboarding emails. Now: {s.effective.marketingFrom}. A separate subdomain (e.g. updates.example.com) protects system mail&apos;s reputation.</>}
          >
            <Input value={form.marketingFrom} onChange={(e) => setForm({ ...form, marketingFrom: e.target.value })} placeholder="Same as system email" disabled={!canChange} />
          </Field>
          <Field label="Reply-To" error={fields.replyTo} hint={s.defaults.replyTo ? `Empty: ${s.defaults.replyTo} (MAIL_REPLY_TO).` : "Empty: replies go to the From address."}>
            <Input value={form.replyTo} onChange={(e) => setForm({ ...form, replyTo: e.target.value })} placeholder={s.defaults.replyTo ?? "support@example.com"} disabled={!canChange} />
          </Field>
        </CardBody>
        {canChange && (
          <CardFooter>
            <Button type="submit" variant="primary" loading={save.isPending} disabled={!dirty}>
              Save senders
            </Button>
          </CardFooter>
        )}
      </Card>
    </form>
  );
}

// ─── Webhook ─────────────────────────────────────────────────────────────────

function WebhookSetup({ s }: { s: Settings }) {
  return (
    <Card>
      <CardHeader
        icon={<Webhook />}
        title="Delivery events webhook"
        description="Resend reports delivered, opened, clicked, bounced and spam-complaint events here. A hard bounce or complaint stops product updates to that person."
        actions={
          <Badge tone={s.resendWebhookSecretSet ? "ok" : "warn"} dot>
            {s.resendWebhookSecretSet ? "Secret saved" : "Secret missing"}
          </Badge>
        }
      />
      <CardBody className="flex flex-col gap-4">
        <Field label="Endpoint URL" hint="Built from PUBLIC_APP_URL.">
          <CopyValue value={s.webhookUrl} />
        </Field>
        {/^https?:\/\/(localhost|127\.|\[::1\])/i.test(s.webhookUrl) && (
          <Callout tone="warn">This address is local, so Resend cannot reach it. Use the public URL of a deployed installation (or a tunnel) when you add the endpoint.</Callout>
        )}
        <ol className="flex list-decimal flex-col gap-1.5 pl-5 text-sm text-text-2 marker:text-text-3">
          <li>
            In Resend, open <b>Webhooks</b> and choose <b>Add endpoint</b>.
          </li>
          <li>Paste the URL above. It must be reachable from the internet (not localhost).</li>
          <li>
            Select these events:
            <div className="mt-1.5 flex flex-wrap gap-1">
              {RESEND_EVENTS.map((e) => (
                <code key={e} className="rounded border border-line bg-well px-1.5 py-0.5 font-mono text-2xs text-text">
                  {e}
                </code>
              ))}
            </div>
          </li>
          <li>
            Save, then copy the endpoint&apos;s <b>Signing secret</b> (whsec_…) into “Webhook signing secret” above.
          </li>
          <li>Send a test email below: its delivery log row should move from “Sent” to “Delivered” within a minute.</li>
        </ol>
      </CardBody>
    </Card>
  );
}

// ─── Domains ─────────────────────────────────────────────────────────────────

const domainTone = (status: string): Tone =>
  status === "verified" ? "ok" : status === "failed" || status === "temporary_failure" ? "bad" : status === "pending" ? "warn" : "mute";

function Domains({ s }: { s: Settings }) {
  const { canChange } = usePlatform();
  const domains = useApiQuery<{ items: ResendDomain[] }>(platformKey("email-domains"), s.resendApiKeySet ? "/admin/email/domains" : null, { staleTime: 15_000 });
  const verify = useApiMutation<{ ok: boolean; id: string }, string>({
    path: (id) => `/admin/email/domains/${encodeURIComponent(id)}/verify`,
    body: () => ({}),
    invalidate: [platformKey("email-domains")],
    success: "Verification started — Resend re-checks the DNS records now",
  });
  return (
    <Card>
      <CardHeader
        icon={<Globe />}
        title="Sending domains"
        description="Domains in your Resend account and the DNS records each needs. Add new domains in Resend; verify them here once the records are published."
        actions={
          s.resendApiKeySet && (
            <Button size="sm" variant="ghost" icon={<RefreshCw />} loading={domains.isFetching && !domains.isPending} onClick={() => void domains.refetch()}>
              Refresh
            </Button>
          )
        }
      />
      {!s.resendApiKeySet ? (
        <CardBody>
          <EmptyState compact icon={<Globe />} title="Add a Resend API key first" description="The domains and their DNS records are read from your Resend account." />
        </CardBody>
      ) : (
        <QueryState query={domains} loading={<CardBody><SkeletonText lines={4} /></CardBody>} isEmpty={(d) => d.items.length === 0} empty={<CardBody><EmptyState compact icon={<Globe />} title="No domains in Resend yet" description="Add your sending domain in Resend → Domains, then refresh." /></CardBody>}>
          {(d) => (
            <div className="flex flex-col divide-y divide-line">
              {d.items.map((dom) => (
                <div key={dom.id} className="flex flex-col gap-3 px-4 py-3.5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-sm font-semibold text-text-hi">{dom.name}</span>
                      <Badge tone={domainTone(dom.status)} dot>
                        {dom.status.replace(/_/g, " ") || "unknown"}
                      </Badge>
                      {dom.region && <span className="text-xs text-text-3">{dom.region}</span>}
                    </div>
                    {canChange && dom.status !== "verified" && (
                      <Button size="sm" icon={<ShieldCheck />} loading={verify.isPending && verify.variables === dom.id} onClick={() => verify.mutate(dom.id)}>
                        Verify
                      </Button>
                    )}
                  </div>
                  {dom.records.length > 0 && (
                    <div className={cn(table.wrap, "rounded-lg border border-line")}>
                      <table className={table.table}>
                        <thead>
                          <tr>
                            <th className={table.th}>Record</th>
                            <th className={table.th}>Type</th>
                            <th className={table.th}>Name</th>
                            <th className={table.th}>Value</th>
                            <th className={table.th}>Status</th>
                          </tr>
                        </thead>
                        <tbody>
                          {dom.records.map((r, i) => (
                            <tr key={`${r.record}-${r.name}-${i}`}>
                              <td className={cn(table.td, "whitespace-nowrap")}>{r.record}</td>
                              <td className={cn(table.td, "font-mono text-xs whitespace-nowrap")}>
                                {r.type}
                                {r.priority !== null && <span className="text-text-3"> {r.priority}</span>}
                              </td>
                              <td className={cn(table.td, "max-w-44")}>
                                <span className="flex items-center gap-0.5">
                                  <code className="truncate font-mono text-xs" title={r.name}>
                                    {r.name}
                                  </code>
                                  <CopyButton value={r.name} label="Copy name" />
                                </span>
                              </td>
                              <td className={cn(table.td, "max-w-72")}>
                                <span className="flex items-center gap-0.5">
                                  <code className="truncate font-mono text-xs" title={r.value}>
                                    {r.value}
                                  </code>
                                  <CopyButton value={r.value} label="Copy value" />
                                </span>
                              </td>
                              <td className={table.td}>
                                <Badge tone={domainTone(r.status)} dot quiet>
                                  {r.status.replace(/_/g, " ") || "—"}
                                </Badge>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </QueryState>
      )}
    </Card>
  );
}

// ─── SMTP ────────────────────────────────────────────────────────────────────

function Smtp({ s }: { s: Settings }) {
  const { canChange } = usePlatform();
  const saved = s.smtp.fromEnv ? null : s.smtp;
  const initial = { host: saved?.host ?? "", port: String(saved?.port ?? 587), secure: saved?.secure ?? false, user: saved?.user ?? "" };
  const [form, setForm] = useState(initial);
  const [password, setPassword] = useState("");
  const [clearing, setClearing] = useState(false);
  useEffect(() => setForm({ host: saved?.host ?? "", port: String(saved?.port ?? 587), secure: saved?.secure ?? false, user: saved?.user ?? "" }), [saved?.host, saved?.port, saved?.secure, saved?.user]);
  const save = useSave("SMTP server saved");
  const clear = useSave("SMTP server removed");
  const fields = save.error?.fields ?? {};
  const dirty = form.host !== initial.host || form.port !== initial.port || form.secure !== initial.secure || form.user !== initial.user || password !== "";
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate(
      { smtpHost: form.host.trim(), smtpPort: Number(form.port || "587"), smtpSecure: form.secure, smtpUser: form.user.trim(), ...(password ? { smtpPassword: password } : {}) },
      { onSuccess: () => setPassword("") },
    );
  };
  return (
    <form onSubmit={submit}>
      <Card>
        <CardHeader
          icon={<Server />}
          title="SMTP"
          description="Used when SMTP is selected, and as the fallback described above. Any relay works (Postmark, Mailgun, SES, your own server)."
          actions={
            <Badge tone={s.smtp.fromEnv ? "info" : "ok"} dot>
              {s.smtp.fromEnv ? "Server default" : "Saved here"}
            </Badge>
          }
        />
        <CardBody className="flex flex-col gap-4">
          <KeyValueList
            items={[
              { label: "Sending through", value: <code className="font-mono text-xs">{`${s.smtp.host}:${s.smtp.port}`}</code> },
              { label: "TLS", value: s.smtp.secure ? "Yes (implicit TLS)" : "STARTTLS when offered" },
              { label: "Sign-in", value: s.smtp.authenticated ? s.smtp.user : "None" },
            ]}
          />
          <FormError error={save.error && !Object.keys(fields).length ? save.error.message : (clear.error?.message ?? null)} />
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-[1fr_7rem]">
            <Field label="Host" error={fields.smtpHost} hint="Empty: the server's SMTP_* environment.">
              <Input value={form.host} onChange={(e) => setForm({ ...form, host: e.target.value })} placeholder="smtp.postmarkapp.com" disabled={!canChange} className="font-mono" />
            </Field>
            <Field label="Port" error={fields.smtpPort}>
              <Input type="number" min={1} max={65535} value={form.port} onChange={(e) => setForm({ ...form, port: e.target.value })} disabled={!canChange} />
            </Field>
          </div>
          <Switch checked={form.secure} disabled={!canChange} onCheckedChange={(v) => setForm({ ...form, secure: v })} label="Implicit TLS" description="On for port 465. Off for 587 and 25, which upgrade with STARTTLS when the server offers it." />
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Username" error={fields.smtpUser} hint="Empty: no sign-in.">
              <Input value={form.user} onChange={(e) => setForm({ ...form, user: e.target.value })} autoComplete="off" disabled={!canChange} />
            </Field>
            <Field label="Password" error={fields.smtpPassword} hint={!s.smtp.fromEnv && s.smtp.passwordSet ? "Saved. Enter a new one to replace it." : "Stored encrypted and never shown again."}>
              <Input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={!s.smtp.fromEnv && s.smtp.passwordSet ? "••••••••" : ""} disabled={!canChange} />
            </Field>
          </div>
        </CardBody>
        {canChange && (
          <CardFooter>
            {!s.smtp.fromEnv && (
              <Button variant="ghost" onClick={() => setClearing(true)}>
                Remove
              </Button>
            )}
            <Button type="submit" variant="primary" loading={save.isPending} disabled={!dirty || !form.host.trim()}>
              Save SMTP server
            </Button>
          </CardFooter>
        )}
      </Card>
      <ConfirmDialog
        open={clearing}
        onOpenChange={setClearing}
        title="Remove the SMTP server?"
        description="SMTP mail then goes through the server's SMTP_* environment."
        confirmLabel="Remove"
        onConfirm={() => clear.mutateAsync({ smtpHost: "", smtpUser: "", smtpPassword: "" })}
      />
    </form>
  );
}

// ─── Test send ───────────────────────────────────────────────────────────────

export function SendResultView({ r }: { r: SendResult }) {
  return (
    <div className="flex flex-col gap-3">
      <Callout tone={!r.ok ? "bad" : r.fallbackReason ? "warn" : "ok"} title={r.ok ? `Sent to ${r.to}` : "Not sent"}>
        {r.ok ? (r.fallbackReason ? "Resend refused the request, so SMTP sent it." : "Check your inbox. Delivery events appear in the delivery log.") : r.error}
      </Callout>
      <KeyValueList
        items={[
          { label: "Provider", value: r.provider === "resend" ? "Resend" : "SMTP" },
          {
            label: "Message id",
            value: r.providerMessageId ? (
              <span className="flex items-center gap-1">
                <code className="truncate font-mono text-xs">{r.providerMessageId}</code>
                <CopyButton value={r.providerMessageId} />
              </span>
            ) : null,
          },
          { label: "Fallback reason", value: r.fallbackReason },
          { label: "Error", value: r.ok ? null : r.error },
        ]}
      />
    </div>
  );
}

function TestSend() {
  const [result, setResult] = useState<SendResult | null>(null);
  const send = useApiMutation<SendResult, void>({
    path: "/admin/email/test",
    body: () => ({}),
    invalidate: [platformKey("email-log")],
    onSuccess: (r) => setResult(r),
  });
  return (
    <>
      <Button variant="primary" icon={<Send />} loading={send.isPending} onClick={() => send.mutate()}>
        Send test email
      </Button>
      <Modal
        open={result !== null}
        onOpenChange={(v) => !v && setResult(null)}
        title="Test email"
        footer={
          <>
            {result && (
              <Button href="/email" variant="ghost">
                Open delivery log
              </Button>
            )}
            <Button onClick={() => setResult(null)}>Close</Button>
          </>
        }
      >
        {result && <SendResultView r={result} />}
      </Modal>
    </>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────

export function EmailSettings() {
  const { canChange } = usePlatform();
  const settings = useApiQuery<Settings>(SETTINGS_KEY, "/admin/email/settings");
  return (
    <Page width="capped">
      <PageHeader
        icon={<PlatformTile of="email" />}
        title="Email settings"
        description="How the platform's own email is sent, who it comes from, and how delivery is tracked."
        actions={canChange && <TestSend />}
      />
      {!canChange && (
        <Callout tone="info" className="mb-4">
          Platform support can view these settings; an admin or owner changes them.
        </Callout>
      )}
      <QueryState query={settings} loading={<SkeletonText lines={10} />}>
        {(s) => (
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            <div className="flex min-w-0 flex-col gap-4">
              <Delivery s={s} />
              <ResendKeys s={s} />
              <Senders s={s} />
            </div>
            <div className="flex min-w-0 flex-col gap-4">
              <WebhookSetup s={s} />
              <Domains s={s} />
              <Smtp s={s} />
            </div>
          </div>
        )}
      </QueryState>
    </Page>
  );
}
