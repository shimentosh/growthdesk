"use client";

import { useState, type FormEvent, type ReactNode } from "react";
import { ArrowRight, Archive, Bot, CircleCheck, CircleX, CreditCard, KeyRound, MailCheck, OctagonPause, Sparkles, Trash2, UserPlus, Wallet, Wrench } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Card, CardBody, CardFooter, CardHeader } from "@/components/ui/Card";
import { ConfirmDialog } from "@/components/ui/Dialog";
import { QueryState } from "@/components/ui/ErrorState";
import { Field, FormError } from "@/components/ui/Field";
import { Input, NativeSelect, Textarea } from "@/components/ui/Input";
import { Page, PageHeader } from "@/components/ui/PageHeader";
import { SkeletonText } from "@/components/ui/Skeleton";
import { Switch } from "@/components/ui/Switch";
import { useApiMutation, useApiQuery } from "@/lib/query";
import type { AdminSettings, ContactEmailValidation, EmailCheck, EmailValidationResult, RetentionKey } from "@/features/common/types";
import { CopyValue } from "@/features/email/common";
import { PlatformTile, platformKey, usePlatform } from "@/features/common/platform";

/*
 * Install-level policy (PlatformSettingsService). Each switch here is read by
 * the code that enforces it — the access guard (maintenance), the email send
 * path (outreach), sign-up, billing and the AI service — so the copy below
 * describes what those do, not what we would like them to do. Other API and
 * worker processes pick a change up within a few seconds.
 */

type SecretName = "aiApiKey" | "googleClientSecret" | "microsoftClientSecret" | "discordClientSecret" | "discordBotToken" | "stripeSecretKey" | "stripeWebhookSecret";
type Patch = Partial<Omit<AdminSettings, "plans" | "env" | "urls" | `${string}Set` | `${string}FromEnv`>> & Partial<Record<SecretName, string>>;

function useSave(success = "Settings saved") {
  return useApiMutation<AdminSettings, Patch>({
    method: "PATCH",
    path: "/admin/settings",
    invalidate: [platformKey("settings"), platformKey("overview"), platformKey("plans")],
    success,
    errorToast: false,
  });
}

function ReadOnlyNote() {
  const { canChange } = usePlatform();
  return canChange ? null : <Callout tone="info">Platform support can view these settings; an admin or owner changes them.</Callout>;
}

function Section({ title, description, icon, children, footer }: { title: string; description?: ReactNode; icon?: ReactNode; children: ReactNode; footer?: ReactNode }) {
  return (
    <Card>
      <CardHeader icon={icon} title={title} description={description} />
      <CardBody className="flex flex-col gap-4">{children}</CardBody>
      {footer && <CardFooter>{footer}</CardFooter>}
    </Card>
  );
}

function Maintenance({ s }: { s: AdminSettings }) {
  const { canChange } = usePlatform();
  const [message, setMessage] = useState(s.maintenanceMessage);
  const [confirm, setConfirm] = useState<boolean | null>(null);
  const save = useSave();
  return (
    <Section
      icon={<Wrench />}
      title="Maintenance mode"
      description="While on, signed-in customers can still read, but every change they try is refused with the message below. Platform staff, API-key requests, webhooks and background jobs are not affected."
      footer={
        canChange && (
          <Button variant="primary" loading={save.isPending && confirm === null} disabled={message === s.maintenanceMessage} onClick={() => save.mutate({ maintenanceMessage: message.trim() })}>
            Save message
          </Button>
        )
      }
    >
      {s.maintenanceMode && <Callout tone="warn" title="Maintenance mode is on">Customers cannot change anything right now.</Callout>}
      <Switch checked={s.maintenanceMode} disabled={!canChange} onCheckedChange={(v) => setConfirm(v)} label="Maintenance mode" />
      <FormError error={save.error?.message} />
      <Field label="Message shown to customers" hint="Empty: “Growthdesk is in maintenance for a few minutes — nothing can be changed until it is back.”">
        <Textarea rows={2} value={message} onChange={(e) => setMessage(e.target.value)} maxLength={500} disabled={!canChange} />
      </Field>
      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(v) => !v && setConfirm(null)}
        tone={confirm ? "danger" : "default"}
        title={confirm ? "Turn maintenance mode on?" : "Turn maintenance mode off?"}
        description={confirm ? "Customers will not be able to change anything until you switch it off." : "Customers can work normally again."}
        confirmLabel={confirm ? "Turn on" : "Turn off"}
        onConfirm={async () => {
          await save.mutateAsync({ maintenanceMode: Boolean(confirm), maintenanceMessage: message.trim() });
          setConfirm(null);
        }}
      />
    </Section>
  );
}

