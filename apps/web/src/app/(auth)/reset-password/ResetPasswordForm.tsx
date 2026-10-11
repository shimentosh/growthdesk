"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { AuthCard, AuthFooter } from "@/components/account/AuthFrame";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Field, FormError } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { fieldsOf, messageOf, post } from "@/lib/api";

/** Resetting signs out every session (the API revokes them), so success sends the person to sign in. */
export function ResetPasswordForm({ token }: { token: string }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const mismatch = confirm.length > 0 && confirm !== password ? "The two passwords don't match." : undefined;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (mismatch) return;
    setBusy(true);
    setError(null);
    setFields({});
    try {
      await post("/auth/reset-password", { token, password }, { noAuthRedirect: true });
      setDone(true);
    } catch (err) {
      setFields(fieldsOf(err));
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthCard title="Choose a new password" description="Every device signed in to your account will be signed out.">
      {!token ? (
        <>
          <Callout tone="bad">This link is missing its token. Open the link from the email again, or ask for a new one.</Callout>
          <Button href="/forgot-password" variant="primary" className="w-full">
            Send a new link
          </Button>
        </>
      ) : done ? (
        <>
          <Callout tone="ok" title="Password changed">
            Sign in with your new password.
          </Callout>
          <Button href="/login" variant="primary" className="w-full">
            Sign in
          </Button>
        </>
      ) : (
        <form onSubmit={submit} className="flex flex-col gap-3" noValidate>
          <FormError error={Object.keys(fields).length && !fields.token ? null : (fields.token ?? error)} />
          <Field label="New password" error={fields.password} hint="10+ characters, mixing three of: lower-case, upper-case, numbers, symbols.">
            <Input type="password" autoComplete="new-password" autoFocus required value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
          <Field label="Confirm new password" error={mismatch}>
            <Input type="password" autoComplete="new-password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          </Field>
          <Button type="submit" variant="primary" loading={busy} disabled={!password || !confirm || Boolean(mismatch)} className="mt-1 w-full">
            Change password
          </Button>
        </form>
      )}
      {token && !done && (
        <AuthFooter>
          Link expired?{" "}
          <Link href="/forgot-password" className="font-medium text-accent-hi hover:underline">
            Send a new one
          </Link>
        </AuthFooter>
      )}
    </AuthCard>
  );
}
