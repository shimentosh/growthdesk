"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { AuthCard, AuthFooter } from "@/components/account/AuthFrame";
import { Button } from "@/components/ui/Button";
import { Field, FormError } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { fieldsOf, messageOf, post } from "@/lib/api";

export function LoginForm({ next }: { next: string }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setFields({});
    try {
      await post("/auth/login", { email, password }, { noAuthRedirect: true });
      // A full load, so the proxy and "/" see the new session cookie.
      window.location.assign(next);
    } catch (err) {
      setFields(fieldsOf(err));
      setError(messageOf(err));
      setBusy(false);
    }
  }

  return (
    <AuthCard title="Sign in" description="Welcome back. Use the email and password for your account.">
      <form onSubmit={submit} className="flex flex-col gap-3" noValidate>
        <FormError error={Object.keys(fields).length ? null : error} />
        <Field label="Email" error={fields.email}>
          <Input type="email" autoComplete="email" autoFocus required value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field
          label="Password"
          error={fields.password}
          labelAction={
            <Link href="/forgot-password" className="text-xs text-accent-hi hover:underline">
              Forgot password?
            </Link>
          }
        >
          <Input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <Button type="submit" variant="primary" loading={busy} className="mt-1 w-full">
          Sign in
        </Button>
      </form>
      <AuthFooter>
        New here?{" "}
        <Link href={next === "/" ? "/register" : `/register?next=${encodeURIComponent(next)}`} className="font-medium text-accent-hi hover:underline">
          Create an account
        </Link>
      </AuthFooter>
    </AuthCard>
  );
}