function Outreach({ s }: { s: AdminSettings }) {
  const { canChange } = usePlatform();
  const [confirm, setConfirm] = useState<boolean | null>(null);
  const save = useSave(s.outreachEnabled ? "Outreach paused" : "Outreach resumed");
  return (
    <Section
      icon={<OctagonPause />}
      title="Outreach kill switch"
      description="Pauses campaign email on every workspace at once. Held messages wait and are retried later; nothing is dropped. Replies and one-off emails sent from the inbox are not held."
    >
      {!s.outreachEnabled && <Callout tone="warn" title="Outreach is paused">No campaign email is being sent.</Callout>}
      <Switch checked={s.outreachEnabled} disabled={!canChange} onCheckedChange={(v) => setConfirm(v)} label="Campaign email is sending" />
      <FormError error={save.error?.message} />
      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(v) => !v && setConfirm(null)}
        tone={confirm ? "default" : "danger"}
        title={confirm ? "Resume outreach?" : "Pause all outreach?"}
        description={confirm ? "Campaign email starts sending again as it falls due." : "Campaign email stops on every workspace until you resume it."}
        confirmLabel={confirm ? "Resume" : "Pause outreach"}
        onConfirm={async () => {
          await save.mutateAsync({ outreachEnabled: Boolean(confirm) });
          setConfirm(null);
        }}
      />
    </Section>
  );
}

/** Sign-up controls live on /registration (mode, domains, verification, trials, waitlist, invitations). */
function SignupsMoved() {
  return (
    <Card>
      <CardHeader
        icon={<UserPlus />}
        title="Sign-ups"
        description="Sign-up settings moved to Registration: who can sign up, allowed and blocked domains, email confirmation, trial length, the waitlist and invitations."
        actions={
          <Button size="sm" href="/registration" iconRight={<ArrowRight />}>
            Open Registration
          </Button>
        }
      />
    </Card>
  );
}

function Billing({ s }: { s: AdminSettings }) {
  const { canChange } = usePlatform();
  const [def, setDef] = useState(s.defaultPlanKey);
  const [expired, setExpired] = useState(s.expiredPlanKey);
  const [grace, setGrace] = useState(String(s.graceDays));
  const [trials, setTrials] = useState(s.trialsPerIpPerDay === null ? "" : String(s.trialsPerIpPerDay));
  const save = useSave();
  const fields = save.error?.fields ?? {};
  const options = s.plans.map((p) => ({ value: p.key, label: `${p.name}${p.isActive ? "" : " (inactive)"}`, disabled: !p.isActive }));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate({ defaultPlanKey: def, expiredPlanKey: expired, graceDays: Number(grace || "0"), trialsPerIpPerDay: trials.trim() === "" ? null : Number(trials) });
  };
  return (
    <form onSubmit={submit}>
      <Section
        icon={<CreditCard />}
        title="Billing policy"
        description="See docs/BILLING.md for the full access policy."
        footer={
          canChange && (
            <Button type="submit" variant="primary" loading={save.isPending}>
              Save
            </Button>
          )
        }
      >
        <FormError error={save.error && !Object.keys(fields).length ? save.error.message : null} />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Plan for new accounts" error={fields.defaultPlanKey} hint="A person's first workspace starts on this plan, with its trial if it has one.">
            <NativeSelect value={def} onChange={(e) => setDef(e.target.value)} options={options} disabled={!canChange} />
          </Field>
          <Field label="Plan after a subscription lapses" error={fields.expiredPlanKey} hint="Applies when a subscription is canceled or expires, or a trial ends unpaid.">
            <NativeSelect value={expired} onChange={(e) => setExpired(e.target.value)} options={options} disabled={!canChange} />
          </Field>
        </div>
        <Field label="Grace period after a failed payment (days)" error={fields.graceDays} hint="Full access continues this long. Applies to payments that fail from now on.">
          <Input type="number" min={0} max={60} value={grace} onChange={(e) => setGrace(e.target.value)} disabled={!canChange} className="sm:max-w-32" />
        </Field>
        <Field
          label="Free trials per sign-up IP address per day"
          error={fields.trialsPerIpPerDay}
          hint={`Later accounts from the same address that day start without a trial. 0 = no limit. Empty: the server default (${s.env.trialsPerIpPerDay}).`}
        >
          <Input type="number" min={0} max={1000} value={trials} onChange={(e) => setTrials(e.target.value)} placeholder={String(s.env.trialsPerIpPerDay)} disabled={!canChange} className="sm:max-w-32" />
        </Field>
      </Section>
    </form>
  );
}

