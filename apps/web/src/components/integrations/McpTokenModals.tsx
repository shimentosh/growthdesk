"use client";

import { useState, type FormEvent } from "react";
import { Plus } from "lucide-react";
import { MCP_ACCESS_INFO, MCP_ACCESS_LEVELS, type McpAccess } from "@growthdesk/shared";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Modal } from "@/components/ui/Dialog";
import { Field, FormError } from "@/components/ui/Field";
import { Input, NativeSelect } from "@/components/ui/Input";
import { cn } from "@/lib/cn";
import { useApiMutation } from "@/lib/query";
import { useWorkspace } from "@/lib/session";
import type { McpTokenWithSecret } from "@/lib/types/mcp";
import { CopyValue } from "./Copy";
import { McpSetup } from "./McpSetup";

const EXPIRY_OPTIONS = [
  { value: "", label: "Never" },
  { value: "7", label: "In 7 days" },
  { value: "30", label: "In 30 days" },
  { value: "90", label: "In 90 days" },
  { value: "365", label: "In 1 year" },
];

type Body = { name: string; access: McpAccess; expiresAt: string | null };

/**
 * Create an MCP token for yourself: a name, an access level, an optional
 * expiry. The response carries the full token — the only time the API
 * reveals it — which the caller shows through `onCreated`.
 */
export function McpTokenFormModal({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (open: boolean) => void; onCreated: (token: McpTokenWithSecret) => void }) {
  const ws = useWorkspace();
  const [name, setName] = useState("Claude");
  const [access, setAccess] = useState<McpAccess>("build");
  const [expiry, setExpiry] = useState("");

  const save = useApiMutation<McpTokenWithSecret, Body>({
    path: ws.path("/mcp/tokens"),
    invalidate: [ws.key("mcp")],
    errorToast: false,
    onSuccess: (token) => {
      onOpenChange(false);
      onCreated(token);
    },
  });
  const fields = save.error?.fields ?? {};

  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate({ name: name.trim(), access, expiresAt: expiry ? new Date(Date.now() + Number(expiry) * 86_400_000).toISOString() : null });
  };

  return (
    <Modal
      open={open}
      onOpenChange={(o) => {
        if (!o) save.reset();
        onOpenChange(o);
      }}
      size="lg"
      dismissOnOutside={false}
      title="Connect Claude"
      description="The token acts as you, in this workspace, and can never do more than your role allows. Give each app its own token so one can be revoked without the others."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)} disabled={save.isPending}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="mcp-token-form" icon={<Plus />} loading={save.isPending} disabled={!name.trim()}>
            Create token
          </Button>
        </>
      }
    >
      <form id="mcp-token-form" onSubmit={submit} className="flex flex-col gap-4" noValidate>
        {save.error && !save.error.isPlanLimit && !Object.keys(fields).length && <FormError error={save.error.message} />}
        <Field label="Name" required hint="Where you will use it, e.g. “Claude Code on my laptop”." error={fields.name}>
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoComplete="off" autoFocus />
        </Field>
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-xs font-medium text-text-2">What Claude may do</legend>
          <div role="radiogroup" aria-label="Access level" className="flex flex-col gap-2">
            {MCP_ACCESS_LEVELS.map((level) => (
              <button
                key={level}
                type="button"
                role="radio"
                aria-checked={access === level}
                onClick={() => setAccess(level)}
                className={cn(
                  "flex items-start gap-3 rounded-md border px-3 py-2.5 text-left transition-colors",
                  access === level ? "border-accent bg-accent/5" : "border-line hover:bg-ctl-hover",
                )}
              >
                <span
                  aria-hidden
                  className={cn("mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border", access === level ? "border-accent" : "border-line-strong")}
                >
                  {access === level && <span className="size-2 rounded-full bg-accent" />}
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-text-hi">{MCP_ACCESS_INFO[level].label}</span>
                  <span className="mt-0.5 block text-xs text-text-2">{MCP_ACCESS_INFO[level].description}</span>
                </span>
              </button>
            ))}
          </div>
          {fields.access && <p className="text-xs text-bad-ink">{fields.access}</p>}
        </fieldset>
        <Field label="Expires" hint="An expired token stops working; it stays listed until you revoke it." error={fields.expiresAt}>
          <NativeSelect value={expiry} onChange={(e) => setExpiry(e.target.value)} options={EXPIRY_OPTIONS} />
        </Field>
      </form>
    </Modal>
  );
}

/**
 * The full token, as returned by create, with the setup for each client.
 * The API keeps only a digest of it, so this is the one chance to copy it.
 */
export function McpTokenSecretModal({ token, onClose }: { token: McpTokenWithSecret | null; onClose: () => void }) {
  return (
    <Modal
      open={token !== null}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      size="lg"
      dismissOnOutside={false}
      title="Your MCP token"
      description={token ? `${token.name} · ${MCP_ACCESS_INFO[token.access].label}` : undefined}
      footer={
        <Button variant="primary" onClick={onClose}>
          I've saved it
        </Button>
      }
    >
      {token && (
        <div className="flex flex-col gap-4">
          <Callout tone="warn" title="You won't see this token again">
            Paste it into Claude now. Anyone holding it can act as you in this workspace — keep it out of repositories and shared chats. If it is lost, revoke it and create a new one.
          </Callout>
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium text-text-2">Token</span>
            <CopyValue value={token.secret} label="Copy token" copied="Token copied" />
          </div>
          <McpSetup url={token.url} token={token.secret} />
        </div>
      )}
    </Modal>
  );
}
