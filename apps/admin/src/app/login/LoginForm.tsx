"use client";

import { useState, type FormEvent } from "react";
import { LogOut, ShieldAlert } from "lucide-react";
import { ConsoleTile } from "@/components/shell/Brand";
import { Button } from "@/components/ui/Button";
import { Card, CardBody } from "@/components/ui/Card";
import { Field, FormError } from "@/components/ui/Field";
import { IconTile } from "@/components/ui/IconTile";
import { Input } from "@/components/ui/Input";
import { fieldsOf, get, messageOf, post } from "@/lib/api";
import { signOut } from "@/lib/session";
import type { Me } from "@/lib/types";

type Account = { email: string; name: string };

/** Email + password only: staff accounts are created with `pnpm admin:create`, never registered here. */
export function LoginForm({ next, noAccess: initialNoAccess }: { next: string; noAccess: Account | null }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [noAccess, setNoAccess] = useState<Account | null>(initialNoAccess);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setFields({});
    try {
      await post("/auth/login", { email, password }, { noAuthRedirect: true });
      const me = await get<Me>("/auth/me", { noAuthRedirect: true });
      if (me.user.platformRole === "none") {
        setNoAccess({ email: me.user.email, name: me.user.name });
        setBusy(false);
        return;
      }
      // A full load, so the proxy and the panel layout see the new session cookie.
      window.location.assign(next);
    } catch (err) {
      setFields(fieldsOf(err));
      setError(messageOf(err));
      setBusy(false);
    }
  }

  return (
    <main className="relative flex min-h-dvh flex-col items-center justify-center overflow-hidden bg-bg-deep px-4 py-10">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-80 opacity-70"
        style={{ background: "radial-gradient(60% 100% at 50% 0%, color-mix(in srgb, var(--tint-indigo) 14%, transparent), transparent)" }}
      />
      <div className="relative flex w-full max-w-sm flex-col items-center">
        <div className="mb-7 flex flex-col items-center gap-2.5">
          <ConsoleTile size="xl" />
          <div className="text-center">
            <div className="text-sm font-semibold tracking-[-0.01em] text-text-hi">Growthdesk Console</div>
            <div className="text-xs text-text-3">Platform operations</div>
          </div>
        </div>

        <Card className="w-full">
          {noAccess ? (
            <CardBody className="flex flex-col items-center gap-4 px-6 py-7 text-center sm:px-8">
              <IconTile icon={<ShieldAlert />} tint="orange" size="lg" />
              <div>
                <h1 className="text-xl font-semibold tracking-[-0.02em] text-text-hi">This account has no platform access</h1>
                <p className="mx-auto mt-1.5 max-w-[34ch] text-sm text-pretty text-text-3">
                  You are signed in as <span className="font-medium text-text-2">{noAccess.email}</span>, a customer account. Sign out and use a platform staff account.
                </p>
              </div>
              <Button variant="primary" icon={<LogOut />} className="w-full" onClick={() => void signOut()}>
                Sign out
              </Button>
            </CardBody>
          ) : (
            <CardBody className="flex flex-col gap-5 px-6 py-7 sm:px-8">
              <div className="text-center">
                <h1 className="text-xl font-semibold tracking-[-0.02em] text-text-hi">Sign in to the console</h1>
                <p className="mx-auto mt-1.5 max-w-[34ch] text-sm text-pretty text-text-3">For Growthdesk platform staff. Use your staff email and password.</p>
              </div>
              <form onSubmit={submit} className="flex flex-col gap-3" noValidate>
                <FormError error={Object.keys(fields).length ? null : error} />
                <Field label="Email" error={fields.email}>
                  <Input type="email" autoComplete="email" autoFocus required value={email} onChange={(e) => setEmail(e.target.value)} />
                </Field>
                <Field label="Password" error={fields.password}>
                  <Input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
                </Field>
                <Button type="submit" variant="primary" loading={busy} className="mt-1 w-full">
                  Sign in
                </Button>
              </form>
            </CardBody>
          )}
        </Card>
        <p className="mt-5 text-center text-xs text-text-3">Every change made here is recorded in the audit log.</p>
      </div>
    </main>
  );
}