function Ai({ s }: { s: AdminSettings }) {
  const { canChange } = usePlatform();
  const [provider, setProvider] = useState(s.aiProvider);
  const [model, setModel] = useState(s.aiModel);
  const [baseUrl, setBaseUrl] = useState(s.aiBaseUrl);
  const [key, setKey] = useState("");
  const save = useSave();
  const clearKey = useSave("Admin-set AI key removed");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate({ aiProvider: provider, aiModel: model.trim(), aiBaseUrl: baseUrl.trim(), ...(key.trim() ? { aiApiKey: key.trim() } : {}) }, { onSuccess: () => setKey("") });
  };
  return (
    <form onSubmit={submit}>
      <Section
        icon={<Sparkles />}
        title="AI provider"
        description="The provider and model every workspace's AI features use. Without a provider and key, AI features answer that no provider is configured."
        footer={
          canChange && (
            <>
              <Button icon={<Trash2 />} disabled={!s.aiApiKeySet} loading={clearKey.isPending} onClick={() => clearKey.mutate({ aiApiKey: "" })}>
                Remove admin-set key
              </Button>
              <Button type="submit" variant="primary" loading={save.isPending}>
                Save
              </Button>
            </>
          )
        }
      >
        <FormError error={save.error?.fields.aiBaseUrl ? null : (save.error?.message ?? clearKey.error?.message)} />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Provider">
            <NativeSelect
              value={provider}
              onChange={(e) => setProvider(e.target.value as AdminSettings["aiProvider"])}
              disabled={!canChange}
              options={[
                { value: "none", label: "None" },
                { value: "anthropic", label: "Anthropic" },
                { value: "openai", label: "OpenAI" },
              ]}
            />
          </Field>
          <Field label="Model" hint="Empty: the provider's default model.">
            <Input value={model} onChange={(e) => setModel(e.target.value)} disabled={!canChange} className="font-mono" />
          </Field>
        </div>
        <Field
          label="API key"
          hint={
            s.aiApiKeySet
              ? "A key is configured. It is stored encrypted and never shown. Enter a new one to replace it; removing the admin-set key falls back to the server's environment key, if there is one."
              : "No key is configured. It is stored encrypted and never shown again."
          }
        >
          <Input type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} disabled={!canChange} placeholder={s.aiApiKeySet ? "••••••••" : ""} />
        </Field>
        <Field
          label="Endpoint"
          error={save.error?.fields.aiBaseUrl}
          hint={`Optional: an OpenAI-compatible gateway or self-hosted server (https://host/v1). Empty: ${s.env.aiBaseUrl || "the provider's own API"}.`}
        >
          <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder={s.env.aiBaseUrl || "https://api.openai.com/v1"} disabled={!canChange} className="font-mono" />
        </Field>
      </Section>
    </form>
  );
}

/** A write-only secret: the input always starts empty; the badge says whether one applies and where it comes from. */
function SecretInput({
  label,
  set,
  fromEnv,
  envName,
  value,
  onChange,
  error,
  placeholder,
}: {
  label: string;
  set: boolean;
  fromEnv: boolean;
  envName: string;
  value: string;
  onChange: (v: string) => void;
  error?: string;
  placeholder?: string;
}) {
  const { canChange } = usePlatform();
  return (
    <Field
      label={label}
      labelAction={
        <Badge tone={!set ? "warn" : fromEnv ? "info" : "ok"} dot>
          {!set ? "Not set" : fromEnv ? `From ${envName}` : "Saved"}
        </Badge>
      }
      error={error}
      hint={set && !fromEnv ? "Stored encrypted and never shown. Enter a new one to replace it." : "Stored encrypted and never shown again."}
    >
      <Input type="password" autoComplete="new-password" spellCheck={false} value={value} onChange={(e) => onChange(e.target.value)} placeholder={set && !fromEnv ? "••••••••" : placeholder} disabled={!canChange} className="font-mono" />
    </Field>
  );
}

