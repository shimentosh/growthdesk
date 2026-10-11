"use client";

import { useState, type FormEvent } from "react";
import { Pencil, TextCursorInput } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Card, CardBody, CardFooter, CardHeader } from "@/components/ui/Card";
import { Checkbox } from "@/components/ui/Checkbox";
import { Field, FormError } from "@/components/ui/Field";
import { Input, NativeSelect } from "@/components/ui/Input";
import { KeyValueList } from "@/components/ui/KeyValue";
import { formatDate, formatNumber } from "@/lib/format";
import { useApiQuery } from "@/lib/query";
import { useWorkspace } from "@/lib/session";
import type { ApiError } from "@/lib/api";
import type { CustomFieldDefinition, CustomFieldValue } from "@/lib/types/crm";

/** The workspace's custom field definitions for one entity (GET /custom-fields?entity=…). */
export function useCustomFields(entity: "contact" | "company") {
  const ws = useWorkspace();
  return useApiQuery<CustomFieldDefinition[]>(ws.key("custom-fields", entity), ws.path("/custom-fields"), { query: { entity }, staleTime: 60_000 });
}

function display(def: CustomFieldDefinition | undefined, v: CustomFieldValue | undefined) {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (def?.type === "number" && typeof v === "number") return formatNumber(v);
  // Date fields hold a calendar day ("2026-10-09"), not an instant: format it as written.
  if (def?.type === "date" && typeof v === "string") return formatDate(v, { timeZone: "UTC" });
  if (def?.type === "url" && typeof v === "string") {
    const href = /^https?:\/\//i.test(v) ? v : `https://${v}`;
    return (
      <a href={href} target="_blank" rel="noreferrer noopener" className="text-accent-hi hover:underline">
        {v}
      </a>
    );
  }
  return String(v);
}

type Draft = Record<string, string | boolean>;

const toDraft = (defs: CustomFieldDefinition[], values: Record<string, CustomFieldValue>): Draft =>
  Object.fromEntries(
    defs.map((d) => {
      const v = values[d.key];
      return [d.key, d.type === "boolean" ? v === true : v === null || v === undefined ? "" : String(v)];
    }),
  );

const fromDraft = (defs: CustomFieldDefinition[], draft: Draft): Record<string, CustomFieldValue> =>
  Object.fromEntries(
    defs.map((d) => {
      const v = draft[d.key];
      if (d.type === "boolean") return [d.key, v === true];
      const s = typeof v === "string" ? v.trim() : "";
      if (!s) return [d.key, null];
      if (d.type === "number") {
        const n = Number(s);
        return [d.key, Number.isFinite(n) ? n : s];
      }
      return [d.key, s];
    }),
  );

/**
 * A record's custom field values, labelled by the workspace's definitions.
 * Values whose definition was removed still show (read-only) under their key,
 * since the API keeps them. Hidden when there is nothing to show.
 */
export function CustomFieldsCard({
  entity,
  values,
  onSave,
  saving,
  error,
}: {
  entity: "contact" | "company";
  values: Record<string, CustomFieldValue>;
  /** Called with every defined field (blanks as null); the API merges them into the record. */
  onSave: (values: Record<string, CustomFieldValue>) => Promise<unknown>;
  saving?: boolean;
  error?: ApiError | null;
}) {
  const ws = useWorkspace();
  const defs = useCustomFields(entity);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Draft>({});

  const list = defs.data ?? [];
  const known = new Set(list.map((d) => d.key));
  const orphans = Object.entries(values ?? {}).filter(([k, v]) => !known.has(k) && v !== null && v !== "");
  if (!list.length && !orphans.length) return null;

  const canWrite = ws.can("contacts.write") && list.length > 0;
  const fields = error?.fields ?? {};

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await onSave(fromDraft(list, draft));
      setEditing(false);
    } catch {
      // The error shows inline below.
    }
  };

  return (
    <Card>
      <CardHeader
        icon={<TextCursorInput />}
        title="Custom fields"
        actions={
          canWrite && !editing ? (
            <Button
              size="sm"
              variant="ghost"
              icon={<Pencil />}
              onClick={() => {
                setDraft(toDraft(list, values ?? {}));
                setEditing(true);
              }}
            >
              Edit
            </Button>
          ) : undefined
        }
      />
      {editing ? (
        <form onSubmit={submit} noValidate>
          <CardBody className="flex flex-col gap-3">
            <FormError error={error && !Object.keys(fields).length ? error.message : null} />
            {list.map((d) => {
              const v = draft[d.key];
              const err = fields[`customFields.${d.key}`];
              if (d.type === "boolean") {
                return <Checkbox key={d.id} checked={v === true} onCheckedChange={(c) => setDraft({ ...draft, [d.key]: c })} label={d.label} />;
              }
              return (
                <Field key={d.id} label={d.label} error={err}>
                  {d.type === "select" ? (
                    <NativeSelect
                      value={typeof v === "string" ? v : ""}
                      onChange={(e) => setDraft({ ...draft, [d.key]: e.target.value })}
                      placeholder="—"
                      options={d.options.map((o) => ({ value: o, label: o }))}
                    />
                  ) : (
                    <Input
                      type={d.type === "number" ? "number" : d.type === "date" ? "date" : d.type === "url" ? "url" : "text"}
                      value={typeof v === "string" ? v : ""}
                      maxLength={2000}
                      onChange={(e) => setDraft({ ...draft, [d.key]: e.target.value })}
                    />
                  )}
                </Field>
              );
            })}
          </CardBody>
          <CardFooter>
            <Button size="sm" onClick={() => setEditing(false)}>
              Cancel
            </Button>
            <Button size="sm" variant="primary" type="submit" loading={saving}>
              Save fields
            </Button>
          </CardFooter>
        </form>
      ) : (
        <CardBody>
          <KeyValueList
            items={[
              ...list.map((d) => ({ label: d.label, value: display(d, values?.[d.key]) })),
              ...orphans.map(([k, v]) => ({ label: k, value: display(undefined, v), hint: "No longer defined" })),
            ]}
          />
        </CardBody>
      )}
    </Card>
  );
}
