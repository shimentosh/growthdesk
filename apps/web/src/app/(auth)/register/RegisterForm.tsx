"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import type { SignupMode } from "@growthdesk/shared";
import { AuthCard, AuthFooter } from "@/components/account/AuthFrame";
import { Button, buttonClass } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Checkbox } from "@/components/ui/Checkbox";
import { Field, FormError } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { fieldsOf, get, isApiError, messageOf, post } from "@/lib/api";
import { GOOGLE_ERROR_MESSAGES } from "../oauth-errors";

/** GET /auth/signup-policy — apps/api/src/auth/auth.service.ts `signupPolicy()` */
export type SignupPolicy = {
  mode: SignupMode;
  googleEnabled: boolean;
  requiresInvite: boolean;
  invite: { valid: boolean; email: string | null } | null;
};

/** The codes the Google round-trip sends back as ?error=: sign-up policy refusals, and Google's own failures. */
const ERROR_MESSAGES: Record<string, string> = {
  ...GOOGLE_ERROR_MESSAGES,
  signup_closed: "New sign-ups are closed right now.",
  signup_waitlist: "We're onboarding from a waitlist right now. Join it below and we'll email you an invitation.",
  signup_invite_required: "Sign-ups are by invitation only. Open the link in your invitation email.",
  signup_invite_invalid: "That invitation link is invalid, already used, or was sent to a different address.",
  signup_domain_not_allowed: "Sign-ups are limited to approved email domains.",
  signup_domain_blocked: "That email domain can't be used to sign up. Use your work email address.",
};

type View = "form" | "waitlist" | "closed" | "invite_only";

function initialView(policy: SignupPolicy): View {
  const invited = Boolean(policy.invite?.valid);
  if (policy.mode === "closed") return "closed";
  if (policy.mode === "waitlist" && !invited) return "waitlist";
  if (policy.mode === "invite_only" && !invited) return "invite_only";
  return "form";
}

/**
 * Registering signs the person in; the verification email goes out at the
 * same time (an invitation link already proves the address). An address that
 * already has an account is not signed in: its owner gets an email, and the
 * page says to check the inbox (it never says whether the account exists). What shows
 * depends on the install's sign-up mode: the form, a waitlist form, an
 * "invitation needed" notice, or a closed notice.
 */