function Integrations({ s }: { s: AdminSettings }) {
  const { canChange } = usePlatform();
  const [form, setForm] = useState({ googleClientId: s.googleClientId, googleClientSecret: "", microsoftClientId: s.microsoftClientId, microsoftClientSecret: "", microsoftTenant: s.microsoftTenant });
  const save = useSave("Sign-in providers saved");
  const fields = save.error?.fields ?? {};
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const googleId = form.googleClientId.trim();
    const microsoftId = form.microsoftClientId.trim();
    save.mutate(
      {
        googleClientId: googleId,
        microsoftClientId: microsoftId,
        microsoftTenant: form.microsoftTenant.trim(),
        // A cleared client id drops its saved secret too: the pair then comes from the environment, if anywhere.
        ...(form.googleClientSecret.trim() ? { googleClientSecret: form.googleClientSecret.trim() } : googleId ? {} : { googleClientSecret: "" }),
        ...(form.microsoftClientSecret.trim() ? { microsoftClientSecret: form.microsoftClientSecret.trim() } : microsoftId ? {} : { microsoftClientSecret: "" }),
      },
      { onSuccess: () => setForm((f) => ({ ...f, googleClientSecret: "", microsoftClientSecret: "" })) },
    );
  };
  // An admin-set client id never borrows the environment's secret (PlatformSettingsService.oauthClient).
  const googleFromEnv = !s.googleClientId && s.googleClientSecretFromEnv;
  const microsoftFromEnv = !s.microsoftClientId && s.microsoftClientSecretFromEnv;
  return (
    <form onSubmit={submit}>
      <Section
        icon={<KeyRound />}
        title="Google and Microsoft sign-in"
        description="OAuth clients for “Sign in with Google” and for connecting Gmail and Microsoft 365 mailboxes. Without one, people sign in with a password and connect mailboxes over SMTP/IMAP."
        footer={
          canChange && (
            <Button type="submit" variant="primary" loading={save.isPending}>
              Save
            </Button>
          )
        }
      >
        <FormError error={save.error && !Object.keys(fields).length ? save.error.message : null} />
        <div className="flex flex-col gap-3 rounded-lg border border-line p-3.5">
          <div className="text-sm font-semibold text-text-hi">Google</div>
          <p className="text-xs text-text-3">Google Cloud → APIs &amp; Services → Credentials → Create OAuth client ID (Web application). Add both redirect URIs:</p>
          {s.urls.googleRedirectUris.map((u) => (
            <CopyValue key={u} value={u} />
          ))}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Client ID" error={fields.googleClientId} hint={googleFromEnv ? "Empty: GOOGLE_CLIENT_ID from the server." : "Empty: Google sign-in is off."}>
              <Input value={form.googleClientId} onChange={(e) => setForm({ ...form, googleClientId: e.target.value })} placeholder={s.env.googleClientId || "….apps.googleusercontent.com"} disabled={!canChange} className="font-mono" />
            </Field>
            <SecretInput
              label="Client secret"
              set={s.googleClientSecretSet}
              fromEnv={googleFromEnv}
              envName="GOOGLE_CLIENT_SECRET"
              value={form.googleClientSecret}
              onChange={(v) => setForm({ ...form, googleClientSecret: v })}
              error={fields.googleClientSecret}
              placeholder="GOCSPX-…"
            />
          </div>
        </div>
        <div className="flex flex-col gap-3 rounded-lg border border-line p-3.5">
          <div className="text-sm font-semibold text-text-hi">Microsoft 365</div>
          <p className="text-xs text-text-3">Microsoft Entra → App registrations → New registration (Web platform). Add this redirect URI, then create a client secret:</p>
          <CopyValue value={s.urls.microsoftRedirectUri} />
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Application (client) ID" error={fields.microsoftClientId} hint={microsoftFromEnv ? "Empty: MICROSOFT_CLIENT_ID from the server." : "Empty: Microsoft 365 is off."}>
              <Input value={form.microsoftClientId} onChange={(e) => setForm({ ...form, microsoftClientId: e.target.value })} placeholder={s.env.microsoftClientId || "00000000-0000-0000-0000-000000000000"} disabled={!canChange} className="font-mono" />
            </Field>
            <SecretInput
              label="Client secret"
              set={s.microsoftClientSecretSet}
              fromEnv={microsoftFromEnv}
              envName="MICROSOFT_CLIENT_SECRET"
              value={form.microsoftClientSecret}
              onChange={(v) => setForm({ ...form, microsoftClientSecret: v })}
              error={fields.microsoftClientSecret}
            />
          </div>
          <Field label="Tenant" error={fields.microsoftTenant} hint={`common = any work or personal account; organizations = work accounts only; or one tenant id. Empty: ${s.env.microsoftTenant}.`}>
            <Input value={form.microsoftTenant} onChange={(e) => setForm({ ...form, microsoftTenant: e.target.value })} placeholder={s.env.microsoftTenant} disabled={!canChange} className="font-mono sm:max-w-72" />
          </Field>
        </div>
      </Section>
    </form>
  );
}

