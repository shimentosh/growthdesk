"use client";

import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Dialog";
import { Field, FormError } from "@/components/ui/Field";
import { Input, NativeSelect, Textarea } from "@/components/ui/Input";
import { KeyValueList } from "@/components/ui/KeyValue";
import { useApiMutation } from "@/lib/query";
import { useWorkspace } from "@/lib/session";
import type { CustomFieldDefinition, CustomFieldEntity, CustomFieldType } from "@/lib/types/crm-settings";

export const FIELD_ENTITIES: { value: CustomFieldEntity; label: string; plural: string }[] = [
  { value: "contact", label: "Contact", plural: "Contacts" },
  { value: "company", label: "Company", plural: "Companies" },
  { value: "deal", label: "Deal", plural: "Deals" },
];

export const FIELD_TYPES: { value: CustomFieldType; label: string }[] = [
  { value: "text", label: "Text" },
  { value: "number", label: "Number" },
  { value: "date", label: "Date" },
  { value: "boolean", label: "Yes / no" },
  { value: "select", label: "Dropdown" },
  { value: "url", label: "Link (URL)" },
];

export const fieldTypeLabel = (t: string) => FIELD_TYPES.find((x) => x.value === t)?.label ?? t;

const KEY_RE = /^[a-z][a-z0-9_]{0,39}$/;

/** "Contract value (€)" → "contract_value" — a key that satisfies CustomFieldInput's pattern. */
function keyFrom(label: string): string {
  const k = label
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^[^a-z]+/, "")
    .replace(/_+$/, "")
    .slice(0, 40)
    .replace(/_+$/, "");
  return k;
}

const parseOptions = (text: string) => [...new Set(text.split("\n").map((o) => o.trim()).filter(Boolean))];

type CreateBody = { entity: CustomFieldEntity; key: string; label: string; type: CustomFieldType; options: string[] };
type UpdateBody = { label: string; options?: string[] };

/**
 * Create a field, or edit one (`field` given). Only the label and a
 * dropdown's options can change afterwards — the key is what records store
 * values under. Mount it when opening so it starts fresh.
 */
export function CustomFieldFormModal({
  field,
  defaultEntity,
  onClose,
}: {
  field: CustomFieldDefinition | null;
  defaultEntity: CustomFieldEntity;
  onClose: () => void;
}) {
  const ws = useWorkspace();
  const [entity, setEntity] = useState<CustomFieldEntity>(field?.entity ?? defaultEntity);
  const [label, setLabel] = useState(field?.label ?? "");
  const [key, setKey] = useState(field?.key ?? "");
  const [keyTouched, setKeyTouched] = useState(Boolean(field));
  const [type, setType] = useState<CustomFieldType>(field?.type ?? "text");
  const [optionsText, setOptionsText] = useState((field?.options ?? []).join("\n"));

  const create = useApiMutation<CustomFieldDefinition, CreateBody>({
    path: ws.path("/custom-fields"),
    invalidate: [ws.key("custom-fields")],
    success: "Field created",
    errorToast: false,
    onSuccess: onClose,
  });
  const update = useApiMutation<{ updated: true }, UpdateBody>({
    method: "PATCH",
    path: ws.path(`/custom-fields/${field?.id ?? ""}`),
    invalidate: [ws.key("custom-fields")],
    success: "Field saved",
    errorToast: false,
    onSuccess: onClose,
  });
  const save = field ? update : create;

  const effectiveKey = keyTouched ? key : keyFrom(label);
  const options = parseOptions(optionsText);
  const isSelect = type === "select";

  const fields = save.error?.fields ?? {};
  const optionsServerError = fields.options ?? Object.entries(fields).find(([k]) => k.startsWith("options."))?.[1];
  const localKeyError = !field && effectiveKey && !KEY_RE.test(effectiveKey) ? "Start with a letter; use lower-case letters, digits and _ (up to 40)." : undefined;
  // A clashing key answers 409 without a field; it belongs under the key.
  const keyError = localKeyError ?? fields.key ?? (save.error?.status === 409 ? save.error.message : undefined);
  const localOptionsError = isSelect && options.length > 100 ? "Up to 100 options." : isSelect && options.some((o) => o.length > 80) ? "Each option can be up to 80 characters." : undefined;
  const optionsError = localOptionsError ?? optionsServerError;
  const shown = Boolean(fields.label || keyError || optionsError || fields.type || fields.entity);
  const formError = save.isError && !shown ? save.error.message : undefined;

  const invalid = !label.trim() || (!field && (!effectiveKey || Boolean(localKeyError))) || (isSelect && options.length === 0) || Boolean(localOptionsError);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (invalid) return;
    if (field) update.mutate({ label: label.trim(), ...(isSelect ? { options } : {}) });
    else create.mutate({ entity, key: effectiveKey, label: label.trim(), type, options: isSelect ? options : [] });
  };

  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={field ? "Edit field" : "New custom field"}
      dismissOnOutside={false}
      footer={
        <>
          <Button onClick={onClose} disabled={save.isPending}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="custom-field-form" loading={save.isPending} disabled={invalid}>
            {field ? "Save" : "Create field"}
          </Button>
        </>
      }
    >
      <form id="custom-field-form" onSubmit={submit} className="flex flex-col gap-4">
        {field ? (
          <div className="rounded-md border border-line bg-s-1 px-3 py-2.5">
            <KeyValueList
              items={[
                { label: "Record type", value: FIELD_ENTITIES.find((x) => x.value === field.entity)?.label ?? field.entity },
                { label: "Key", value: <code className="font-mono text-xs">{field.key}</code> },
                { label: "Type", value: fieldTypeLabel(field.type) },
              ]}
            />
            <p className="mt-2 text-xs text-text-3">The record type, key and type are fixed once a field exists.</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Record type" error={fields.entity}>
              <NativeSelect value={entity} onChange={(e) => setEntity(e.target.value as CustomFieldEntity)} options={FIELD_ENTITIES.map((x) => ({ value: x.value, label: x.label }))} />
            </Field>
            <Field label="Type" error={fields.type}>
              <NativeSelect value={type} onChange={(e) => setType(e.target.value as CustomFieldType)} options={FIELD_TYPES} />
            </Field>
          </div>
        )}

        <Field label="Label" required error={fields.label} hint="What people see on forms and in lists.">
          <Input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={80} autoFocus placeholder="e.g. Contract value" />
        </Field>

        {!field && (
          <Field
            label="Key"
            required
            error={keyError}
            hint={
              entity === "contact"
                ? `Stored on each record under this name, and written {{custom.${effectiveKey || "key"}}} in message templates. It cannot be changed later.`
                : "Stored on each record under this name. It cannot be changed later."
            }
          >
            <Input
              value={effectiveKey}
              onChange={(e) => {
                setKeyTouched(true);
                setKey(e.target.value.toLowerCase());
              }}
              maxLength={40}
              className="font-mono"
              autoComplete="off"
              spellCheck={false}
            />
          </Field>
        )}

        {isSelect && (
          <Field label="Options" required error={optionsError} hint={`One per line. ${options.length}/100`}>
            <Textarea value={optionsText} onChange={(e) => setOptionsText(e.target.value)} rows={5} placeholder={"Small\nMedium\nLarge"} />
          </Field>
        )}

        <FormError error={formError} />
      </form>
    </Modal>
  );
}