export function RegisterForm({ next, invite, error: initialError, policy }: { next: string; invite: string; error: string; policy: SignupPolicy }) {
  const [view, setView] = useState<View>(() => initialView(policy));
  const inviteEmail = policy.invite?.valid ? (policy.invite.email ?? "") : "";
  const [name, setName] = useState("");
  const [email, setEmail] = useState(inviteEmail);
  const [password, setPassword] = useState("");
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [joined, setJoined] = useState(false);
  const [checkInbox, setCheckInbox] = useState(false);
  const [error, setError] = useState<string | null>(initialError ? (ERROR_MESSAGES[initialError] ?? null) : null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const signInHref = next === "/" ? "/login" : `/login?next=${encodeURIComponent(next)}`;
  const badInvite = Boolean(invite) && policy.invite !== null && !policy.invite.valid;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setFields({});
    try {
      await post(
        "/auth/register",
        { name, email, password, marketingConsent: consent, ...(invite && policy.invite?.valid ? { inviteToken: invite } : {}) },
        { noAuthRedirect: true },
      );
      // An address that already has an account gets the same answer but no session; its owner is emailed instead.
      const signedIn = await get("/auth/me", { noAuthRedirect: true }).then(
        () => true,
        () => false,
      );
      if (signedIn) window.location.assign(next);
      else {
        setCheckInbox(true);
        setBusy(false);
      }
    } catch (err) {
      // The policy may have changed since the page loaded.
      if (isApiError(err) && err.code === "signup_waitlist") setView("waitlist");
      else if (isApiError(err) && err.code === "signup_closed") setView("closed");
      setFields(fieldsOf(err));
      setError(messageOf(err));
      setBusy(false);
    }
  }

  async function joinWaitlist(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setFields({});
    try {
      await post("/auth/waitlist", { name, email }, { noAuthRedirect: true });
      setJoined(true);
    } catch (err) {
      setFields(fieldsOf(err));
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  const footer = (
    <AuthFooter>
      Already have an account?{" "}
      <Link href={signInHref} className="font-medium text-accent-hi hover:underline">
        Sign in
      </Link>
    </AuthFooter>
  );

  if (view === "closed") {
    return (
      <AuthCard title="Sign-ups are closed" description="We're not taking new accounts right now. Please check back later.">
        {footer}
      </AuthCard>
    );
  }

  if (view === "invite_only") {
    return (
      <AuthCard title="Invitation needed" description="Accounts are by invitation only. Open the sign-up link from your invitation email to continue.">
        {badInvite && <Callout tone="warn">That invitation link is invalid, already used or expired. Ask for a new one.</Callout>}
        {footer}
      </AuthCard>
    );
  }

  if (view === "waitlist") {
    if (joined) {
      return (
        <AuthCard title="You're on the list" description={`We'll email ${email} as soon as there's a place for you.`}>
          {footer}
        </AuthCard>
      );
    }
    return (
      <AuthCard title="Join the waitlist" description="We're letting people in gradually. Leave your email and we'll send you an invitation.">
        <form onSubmit={joinWaitlist} className="flex flex-col gap-3" noValidate>
          {badInvite && <Callout tone="warn">That invitation link is invalid, already used or expired.</Callout>}
          <FormError error={Object.keys(fields).length ? null : error} />
          <Field label="Name" error={fields.name}>
            <Input autoComplete="name" autoFocus value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Work email" error={fields.email}>
            <Input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <Button type="submit" variant="primary" loading={busy} className="mt-1 w-full">
            Join the waitlist
          </Button>
        </form>
        {footer}
      </AuthCard>
    );
  }

  if (checkInbox) {
    return (
      <AuthCard title="Check your inbox" description={`We've sent an email to ${email} with the next step.`}>
        <p className="text-sm text-text-2">
          If you already have an account with this address, sign in instead. Forgot your password? Reset it from the sign-in page.
        </p>
        {footer}
      </AuthCard>
    );
  }

  const googleHref = `/api/auth/google/start?${new URLSearchParams({
    ...(invite && policy.invite?.valid ? { invite } : {}),
    ...(consent ? { consent: "1" } : {}),
  })}`;

  return (
    <AuthCard title="Create your account" description={inviteEmail ? "You've been invited. You will set up your workspace next." : "You will set up your workspace next."}>
      <form onSubmit={submit} className="flex flex-col gap-3" noValidate>
        {badInvite && <Callout tone="warn">That invitation link is invalid, already used or expired, so this is a regular sign-up.</Callout>}
        <FormError error={Object.keys(fields).length ? null : error} />
        <Field label="Name" error={fields.name}>
          <Input autoComplete="name" autoFocus required value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Work email" error={fields.email} hint={inviteEmail ? "The address your invitation was sent to." : undefined}>
          <Input type="email" autoComplete="email" required readOnly={Boolean(inviteEmail)} value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label="Password" error={fields.password} hint="10+ characters, mixing three of: lower-case, upper-case, numbers, symbols.">
          <Input type="password" autoComplete="new-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <Checkbox
          checked={consent}
          onCheckedChange={setConsent}
          label="Email me product news and tips"
          description="Optional. Account and billing emails are sent either way."
        />
        <Button type="submit" variant="primary" loading={busy} className="mt-1 w-full">
          Create account
        </Button>
      </form>
      {policy.googleEnabled && (
        <a href={googleHref} className={buttonClass({ variant: "secondary", className: "w-full" })}>
          Continue with Google
        </a>
      )}
      {footer}
    </AuthCard>
  );
}