function Discord({ s }: { s: AdminSettings }) {
  const { canChange } = usePlatform();
  const [form, setForm] = useState({ discordClientId: s.discordClientId, discordClientSecret: "", discordBotToken: "" });
  const save = useSave("Discord application saved");
  const fields = save.error?.fields ?? {};
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const id = form.discordClientId.trim();
    save.mutate(
      {
        discordClientId: id,
        // A cleared application id drops its saved secrets too: the three then come from the environment, if anywhere.
        ...(form.discordClientSecret.trim() ? { discordClientSecret: form.discordClientSecret.trim() } : id ? {} : { discordClientSecret: "" }),
        ...(form.discordBotToken.trim() ? { discordBotToken: form.discordBotToken.trim() } : id ? {} : { discordBotToken: "" }),
      },
      { onSuccess: () => setForm((f) => ({ ...f, discordClientSecret: "", discordBotToken: "" })) },
    );
  };
  // A saved application id never borrows the environment's secrets (PlatformSettingsService.discordApp).
  const fromEnv = !s.discordClientId;
  return (
    <form onSubmit={submit}>
      <Section
        icon={<Bot />}
        title="Discord"
        description="Optional: a shared Discord bot for every workspace, so customers connect with one click. Without it, each workspace sets up its own bot under Settings → Discord."
        footer={
          canChange && (
            <Button type="submit" variant="primary" loading={save.isPending}>
              Save
            </Button>
          )
        }
      >
        <FormError error={save.error && !Object.keys(fields).length ? save.error.message : null} />
        {s.discordConfigured ? (
          <Callout tone="ok" title="Discord is ready">
            Workspaces without their own bot connect with this one{fromEnv ? " (the DISCORD_* values from the server)" : ""}.
          </Callout>
        ) : (
          <Callout tone="info" title="No shared bot">
            Discord Developer Portal → Applications → New Application. From <b>OAuth2</b> copy the Client ID and reset the Client Secret, and add this redirect:
          </Callout>
        )}
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium text-text-2">OAuth2 redirect</span>
          <CopyValue value={s.urls.discordRedirectUri} />
        </div>
        <p className="text-xs text-text-3">Then open <b>Bot</b>, reset the token and paste it below. The bot needs no privileged gateway intents.</p>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Application (client) ID" error={fields.discordClientId} hint={s.env.discordClientId ? "Empty: DISCORD_CLIENT_ID from the server." : "Empty: Discord is off."}>
            <Input value={form.discordClientId} onChange={(e) => setForm({ ...form, discordClientId: e.target.value })} placeholder={s.env.discordClientId || "123456789012345678"} disabled={!canChange} className="font-mono" inputMode="numeric" />
          </Field>
          <SecretInput
            label="Client secret"
            set={s.discordClientSecretSet}
            fromEnv={s.discordClientSecretFromEnv}
            envName="DISCORD_CLIENT_SECRET"
            value={form.discordClientSecret}
            onChange={(v) => setForm({ ...form, discordClientSecret: v })}
            error={fields.discordClientSecret}
          />
          <SecretInput
            label="Bot token"
            set={s.discordBotTokenSet}
            fromEnv={s.discordBotTokenFromEnv}
            envName="DISCORD_BOT_TOKEN"
            value={form.discordBotToken}
            onChange={(v) => setForm({ ...form, discordBotToken: v })}
            error={fields.discordBotToken}
          />
        </div>
      </Section>
    </form>
  );
}

