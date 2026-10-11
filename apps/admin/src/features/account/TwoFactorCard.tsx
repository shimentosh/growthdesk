"use client";

import { useState, type FormEvent } from "react";
import { Copy, Download, ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Card, CardBody, CardFooter, CardHeader } from "@/components/ui/Card";
import { Modal } from "@/components/ui/Dialog";
import { QueryState } from "@/components/ui/ErrorState";
import { Field, FormError } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { SkeletonText } from "@/components/ui/Skeleton";
import { toast } from "@/components/ui/Toast";
import { useApiMutation, useApiQuery } from "@/lib/query";
import { ME_KEY, useFormat } from "@/lib/session";
import type { Me, TwoFactorSetup, TwoFactorStatus } from "@/lib/types";

const STATUS_KEY = ["account", "two-factor"];

/** The secret in groups of four, as authenticator apps show it for typing. */
const grouped = (secret: string) => secret.match(/.{1,4}/g)?.join(" ") ?? secret;

/** Shown once, straight after enrolment or regeneration: the API never returns them again. */
function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const text = codes.join("\n");
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      toast.success("Recovery codes copied");
    } catch {
      toast.error("Copying is blocked in this browser. Select the codes and copy them by hand.");
    }
  }
  function download() {
    const url = URL.createObjectURL(new Blob([`${text}\n`], { type: "text/plain" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "recovery-codes.txt";
    a.click();
    URL.revokeObjectURL(url);
  }
  return (
    <div className="flex flex-col gap-3">
      <Callout tone="warn" title="Save these recovery codes now">
        Each one signs you in once if you lose your authenticator app. They won't be shown again.
      </Callout>
      <ul className="grid grid-cols-2 gap-x-6 gap-y-1 rounded-md border border-line bg-well px-4 py-3 font-mono text-sm text-text-hi">
        {codes.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button size="sm" icon={<Copy />} onClick={() => void copy()}>
          Copy
        </Button>
        <Button size="sm" icon={<Download />} onClick={download}>
          Download
        </Button>
        <Button size="sm" variant="primary" onClick={onDone}>
          I've saved them
        </Button>
      </div>
    </div>
  );
}

/** Step 1: scan or type the secret. Step 2: confirm with a code, which turns two-factor on. */
function Enrol({ onEnabled }: { onEnabled: (codes: string[]) => void }) {
  const [code, setCode] = useState("");
  const setup = useApiMutation<TwoFactorSetup>({ path: "/auth/2fa/setup" });
  const enable = useApiMutation<{ recoveryCodes: string[] }, { code: string }>({
    path: "/auth/2fa/enable",
    invalidate: [STATUS_KEY, ME_KEY],
    errorToast: false,
    onSuccess: (r) => onEnabled(r.recoveryCodes),
  });
  const fields = enable.error?.fields ?? {};

  if (!setup.data) {
    return (
      <CardFooter className="justify-between">
        <span className="text-xs text-text-3">Works with Google Authenticator, 1Password, Authy and other TOTP apps.</span>
        <Button variant="primary" loading={setup.isPending} onClick={() => setup.mutate()}>
          Set up two-factor
        </Button>
      </CardFooter>
    );
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    enable.mutate({ code: code.trim() });
  }

  const { qrSvg, secret, otpauthUri } = setup.data;
  return (
    <form onSubmit={submit} noValidate>
      <CardBody className="flex flex-col gap-4">
        <div className="flex flex-col items-start gap-4 sm:flex-row">
          {/* The API renders the QR code as SVG; shown as an image so it cannot run anything. */}
          <img
            src={`data:image/svg+xml;utf8,${encodeURIComponent(qrSvg)}`}
            alt="QR code for your authenticator app"
            width={168}
            height={168}
            className="shrink-0 rounded-md border border-line bg-white p-1"
          />
          <div className="flex min-w-0 flex-col gap-2 text-sm text-text-2">
            <p>1. Scan the QR code with your authenticator app.</p>
            <p>Can't scan it? Enter this key by hand (time-based, 6 digits):</p>
            <code className="rounded-sm bg-well px-2 py-1 font-mono text-sm break-all text-text-hi select-all">{grouped(secret)}</code>
            <a href={otpauthUri} className="text-xs text-accent-hi hover:underline">
              Open in an authenticator app on this device
            </a>
            <p className="mt-1">2. Enter the 6-digit code the app shows.</p>
          </div>
        </div>
        <FormError error={enable.error && !Object.keys(fields).length ? enable.error.message : null} />
        <Field label="Code from the app" error={fields.code} className="sm:max-w-[calc(50%-0.5rem)]">
          <Input inputMode="numeric" autoComplete="one-time-code" maxLength={7} value={code} onChange={(e) => setCode(e.target.value)} placeholder="123456" className="font-mono tracking-wider" />
        </Field>
      </CardBody>
      <CardFooter>
        <Button type="submit" variant="primary" loading={enable.isPending} disabled={code.trim().length < 6}>
          Turn on two-factor
        </Button>
      </CardFooter>
    </form>
  );
}

function DisableDialog({ open, onOpenChange, hasPassword }: { open: boolean; onOpenChange: (open: boolean) => void; hasPassword: boolean }) {
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const disable = useApiMutation<{ disabled: true }, { code?: string; password?: string }>({
    path: "/auth/2fa/disable",
    invalidate: [STATUS_KEY, ME_KEY],
    success: "Two-factor authentication is off",
    errorToast: false,
    onSuccess: () => {
      setCode("");
      setPassword("");
      onOpenChange(false);
    },
  });
  const fields = disable.error?.fields ?? {};
  function submit(e: FormEvent) {
    e.preventDefault();
    disable.mutate(code.trim() ? { code: code.trim() } : { password });
  }
  return (
    <Modal open={open} onOpenChange={onOpenChange} size="sm" title="Turn off two-factor?" description="Signing in will need only your password or Google again.">
      <form onSubmit={submit} noValidate className="flex flex-col gap-3">
        <FormError error={disable.error && !Object.keys(fields).length ? disable.error.message : null} />
        <Field label="Code from your app, or a recovery code" error={fields.code}>
          <Input autoComplete="one-time-code" maxLength={32} value={code} onChange={(e) => setCode(e.target.value)} className="font-mono" />
        </Field>
        {hasPassword && (
          <Field label="Or your password" error={fields.password}>
            <Input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} disabled={Boolean(code.trim())} />
          </Field>
        )}
        <div className="flex justify-end gap-2 pt-1">
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="submit" variant="danger" loading={disable.isPending} disabled={!code.trim() && !password}>
            Turn off
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function RegenerateDialog({ open, onOpenChange, onCodes }: { open: boolean; onOpenChange: (open: boolean) => void; onCodes: (codes: string[]) => void }) {
  const [code, setCode] = useState("");
  const regenerate = useApiMutation<{ recoveryCodes: string[] }, { code: string }>({
    path: "/auth/2fa/recovery-codes",
    invalidate: [STATUS_KEY],
    errorToast: false,
    onSuccess: (r) => {
      setCode("");
      onOpenChange(false);
      onCodes(r.recoveryCodes);
    },
  });
  const fields = regenerate.error?.fields ?? {};
  function submit(e: FormEvent) {
    e.preventDefault();
    regenerate.mutate({ code: code.trim() });
  }
  return (
    <Modal open={open} onOpenChange={onOpenChange} size="sm" title="New recovery codes" description="Your old recovery codes stop working as soon as the new ones are made.">
      <form onSubmit={submit} noValidate className="flex flex-col gap-3">
        <FormError error={regenerate.error && !Object.keys(fields).length ? regenerate.error.message : null} />
        <Field label="Code from your app" error={fields.code}>
          <Input inputMode="numeric" autoComplete="one-time-code" maxLength={7} value={code} onChange={(e) => setCode(e.target.value)} className="font-mono tracking-wider" />
        </Field>
        <div className="flex justify-end gap-2 pt-1">
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="submit" variant="primary" loading={regenerate.isPending} disabled={code.trim().length < 6}>
            Make new codes
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/**
 * Your account → Two-factor authentication, for staff signing in to the
 * console (the same API as the customer app's account page): enrol, show
 * recovery codes once, regenerate them, or turn it off.
 */
export function TwoFactorCard({ user }: { user: Me["user"] }) {
  const f = useFormat();
  const status = useApiQuery<TwoFactorStatus>(STATUS_KEY, "/auth/2fa");
  const [codes, setCodes] = useState<string[] | null>(null);
  const [disabling, setDisabling] = useState(false);
  const [regenerating, setRegenerating] = useState(false);

  return (
    <Card id="two-factor">
      <CardHeader
        icon={<ShieldCheck />}
        title="Two-factor authentication"
        description="Ask for a code from an authenticator app after your password or Google sign-in."
        actions={status.data?.enabled ? <Badge tone="ok">On</Badge> : status.data ? <Badge quiet>Off</Badge> : undefined}
      />
      <QueryState query={status} loading={<SkeletonText lines={2} className="p-4" />}>
        {(s) => (
          <>
            {s.requiredBy.length > 0 && (
              <CardBody className="pb-0">
                <Callout tone={s.enabled ? "info" : "warn"} title={s.enabled ? undefined : "Required by your workspace"}>
                  {s.requiredBy.map((w) => w.name).join(", ")} {s.requiredBy.length === 1 ? "requires" : "require"} two-factor authentication
                  {s.enabled ? ", so it can't be turned off while you're a member." : ". Turn it on to keep using the workspace."}
                </Callout>
              </CardBody>
            )}
            {codes ? (
              <CardBody>
                <RecoveryCodes codes={codes} onDone={() => setCodes(null)} />
              </CardBody>
            ) : s.enabled ? (
              <CardFooter className="justify-between">
                <span className="text-xs text-text-3">
                  {s.enabledAt ? `On since ${f.date(s.enabledAt)}. ` : ""}
                  {s.recoveryCodesRemaining} recovery {s.recoveryCodesRemaining === 1 ? "code" : "codes"} left.
                </span>
                <span className="flex gap-2">
                  <Button size="sm" onClick={() => setRegenerating(true)}>
                    New recovery codes
                  </Button>
                  {s.requiredBy.length === 0 && (
                    <Button size="sm" variant="danger" onClick={() => setDisabling(true)}>
                      Turn off
                    </Button>
                  )}
                </span>
              </CardFooter>
            ) : (
              <Enrol onEnabled={setCodes} />
            )}
          </>
        )}
      </QueryState>
      <DisableDialog open={disabling} onOpenChange={setDisabling} hasPassword={user.hasPassword} />
      <RegenerateDialog open={regenerating} onOpenChange={setRegenerating} onCodes={setCodes} />
    </Card>
  );
}
