"use client";

import { useState, type FormEvent, type ReactNode } from "react";
import { ArrowRight, CreditCard, OctagonPause, Sparkles, Trash2, UserPlus, Wrench } from "lucide-react";
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
import type { AdminSettings } from "@/features/common/types";
import { PlatformTile, platformKey, usePlatform } from "@/features/common/platform";

/*
 * Install-level policy (PlatformSettingsService). Each switch here is read by
 * the code that enforces it — the access guard (maintenance), the email send
 * path (outreach), sign-up, billing and the AI service — so the copy below
 * describes what those do, not what we would like them to do. Other API and
 * worker processes pick a change up within a few seconds.
 */

type Patch = Partial<Omit<AdminSettings, "plans" | "aiApiKeySet">> & { aiApiKey?: string };

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
  const save = useSave();
  const fields = save.error?.fields ?? {};
  const options = s.plans.map((p) => ({ value: p.key, label: `${p.name}${p.isActive ? "" : " (inactive)"}`, disabled: !p.isActive }));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate({ defaultPlanKey: def, expiredPlanKey: expired, graceDays: Number(grace || "0") });
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
      </Section>
    </form>
  );
}

function Ai({ s }: { s: AdminSettings }) {
  const { canChange } = usePlatform();
  const [provider, setProvider] = useState(s.aiProvider);
  const [model, setModel] = useState(s.aiModel);
  const [key, setKey] = useState("");
  const save = useSave();
  const clearKey = useSave("Admin-set AI key removed");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate({ aiProvider: provider, aiModel: model.trim(), ...(key.trim() ? { aiApiKey: key.trim() } : {}) }, { onSuccess: () => setKey("") });
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
        <FormError error={save.error?.message ?? clearKey.error?.message} />
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
            <SignupsMoved />
            <Billing key={`b-${s.defaultPlanKey}-${s.expiredPlanKey}-${s.graceDays}`} s={s} />
            <Ai key={`a-${s.aiProvider}-${s.aiModel}`} s={s} />
          </div>
        )}
      </QueryState>
    </Page>
  );
}