function Stripe({ s }: { s: AdminSettings }) {
  const { canChange } = usePlatform();
  const [secretKey, setSecretKey] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");
  const [clearing, setClearing] = useState(false);
  const save = useSave("Stripe keys saved");
  const clear = useSave("Stripe keys removed");
  const fields = save.error?.fields ?? {};
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate(
      { ...(secretKey.trim() ? { stripeSecretKey: secretKey.trim() } : {}), ...(webhookSecret.trim() ? { stripeWebhookSecret: webhookSecret.trim() } : {}) },
      {
        onSuccess: () => {
          setSecretKey("");
          setWebhookSecret("");
        },
      },
    );
  };
  const saved = (s.stripeSecretKeySet && !s.stripeSecretKeyFromEnv) || (s.stripeWebhookSecretSet && !s.stripeWebhookSecretFromEnv);
  return (
    <form onSubmit={submit}>
      <Section
        icon={<Wallet />}
        title="Stripe"
        description="Card payments and subscriptions. Checkout turns on once both the secret key and the webhook signing secret are set."
        footer={
          canChange && (
            <>
              <Button icon={<Trash2 />} disabled={!saved} onClick={() => setClearing(true)}>
                Remove saved keys
              </Button>
              <Button type="submit" variant="primary" loading={save.isPending} disabled={!secretKey.trim() && !webhookSecret.trim()}>
                Save
              </Button>
            </>
          )
        }
      >
        {s.stripeSecretKeySet && s.stripeWebhookSecretSet ? <Callout tone="ok">Stripe is configured: customers can pay by card.</Callout> : <Callout tone="info">Stripe is not configured yet, so plan changes go through support.</Callout>}
        <FormError error={save.error && !Object.keys(fields).length ? save.error.message : (clear.error?.message ?? null)} />
        <Field label="Webhook endpoint" hint="Stripe → Developers → Webhooks → Add endpoint. The events to send are listed in docs/BILLING.md.">
          <CopyValue value={s.urls.stripeWebhookUrl} />
        </Field>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <SecretInput label="Secret key" set={s.stripeSecretKeySet} fromEnv={s.stripeSecretKeyFromEnv} envName="STRIPE_SECRET_KEY" value={secretKey} onChange={setSecretKey} error={fields.stripeSecretKey} placeholder="sk_live_…" />
          <SecretInput label="Webhook signing secret" set={s.stripeWebhookSecretSet} fromEnv={s.stripeWebhookSecretFromEnv} envName="STRIPE_WEBHOOK_SECRET" value={webhookSecret} onChange={setWebhookSecret} error={fields.stripeWebhookSecret} placeholder="whsec_…" />
        </div>
      </Section>
      <ConfirmDialog
        open={clearing}
        onOpenChange={setClearing}
        tone="danger"
        title="Remove the saved Stripe keys?"
        description="Card checkout stops unless the server's environment has its own STRIPE_* keys. Subscriptions are not canceled, but their webhooks are refused until keys are saved again."
        confirmLabel="Remove"
        onConfirm={() => clear.mutateAsync({ stripeSecretKey: "", stripeWebhookSecret: "" })}
      />
    </form>
  );
}

const RETENTION: { key: RetentionKey; label: string; hint: string }[] = [
  { key: "domainEvents", label: "Domain events", hint: "Internal events, once workflows and webhooks are done with them." },
  { key: "messageEvents", label: "Email events", hint: "Per-message delivered, opened and clicked events." },
  { key: "workflowRuns", label: "Workflow runs", hint: "Finished runs on a workflow's Runs tab." },
  { key: "stepExecutions", label: "Campaign step history", hint: "Read by the per-step campaign report." },
  { key: "activityNoise", label: "Automated timeline entries", hint: "Automatic click entries on contact timelines." },
  { key: "aiUsage", label: "AI usage records", hint: "Per-call rows; monthly allowances are counted separately." },
  { key: "billingEvents", label: "Payment webhooks", hint: "The raw log of processed provider webhooks." },
  { key: "marketingSends", label: "Marketing recipients", hint: "Per-recipient rows of finished marketing campaigns." },
];

