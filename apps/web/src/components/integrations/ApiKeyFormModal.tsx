"use client";

import { useState, type FormEvent } from "react";
import { Plus } from "lucide-react";
import { API_SCOPES, API_SCOPE_INFO, type ApiScope } from "@growthdesk/shared";
import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Checkbox";
import { Modal } from "@/components/ui/Dialog";
import { Field, FormError } from "@/components/ui/Field";
import { Input, NativeSelect } from "@/components/ui/Input";
import { useApiMutation } from "@/lib/query";
import { useWorkspace } from "@/lib/session";
import type { ApiKeyWithSecret } from "@/lib/types/api-keys";

const EXPIRY_OPTIONS = [
  { value: "", label: "Never" },
  { value: "30", label: "In 30 days" },
  { value: "90", label: "In 90 days" },
  { value: "365", label: "In 1 year" },
];

type Body = { name: string; scopes: ApiScope[]; expiresAt: string | null };

/**
 * Create an API key: a name, the scopes it holds, an optional expiry. The
 * response carries the full key — the only time the API reveals it — which
 * the caller shows through `onCreated`.
 */
export function ApiKeyFormModal({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (open: boolean) => void; onCreated: (key: ApiKeyWithSecret) => void }) {
  const ws = useWorkspace();
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<Set<ApiScope>>(() => new Set<ApiScope>(["leads:write"]));
  const [expiry, setExpiry] = useState("");

  const save = useApiMutation<ApiKeyWithSecret, Body>({
    path: ws.path("/api-keys"),
    invalidate: [ws.key("api-keys")],
    errorToast: false,
    onSuccess: (key) => {
      onOpenChange(false);
      onCreated(key);
    },
  });
  const fields = save.error?.fields ?? {};

  const toggle = (s: ApiScope, on: boolean) =>
    setScopes((prev) => {
      const next = new Set(prev);
      if (on) next.add(s);
      else next.delete(s);
      return next;
    });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate({
      name: name.trim(),
      scopes: API_SCOPES.filter((s) => scopes.has(s)),
      expiresAt: expiry ? new Date(Date.now() + Number(expiry) * 86_400_000).toISOString() : null,
    });
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
      title="Create an API key"
      description="Give each system its own key with only the scopes it needs, so one can be revoked without touching the others."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)} disabled={save.isPending}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="api-key-form" icon={<Plus />} loading={save.isPending} disabled={!name.trim() || scopes.size === 0}>
            Create key
          </Button>
        </>
      }
    >
      <form id="api-key-form" onSubmit={submit} className="flex flex-col gap-4" noValidate>
        {save.error && !save.error.isPlanLimit && !Object.keys(fields).length && <FormError error={save.error.message} />}
        <Field label="Name" required hint="What uses this key, e.g. “Business OS”." error={fields.name}>
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoComplete="off" autoFocus />
        </Field>
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-xs font-medium text-text-2">
            Scopes<span aria-hidden className="ml-0.5 text-bad">*</span>
          </legend>
          {API_SCOPES.map((s) => (
            <Checkbox
              key={s}
              checked={scopes.has(s)}
              onCheckedChange={(on) => toggle(s, on)}
              label={
                <>
                  {API_SCOPE_INFO[s].label} <code className="ml-1 font-mono text-xs text-text-3">{s}</code>
                </>
              }
              description={API_SCOPE_INFO[s].description}
            />
          ))}
          {(fields.scopes || Object.keys(fields).some((k) => k.startsWith("scopes."))) && <p className="text-xs text-bad-ink">{fields.scopes ?? "Choose at least one scope"}</p>}
        </fieldset>
        <Field label="Expires" hint="An expired key stops working; it stays listed until you revoke it." error={fields.expiresAt}>
          <NativeSelect value={expiry} onChange={(e) => setExpiry(e.target.value)} options={EXPIRY_OPTIONS} />
        </Field>
      </form>
    </Modal>
  );
}
