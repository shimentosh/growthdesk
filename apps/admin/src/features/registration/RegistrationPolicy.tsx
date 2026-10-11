"use client";

import Link from "next/link";
import { useMemo, useState, type FormEvent, type ReactNode } from "react";
import { Globe, MailCheck, ShieldBan, UserPlus } from "lucide-react";
import { SIGNUP_MODES, type SignupMode } from "@growthdesk/shared";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, CardBody, CardFooter, CardHeader } from "@/components/ui/Card";
import { Field, FormError } from "@/components/ui/Field";
import { Input, Textarea } from "@/components/ui/Input";
import { KeyValueList } from "@/components/ui/KeyValue";
import { Switch } from "@/components/ui/Switch";
import { cn } from "@/lib/cn";
import { useApiMutation, useApiQuery } from "@/lib/query";
import type { AdminPlan } from "@/features/common/types";
import { platformKey, usePlatform } from "@/features/common/platform";
import type { RegistrationPatch, RegistrationSettings, SignupPolicy } from "./types";

/*
 * The sign-up policy (auth.service assertSignupAllowed): who may create an
 * account, which addresses are refused, whether the address must be
 * confirmed, and the trial new accounts get. Saves only the keys that changed.
 */

const MODES: Record<SignupMode, { label: string; help: string }> = {
  open: { label: "Open", help: "Anyone can create an account, subject to the email domain rules below." },
  invite_only: { label: "Invite only", help: "Only people you send a sign-up invitation to can create an account. Everyone else is told sign-ups are by invitation." },
  waitlist: { label: "Waitlist", help: "Visitors leave their email on a waitlist instead of signing up. You invite them from the waitlist below when you're ready." },
  closed: { label: "Closed", help: "Nobody can create a new account, not even with a sign-up invitation. The register page says sign-ups are closed." },
};

const parseDomains = (text: string) => [
  ...new Set(
    text
      .split(/[\s,]+/)
      .map((d) => d.trim().toLowerCase().replace(/^@/, ""))
      .filter(Boolean),
  ),
];
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function Section({ icon, title, description, children }: { icon: ReactNode; title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <Card>
      <CardHeader icon={icon} title={title} description={description} />
      <CardBody className="flex flex-col gap-4">{children}</CardBody>
    </Card>
  );
}

