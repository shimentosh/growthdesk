"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { AuthCard, AuthFooter } from "@/components/account/AuthFrame";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Field, FormError } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { fieldsOf, messageOf, post } from "@/lib/api";

/** The API answers the same whether or not the address has an account, so the page does too. */
export function ForgotPasswordForm() {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setFields({});
    try {
      await post("/auth/forgot-password", { email: email.trim() }, { noAuthRedirect: true });
      setSentTo(email.trim());
    } catch (err) {
      setFields(fieldsOf(err));
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthCard title="Reset your password" description="Enter the email you sign in with and we'll send you a link to choose a new password.">
      {sentTo ? (
        <>
          <Callout tone="ok" title="Check your inbox">
            If {sentTo} has a Growthdesk account, a reset link is on its way. It works for one hour. Nothing there? Check your spam folder.
          </Callout>
          <Button variant="secondary" className="w-full" onClick={() => setSentTo(null)}>
            Use a different email
          </Button>
        </>
      ) : (
        <form onSubmit={submit} className="flex flex-col gap-3" noValidate>
          <FormError error={Object.keys(fields).length ? null : error} />
          <Field label="Email" error={fields.email}>
            <Input type="email" autoComplete="email" autoFocus required value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <Button type="submit" variant="primary" loading={busy} disabled={!email.trim()} className="mt-1 w-full">
            Send reset link
          </Button>
        </form>
      )}
      <AuthFooter>
        Remembered it?{" "}
        <Link href="/login" className="font-medium text-accent-hi hover:underline">
          Sign in
        </Link>
      </AuthFooter>
    </AuthCard>
  );
}