function Retention({ s }: { s: AdminSettings }) {
  const { canChange } = usePlatform();
  const [form, setForm] = useState(() => Object.fromEntries(RETENTION.map(({ key }) => [key, s.retentionDays[key] === undefined ? "" : String(s.retentionDays[key])])) as Record<RetentionKey, string>);
  const save = useSave("Data retention saved");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const days: Partial<Record<RetentionKey, number>> = {};
    for (const { key } of RETENTION) if (form[key].trim() !== "") days[key] = Number(form[key]);
    save.mutate({ retentionDays: days });
  };
  const describe = (d: number) => (d === 0 ? "kept forever" : `${d} days`);
  return (
    <form onSubmit={submit}>
      <Section
        icon={<Archive />}
        title="Data retention"
        description="How many days history is kept before the nightly cleanup removes it. 0 keeps it forever; empty uses the server default. Contacts, messages, deals and notes are never removed."
        footer={
          canChange && (
            <Button type="submit" variant="primary" loading={save.isPending}>
              Save
            </Button>
          )
        }
      >
        <FormError error={save.error?.message} />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {RETENTION.map(({ key, label, hint }) => (
            <Field key={key} label={label} hint={`${hint} Default: ${describe(s.env.retentionDays[key])}.`}>
              <Input type="number" min={0} max={36500} value={form[key]} onChange={(e) => setForm({ ...form, [key]: e.target.value })} placeholder={String(s.env.retentionDays[key])} disabled={!canChange} className="sm:max-w-32" />
            </Field>
          ))}
        </div>
      </Section>
    </form>
  );
}

const CHECK_LABEL: Record<EmailCheck, string> = {
  syntax: "Looks like an email address",
  blocked: "Not on the blocked list",
  disposable: "Not a disposable (throwaway) service",
  role: "A person, not a shared inbox",
  mail_server: "Domain can receive email",
};