export function RegistrationPolicy({ s }: { s: RegistrationSettings }) {
  const { canChange } = usePlatform();
  const plans = useApiQuery<AdminPlan[]>(platformKey("plans"), "/admin/plans", { staleTime: 5 * 60_000 });
  const policy = useApiQuery<SignupPolicy>(["signup-policy"], "/auth/signup-policy", { staleTime: 60_000 });
  const [mode, setMode] = useState<SignupMode>(s.signupMode);
  const [allowed, setAllowed] = useState(s.signupDomains.join("\n"));
  const [blockDisposable, setBlockDisposable] = useState(s.blockDisposableDomains);
  const [blocked, setBlocked] = useState(s.extraBlockedDomains.join("\n"));
  const [requireVerify, setRequireVerify] = useState(s.requireEmailVerification);
  const [overrideTrial, setOverrideTrial] = useState(s.defaultTrialDays !== null);
  const [trialDays, setTrialDays] = useState(String(s.defaultTrialDays ?? 14));

  const save = useApiMutation<RegistrationSettings, RegistrationPatch>({
    method: "PATCH",
    path: "/admin/settings",
    invalidate: [platformKey("settings"), platformKey("overview"), ["signup-policy"]],
    success: "Registration settings saved",
    errorToast: false,
  });
  const fields = save.error?.fields ?? {};

  const patch = useMemo<RegistrationPatch>(() => {
    const next: Required<RegistrationPatch> = {
      signupMode: mode,
      signupDomains: parseDomains(allowed),
      blockDisposableDomains: blockDisposable,
      extraBlockedDomains: parseDomains(blocked),
      requireEmailVerification: requireVerify,
      defaultTrialDays: overrideTrial ? Math.max(0, Math.min(365, Math.round(Number(trialDays) || 0))) : null,
    };
    return Object.fromEntries(Object.entries(next).filter(([k, v]) => !same(v, s[k as keyof RegistrationSettings]))) as RegistrationPatch;
  }, [mode, allowed, blockDisposable, blocked, requireVerify, overrideTrial, trialDays, s]);
  const dirty = Object.keys(patch).length > 0;

  const defaultPlan = plans.data?.find((p) => p.key === s.defaultPlanKey);
  const planTrial = defaultPlan ? (defaultPlan.trialDays > 0 ? `a ${defaultPlan.trialDays}-day trial` : "no trial") : null;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (dirty) save.mutate(patch);
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <Section icon={<UserPlus />} title="Who can sign up" description="People invited to an existing workspace can always create their account from that invitation, whatever the mode.">
        <div role="radiogroup" aria-label="Sign-up mode" className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {SIGNUP_MODES.map((m) => {
            const active = mode === m;
            return (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={active}
                disabled={!canChange}
                onClick={() => setMode(m)}
                className={cn(
                  "flex flex-col gap-1 rounded-md border px-3 py-2.5 text-left transition-colors disabled:cursor-not-allowed",
                  active ? "border-accent bg-info-wash" : "border-line hover:bg-hover",
                )}
              >
                <span className="flex items-center gap-2 text-sm font-medium text-text-hi">
                  <span aria-hidden className={cn("size-3.5 shrink-0 rounded-full border", active ? "border-[4px] border-accent" : "border-line-strong")} />
                  {MODES[m].label}
                  {s.signupMode === m && (
                    <Badge tone="mute" className="ml-auto">
                      Current
                    </Badge>
                  )}
                </span>
                <span className="pl-5.5 text-xs text-text-3">{MODES[m].help}</span>
              </button>
            );
          })}
        </div>
      </Section>

      <Section icon={<ShieldBan />} title="Email domains" description="A valid sign-up invitation skips these rules: you chose that address. The waitlist applies them too.">
        <Field label="Allowed domains" error={fields.signupDomains} hint="One per line. Empty: any domain may sign up. Example: a company-only install.">
          <Textarea rows={3} value={allowed} onChange={(e) => setAllowed(e.target.value)} disabled={!canChange} placeholder="example.com" className="font-mono" />
        </Field>
        <Switch
          checked={blockDisposable}
          onCheckedChange={setBlockDisposable}
          disabled={!canChange}
          label="Refuse disposable email addresses"
          description="Blocks about 700 well-known throwaway inbox services (Mailinator, YOPmail, 10 Minute Mail…) and their subdomains. The list ships with the app and is not exhaustive. Add others below."
        />
        <Field label="Also refuse these domains" error={fields.extraBlockedDomains} hint="One per line. Subdomains are refused too.">
          <Textarea rows={3} value={blocked} onChange={(e) => setBlocked(e.target.value)} disabled={!canChange} placeholder="spam-domain.example" className="font-mono" />
        </Field>
      </Section>

      <Section icon={<MailCheck />} title="Confirmation and trials">
        <Switch
          checked={requireVerify}
          onCheckedChange={setRequireVerify}
          disabled={!canChange}
          label="Require a confirmed email address"
          description="On: a new account must click the confirmation link before it can create a workspace or change anything. Off: it can start straight away (the confirmation email is still sent). People who arrive through an invitation are confirmed by that link."
        />
        <div className="flex flex-col gap-2">
          <Switch
            checked={overrideTrial}
            onCheckedChange={setOverrideTrial}
            disabled={!canChange}
            label="Override the plan's trial length"
            description={defaultPlan ? `New accounts start on ${defaultPlan.name}, which has ${planTrial}. Applies to accounts created from now on.` : "Applies to accounts created from now on."}
          />
          {overrideTrial && (
            <Field label="Trial length (days)" error={fields.defaultTrialDays} hint="0 = no trial: new accounts start on the plan straight away.">
              <Input type="number" min={0} max={365} value={trialDays} onChange={(e) => setTrialDays(e.target.value)} disabled={!canChange} className="sm:max-w-32" />
            </Field>
          )}
        </div>
      </Section>

      <Section icon={<Globe />} title="Around sign-up">
        <KeyValueList
          items={[
            {
              label: "Google sign-in",
              value: policy.data ? policy.data.googleEnabled ? <Badge tone="ok">Offered on the register page</Badge> : <span className="text-text-2">Not configured</span> : null,
              hint: policy.data && !policy.data.googleEnabled ? "Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET on the API to offer it." : undefined,
            },
            ...(s.landingEnabled === undefined ? [] : [{ label: "Public landing page", value: s.landingEnabled ? "On" : "Off: “/” sends visitors to sign in" }]),
            {
              label: "Plan for new accounts",
              value: defaultPlan?.name ?? s.defaultPlanKey,
              hint: (
                <Link href="/settings" className="hover:underline">
                  Change in General settings
                </Link>
              ),
            },
          ]}
        />
      </Section>

      {canChange && (
        <Card className={cn(dirty && "sticky bottom-3 z-10 shadow-lg")}>
          <CardFooter className="justify-between border-t-0">
            <span className="text-sm text-text-3">{dirty ? "You have unsaved changes." : "Every change is recorded in the audit log."}</span>
            <FormError error={save.error && !Object.keys(fields).length ? save.error.message : null} />
            <Button type="submit" variant="primary" loading={save.isPending} disabled={!dirty}>
              Save changes
            </Button>
          </CardFooter>
        </Card>
      )}
    </form>
  );
}
