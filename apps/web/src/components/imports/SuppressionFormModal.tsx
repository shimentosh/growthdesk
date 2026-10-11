"use client";

import { useState, type FormEvent } from "react";
import { labelOf, SUPPRESSION_KINDS, SUPPRESSION_SCOPES, type SuppressionKind, type SuppressionScope } from "@growthdesk/shared";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Dialog";
import { Field, FormError } from "@/components/ui/Field";
import { Input, NativeSelect } from "@/components/ui/Input";
import { cn } from "@/lib/cn";
import { useApiMutation } from "@/lib/query";
import { useWorkspace } from "@/lib/session";
import { SCOPE_LABELS, SUPPRESSION_REASONS, type SuppressionReason, type SuppressionRow } from "@/lib/types/crm-settings";

const KIND_COPY: Record<SuppressionKind, { label: string; placeholder: string; hint: string; type: string }> = {
  email: { label: "Email address", placeholder: "name@example.com", hint: "That one address is never contacted.", type: "email" },
  domain: { label: "Domain", placeholder: "example.com", hint: "Every address at this domain is blocked. A pasted URL is reduced to its domain.", type: "text" },
  phone: { label: "Phone number", placeholder: "+44 20 7946 0958", hint: "Include the country code (+…) so it matches how numbers are stored.", type: "tel" },
};

const SCOPE_HINTS: Record<SuppressionScope, string> = {
  all: "Blocks outreach, marketing emails, messages and calls.",
  outreach: "Blocks campaigns, sequences, inbox replies, messages and calls. Marketing emails can still go out with consent.",
  marketing: "Blocks marketing emails only. Sales outreach and replies are unaffected.",
};

type Body = { kind: SuppressionKind; value: string; reason: SuppressionReason; scope: SuppressionScope };

/** Add an email, domain or phone number to the do-not-contact list. */
export function SuppressionFormModal({ onClose }: { onClose: () => void }) {
  const ws = useWorkspace();
  const [kind, setKind] = useState<SuppressionKind>("email");
  const [value, setValue] = useState("");
  const [reason, setReason] = useState<SuppressionReason>("manual");
  const [scope, setScope] = useState<SuppressionScope>("all");

  const add = useApiMutation<SuppressionRow, Body>({
    path: ws.path("/suppressions"),
    invalidate: [ws.key("suppressions")],
    success: (row) => `${row.value} is on the suppression list`,
    errorToast: false,
    onSuccess: onClose,
  });

  const fields = add.error?.fields ?? {};
  // An unreadable value answers 400 "That is not a valid …" without a field.
  const valueError = fields.value ?? (add.error?.status === 400 && !Object.keys(fields).length ? add.error.message : undefined);
  const formError = add.isError && !valueError && !fields.kind && !fields.reason && !fields.scope ? add.error.message : undefined;
  const copy = KIND_COPY[kind];

  const submit = (e: FormEvent) => {
    e.preventDefault();
    add.mutate({ kind, value: value.trim(), reason, scope });
  };

  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      size="sm"
      title="Add to suppression list"
      footer={
        <>
          <Button onClick={onClose} disabled={add.isPending}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="suppression-form" loading={add.isPending} disabled={!value.trim()}>
            Add
          </Button>
        </>
      }
    >
      <form id="suppression-form" onSubmit={submit} className="flex flex-col gap-4">
        <Field label="Block by" error={fields.kind}>
          <div role="radiogroup" aria-label="Block by" className="inline-flex w-full rounded-sm border border-line-strong bg-well p-0.5">
            {SUPPRESSION_KINDS.map((k) => (
              <button
                key={k}
                type="button"
                role="radio"
                aria-checked={kind === k}
                onClick={() => {
                  setKind(k);
                  add.reset();
                }}
                className={cn(
                  "h-7 flex-1 rounded-xs text-sm font-medium transition-colors",
                  kind === k ? "bg-ctl-face text-text-hi shadow-sm" : "text-text-3 hover:text-text",
                )}
              >
                {labelOf(k)}
              </button>
            ))}
          </div>
        </Field>
        <Field label={copy.label} required hint={copy.hint} error={valueError}>
          <Input type={copy.type} value={value} onChange={(e) => setValue(e.target.value)} maxLength={254} placeholder={copy.placeholder} autoFocus autoComplete="off" />
        </Field>
        <Field label="Reason" error={fields.reason}>
          <NativeSelect value={reason} onChange={(e) => setReason(e.target.value as SuppressionReason)} options={SUPPRESSION_REASONS.map((r) => ({ value: r, label: labelOf(r) }))} />
        </Field>
        <Field label="Stops" hint={SCOPE_HINTS[scope]} error={fields.scope}>
          <NativeSelect value={scope} onChange={(e) => setScope(e.target.value as SuppressionScope)} options={SUPPRESSION_SCOPES.map((s) => ({ value: s, label: SCOPE_LABELS[s] }))} />
        </Field>
        <FormError error={formError} />
      </form>
    </Modal>
  );
}