/** Free checks on contacts' emails (core/email-validation.service.ts): no paid verification API. */
function EmailValidation({ s }: { s: AdminSettings }) {
  const { canChange } = usePlatform();
  const [form, setForm] = useState<ContactEmailValidation>(s.contactEmailValidation);
  const [domains, setDomains] = useState(s.contactEmailValidation.blockedDomains.join("\n"));
  const save = useSave("Email validation saved");
  const [probe, setProbe] = useState("");
  const test = useApiMutation<EmailValidationResult, { email: string }>({ path: "/admin/settings/email-validation/test", errorToast: false });
  const set = (patch: Partial<ContactEmailValidation>) => setForm({ ...form, ...patch });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate({ contactEmailValidation: { ...form, blockedDomains: domains.split(/[\s,]+/).map((d) => d.trim()).filter(Boolean) } });
  };
  const r = test.data;
  return (
    <form onSubmit={submit}>
      <Section
        icon={<MailCheck />}
        title="Contact email validation"
        description="Checks every email a contact gets when someone adds it, imports a CSV, or sends leads through the API or Claude (MCP). A refused address is not added: the person sees why, and an import lists the row with the reason. Free: no paid verification service. Emails people send to you and live chat are never refused."
        footer={
          canChange && (
            <Button type="submit" variant="primary" loading={save.isPending}>
              Save
            </Button>
          )
        }
      >
        <FormError error={save.error?.message} />
        <Switch checked={form.enabled} disabled={!canChange} onCheckedChange={(v) => set({ enabled: v })} label="Only add contacts with valid email addresses" description="Off: any address that looks like an email is accepted, as before." />
        <div className={form.enabled ? "flex flex-col gap-3 border-l-2 border-line pl-4" : "flex flex-col gap-3 border-l-2 border-line pl-4 opacity-60"}>
          <Switch size="sm" checked={form.blockDisposable} disabled={!canChange} onCheckedChange={(v) => set({ blockDisposable: v })} label="Refuse disposable email services" description="Throwaway inboxes such as mailinator.com, from a built-in list of about 700 services." />
          <Switch size="sm" checked={form.checkMailServer} disabled={!canChange} onCheckedChange={(v) => set({ checkMailServer: v })} label="Refuse domains that cannot receive email" description="Looks up the domain's mail server (DNS MX) and caches the answer. If DNS does not answer, the address is let through." />
          <Switch size="sm" checked={form.blockRoleAccounts} disabled={!canChange} onCheckedChange={(v) => set({ blockRoleAccounts: v })} label="Refuse shared role mailboxes" description="info@, sales@, support@, noreply@ and similar reach a team, not a person." />
          <Field label="Blocked domains" hint="One per line. These domains and their subdomains are never accepted.">
            <Textarea rows={3} value={domains} onChange={(e) => setDomains(e.target.value)} placeholder={"competitor.com\nexample.org"} disabled={!canChange} />
          </Field>
        </div>

        <div className="flex flex-col gap-2 border-t border-line pt-4">
          <span className="text-sm font-medium text-text">Try an address</span>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              type="text"
              value={probe}
              onChange={(e) => setProbe(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && probe.trim()) {
                  e.preventDefault();
                  test.mutate({ email: probe.trim() });
                }
              }}
              placeholder="someone@company.com"
              aria-label="Email address to test"
            />
            <Button type="button" loading={test.isPending} disabled={!probe.trim()} onClick={() => test.mutate({ email: probe.trim() })}>
              Check
            </Button>
          </div>
          <span className="text-xs text-text-3">Uses the saved settings, so save first if you changed a switch.</span>
          <FormError error={test.error?.message} />
          {r && (
            <div className="flex flex-col gap-2 rounded-md border border-line p-3">
              <div className="flex items-center gap-2">
                <Badge tone={r.ok ? "ok" : "bad"} dot>
                  {r.ok ? "Would be added" : "Would be refused"}
                </Badge>
                <span className="truncate text-sm text-text">{r.email}</span>
                {!r.enabled && <span className="text-xs text-text-3">(validation is off, so it is accepted today)</span>}
              </div>
              {r.message && <span className="text-xs text-text-2">{r.message}</span>}
              <ul className="flex flex-col gap-1">
                {r.checks.map((c) => (
                  <li key={c.check} className="flex items-center gap-2 text-xs">
                    {c.ok ? <CircleCheck aria-hidden className="size-3.5 text-ok-ink" /> : <CircleX aria-hidden className="size-3.5 text-bad-ink" />}
                    <span className="text-text-2">{CHECK_LABEL[c.check]}</span>
                    {c.detail && <span className="truncate text-text-3">· {c.detail}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </Section>
    </form>
  );
}

/** /settings */
export function PlatformSettings() {
  const q = useApiQuery<AdminSettings>(platformKey("settings"), "/admin/settings");
  return (
    <Page width="narrow">
      <PageHeader icon={<PlatformTile of="settings" />} title="General settings" description="Install-wide switches. Every change is recorded in the audit log." />
      <QueryState query={q} loading={<SkeletonText lines={10} />}>
        {(s) => (
          <div className="flex flex-col gap-4">
            <ReadOnlyNote />
            <Maintenance key={`m-${s.maintenanceMessage}`} s={s} />
            <Outreach s={s} />
            <EmailValidation key={`ev-${JSON.stringify(s.contactEmailValidation)}`} s={s} />
            <SignupsMoved />
            <Billing key={`b-${s.defaultPlanKey}-${s.expiredPlanKey}-${s.graceDays}-${s.trialsPerIpPerDay}`} s={s} />
            <Ai key={`a-${s.aiProvider}-${s.aiModel}-${s.aiBaseUrl}`} s={s} />
            <Integrations key={`i-${s.googleClientId}-${s.microsoftClientId}-${s.microsoftTenant}`} s={s} />
            <Discord key={`d-${s.discordClientId}`} s={s} />
            <Stripe s={s} />
            <Retention key={`r-${JSON.stringify(s.retentionDays)}`} s={s} />
          </div>
        )}
      </QueryState>
    </Page>
  );
}
