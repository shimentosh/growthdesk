"use client";

import Link from "next/link";
import { useState, type FormEvent, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { labelOf } from "@growthdesk/shared";
import { AuthCard, AuthFooter } from "@/components/account/AuthFrame";
import { TermsConsent } from "@/components/account/TermsConsent";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Field, FormError } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { LoadingBlock } from "@/components/ui/Skeleton";
import { ApiError, fieldsOf, get, messageOf, post } from "@/lib/api";
import { ME_KEY } from "@/lib/session";
import type { InvitationInfo, Me } from "@/lib/types";
import type { JoinResult } from "@/lib/types/admin";

/*
 * Accepting an invitation. Four ways in:
 *   signed in as the invited address  → one click to join
 *   signed in as someone else         → sign out, then continue
 *   signed out, account exists        → sign in, which comes back here
 *   signed out, no account            → name + password creates it and joins
 * Joining lands in the workspace with a full load, so every query starts fresh.
 */

function Frame({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
  return (
    <AuthCard title={title} description={subtitle}>
      {children}
    </AuthCard>
  );
}

function RegisterAndJoin({ token, invitation }: { token: string; invitation: InvitationInfo }) {
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [terms, setTerms] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setFields({});
    try {
      const joined = await post<JoinResult>(`/invitations/${encodeURIComponent(token)}/register`, { name: name.trim(), password, acceptTerms: terms }, { noAuthRedirect: true });
      window.location.assign(`/w/${joined.workspaceId}`);
    } catch (err) {
      setFields(fieldsOf(err));
      setError(messageOf(err));
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3" noValidate>
      <FormError error={Object.keys(fields).length ? null : error} />
      <Field label="Email" hint="The address the invitation was sent to.">
        <Input type="email" value={invitation.email} readOnly />
      </Field>
      <Field label="Your name" error={fields.name}>
        <Input autoComplete="name" autoFocus required value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
      </Field>
      <Field label="Choose a password" error={fields.password} hint="10+ characters, mixing three of: lower-case, upper-case, numbers, symbols.">
        <Input type="password" autoComplete="new-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
      </Field>
      <TermsConsent checked={terms} onCheckedChange={setTerms} error={fields.acceptTerms} />
      <Button type="submit" variant="primary" loading={busy} disabled={!name.trim() || !password || !terms} className="mt-1 w-full">
        Create account and join
      </Button>
    </form>
  );
}

function JoinAsMe({ token, invitation }: { token: string; invitation: InvitationInfo }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function join() {
    setBusy(true);
    setError(null);
    try {
      const joined = await post<JoinResult>(`/invitations/${encodeURIComponent(token)}/accept`, undefined, { noAuthRedirect: true });
      window.location.assign(`/w/${joined.workspaceId}`);
    } catch (err) {
      setError(messageOf(err));
      setBusy(false);
    }
  }

  return (
    <>
      <FormError error={error} />
      <Button variant="primary" loading={busy} onClick={join} className="w-full">
        Join {invitation.workspaceName}
      </Button>
    </>
  );
}

function WrongAccount({ token, invitation, me }: { token: string; invitation: InvitationInfo; me: Me }) {
  const [busy, setBusy] = useState(false);
  const here = `/invite/${encodeURIComponent(token)}`;

  async function switchAccount() {
    setBusy(true);
    try {
      await post("/auth/logout", undefined, { noAuthRedirect: true });
    } finally {
      // With an account: sign in as it and come back. Without: this page offers to create it.
      window.location.assign(invitation.accountExists ? `/login?next=${encodeURIComponent(here)}` : here);
    }
  }

  return (
    <>
      <Callout tone="warn" title="This invitation is for a different email">
        It was sent to {invitation.email}, but you&apos;re signed in as {me.user.email}.
      </Callout>
      <Button variant="primary" loading={busy} onClick={switchAccount} className="w-full">
        {invitation.accountExists ? `Sign out and sign in as ${invitation.email}` : `Sign out and create an account for ${invitation.email}`}
      </Button>
      <Button href="/" className="w-full">
        Stay signed in as {me.user.email}
      </Button>
    </>
  );
}

export function AcceptInvitation({ token }: { token: string }) {
  const invitation = useQuery<InvitationInfo, ApiError>({
    queryKey: ["invitation", token],
    queryFn: ({ signal }) => get<InvitationInfo>(`/invitations/${encodeURIComponent(token)}`, { signal, noAuthRedirect: true }),
    retry: false,
  });
  // Signed out is an answer here, not a reason to redirect.
  const me = useQuery<Me, ApiError>({
    queryKey: ME_KEY,
    queryFn: ({ signal }) => get<Me>("/auth/me", { signal, noAuthRedirect: true }),
    retry: false,
  });

  if (invitation.isPending || me.isPending) return <LoadingBlock label="Opening your invitation…" />;

  if (invitation.isError) {
    const gone = invitation.error.isNotFound;
    return (
      <Frame title={gone ? "This invitation can't be used" : "Couldn't open the invitation"}>
        <Callout tone="bad">
          {gone ? "It has expired, was already used, or was withdrawn. Ask the person who invited you to send a new one." : invitation.error.message}
        </Callout>
        <Button href="/" variant="primary" className="w-full">
          Go to Growthdesk
        </Button>
      </Frame>
    );
  }

  const inv = invitation.data;
  const title = `Join ${inv.workspaceName}`;
  const subtitle = `You've been invited as ${labelOf(inv.role).toLowerCase()}.`;
  const next = `/invite/${encodeURIComponent(token)}`;

  if (me.isSuccess) {
    const same = me.data.user.email.toLowerCase() === inv.email.toLowerCase();
    return (
      <Frame title={title} subtitle={subtitle}>
        {same ? <JoinAsMe token={token} invitation={inv} /> : <WrongAccount token={token} invitation={inv} me={me.data} />}
      </Frame>
    );
  }

  if (!me.error.isAuth) {
    return (
      <Frame title={title} subtitle={subtitle}>
        <Callout tone="bad">{me.error.message}</Callout>
        <Button variant="primary" className="w-full" onClick={() => void me.refetch()}>
          Try again
        </Button>
      </Frame>
    );
  }

  if (inv.accountExists) {
    return (
      <Frame title={title} subtitle={subtitle}>
        <p className="text-sm text-text-2">Sign in as {inv.email} to accept. You&apos;ll come straight back here.</p>
        <Button href={`/login?next=${encodeURIComponent(next)}`} variant="primary" className="w-full">
          Sign in to accept
        </Button>
        <AuthFooter>
          Forgot your password?{" "}
          <Link href="/forgot-password" className="font-medium text-accent-hi hover:underline">
            Reset it
          </Link>
        </AuthFooter>
      </Frame>
    );
  }

  return (
    <Frame title={title} subtitle={`${subtitle} Create your account to join.`}>
      <RegisterAndJoin token={token} invitation={inv} />
    </Frame>
  );
}
