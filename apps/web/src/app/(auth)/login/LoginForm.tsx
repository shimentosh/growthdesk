"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { AuthCard, AuthFooter } from "@/components/account/AuthFrame";
import { Button, buttonClass } from "@/components/ui/Button";
import { Field, FormError } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { ApiError, fieldsOf, messageOf, post } from "@/lib/api";

type LoginResult = { signedIn: boolean; twoFactorRequired?: boolean };

/**
 * Email + password, then — for an account with two-factor on — a code from the
 * authenticator app or a recovery code. `twoFactor` starts on the code step:
 * the Google callback sends a two-factor account to /login?step=2fa.
 */
export function LoginForm({
  next,
  googleEnabled,
  error: initialError,
  twoFactor = false,
}: {
  next: string;
  googleEnabled: boolean;
  error: string | null;
  twoFactor?: boolean;
}) {
  const [step, setStep] = useState<"password" | "code">(twoFactor ? "code" : "password");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(initialError);
  const [fields, setFields] = useState<Record<string, string>>({});

  function fail(err: unknown) {
    setFields(fieldsOf(err));
    setError(messageOf(err));
    setBusy(false);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setFields({});
    try {
      const res = await post<LoginResult>("/auth/login", { email, password }, { noAuthRedirect: true });
      if (res.twoFactorRequired) {
        setStep("code");
        setBusy(false);
        return;
      }
      // A full load, so the proxy and "/" see the new session cookie.
      window.location.assign(next);
    } catch (err) {
      fail(err);
    }
  }

  async function submitCode(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setFields({});
    try {
      await post("/auth/2fa/verify", { code }, { noAuthRedirect: true });
      window.location.assign(next);
    } catch (err) {
      // The pending sign-in ran out (time or attempts): start again from the password.
      if (err instanceof ApiError && err.code === "two_factor_expired") {
        setStep("password");
        setCode("");
      }
      fail(err);
    }
  }

  if (step === "code") {
    return (
      <AuthCard title="Two-factor authentication" description="Enter the 6-digit code from your authenticator app, or one of your recovery codes.">
        <form onSubmit={submitCode} className="flex flex-col gap-3" noValidate>
          <FormError error={Object.keys(fields).length ? null : error} />
          <Field label="Code" error={fields.code}>
            <Input
              inputMode="text"
              autoComplete="one-time-code"
              autoFocus
              required
              maxLength={32}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="123456"
              className="font-mono tracking-wider"
            />
          </Field>
          <Button type="submit" variant="primary" loading={busy} disabled={code.trim().length < 6} className="mt-1 w-full">
            Verify
          </Button>
        </form>
        <AuthFooter>
          No access to your app? Enter one of the recovery codes you saved.{" "}
          <button
            type="button"
            className="font-medium text-accent-hi hover:underline"
            onClick={() => {
              setStep("password");
              setCode("");
              setError(null);
              setFields({});
            }}
          >
            Start over
          </button>
        </AuthFooter>
      </AuthCard>
    );
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
      {googleEnabled && (
        <a href="/api/auth/google/start" className={buttonClass({ variant: "secondary", className: "w-full" })}>
          Continue with Google
        </a>
      )}
      <AuthFooter>
        New here?{" "}
        <Link href={next === "/" ? "/register" : `/register?next=${encodeURIComponent(next)}`} className="font-medium text-accent-hi hover:underline">
          Create an account
        </Link>
      </AuthFooter>
    </AuthCard>
  );
}
