"use client";

import { Plus, Trash2 } from "lucide-react";
import { CONTACT_STATUSES, DEAL_STATUSES, PRIORITIES, QUALIFICATIONS, labelOf } from "@growthdesk/shared";
import { Button, IconButton } from "@/components/ui/Button";
import { Input, NativeSelect } from "@/components/ui/Input";
import { useApiQuery } from "@/lib/query";
import { useWorkspace } from "@/lib/session";
import { CONDITION_FIELDS, CONDITION_KEY, OP_LABELS, type ConditionOp, type WorkflowCondition } from "@/lib/types/automation";

/** A contact custom field, as GET /custom-fields?entity=contact lists it (only the parts the builder reads). */
export type CustomFieldDef = { id: string; entity: string; key: string; label: string; type: string; options: unknown };

export function useContactCustomFields() {
  const ws = useWorkspace();
  return useApiQuery<CustomFieldDef[]>(ws.key("custom-fields", "contact"), ws.can("contacts.read") ? ws.path("/custom-fields") : null, {
    query: { entity: "contact" },
    staleTime: 60_000,
  });
}

export const selectOptions = (def: CustomFieldDef | undefined): string[] =>
  def && def.type === "select" && Array.isArray(def.options) ? def.options.filter((o): o is string => typeof o === "string") : [];

/** Enum values a field can take, when it has a fixed list. */
const ENUM_VALUES: Record<string, readonly string[]> = {
  "contact.status": CONTACT_STATUSES,
  "contact.qualification": QUALIFICATIONS,
  "contact.priority": PRIORITIES,
  "deal.status": DEAL_STATUSES,
};

const EVENT = "__event";
const OPS = Object.keys(OP_LABELS) as ConditionOp[];

function ConditionRow({
  condition,
  onChange,
  onRemove,
  customFields,
  disabled,
}: {
  condition: WorkflowCondition;
  onChange: (c: WorkflowCondition) => void;
  onRemove: () => void;
  customFields: CustomFieldDef[];
  disabled?: boolean;
}) {
  const isEvent = condition.field.startsWith("event.");
  const known = CONDITION_FIELDS.some((f) => f.value === condition.field) || customFields.some((d) => `contact.custom.${d.key}` === condition.field);
  const selectValue = isEvent ? EVENT : condition.field;
  const eventKey = isEvent ? condition.field.slice("event.".length) : "";
  const custom = customFields.find((d) => `contact.custom.${d.key}` === condition.field);
  const choices = ENUM_VALUES[condition.field] ?? (custom ? selectOptions(custom) : []);
  const badKey = isEvent && eventKey !== "" && !CONDITION_KEY.test(eventKey);

  return (
    <li className="flex flex-col gap-2 rounded-md border border-line p-2.5 sm:flex-row sm:items-start">
      <div className="flex min-w-0 flex-1 flex-col gap-2 sm:flex-row">
        <div className="flex min-w-0 flex-col gap-1.5 sm:w-56">
          <NativeSelect
            aria-label="Field"
            value={selectValue}
            disabled={disabled}
            onChange={(e) => {
              const v = e.target.value;
              onChange({ ...condition, field: v === EVENT ? "event." : v, value: "" });
            }}
          >
            {!known && !isEvent && <option value={condition.field}>{condition.field || "Choose a field…"}</option>}
            <optgroup label="Contact & deal">
              {CONDITION_FIELDS.map((f) => (
                <option key={f.value} value={f.value}>
                  {f.label}
                </option>
              ))}
            </optgroup>
            {customFields.length > 0 && (
              <optgroup label="Contact custom fields">
                {customFields.map((d) => (
                  <option key={d.id} value={`contact.custom.${d.key}`}>
                    {d.label}
                  </option>
                ))}
              </optgroup>
            )}
            <optgroup label="Other">
              <option value={EVENT}>Event property…</option>
            </optgroup>
          </NativeSelect>
          {isEvent && (
            <Input
              aria-label="Event property name"
              placeholder="property name"
              className="font-mono"
              invalid={badKey}
              value={eventKey}
              disabled={disabled}
              onChange={(e) => onChange({ ...condition, field: `event.${e.target.value.trim()}` })}
            />
          )}
          {badKey && <p className="text-xs text-bad-ink">Letters, digits and underscores only.</p>}
        </div>
        <NativeSelect
          aria-label="Comparison"
          className="sm:w-40"
          value={condition.op}
          disabled={disabled}
          options={OPS.map((op) => ({ value: op, label: OP_LABELS[op] }))}
          onChange={(e) => {
            const op = e.target.value as ConditionOp;
            onChange({ ...condition, op, value: op === "exists" ? "" : condition.value });
          }}
        />
        {condition.op !== "exists" &&
          (choices.length && (condition.op === "is" || condition.op === "is_not") ? (
            <NativeSelect
              aria-label="Value"
              className="min-w-0 flex-1"
              value={condition.value}
              disabled={disabled}
              placeholder="Choose…"
              options={[
                ...choices.map((c) => ({ value: c, label: ENUM_VALUES[condition.field] ? labelOf(c) : c })),
                ...(condition.value && !choices.includes(condition.value) ? [{ value: condition.value, label: condition.value }] : []),
              ]}
              onChange={(e) => onChange({ ...condition, value: e.target.value })}
            />
          ) : (
            <Input
              aria-label="Value"
              className="min-w-0 flex-1"
              inputMode={condition.op === "gt" || condition.op === "lt" ? "decimal" : undefined}
              placeholder={condition.op === "gt" || condition.op === "lt" ? "A number" : "Value"}
              maxLength={200}
              value={condition.value}
              disabled={disabled}
              onChange={(e) => onChange({ ...condition, value: e.target.value })}
            />
          ))}
      </div>
      {!disabled && <IconButton label="Remove condition" icon={<Trash2 />} onClick={onRemove} />}
    </li>
  );
}

/**
 * "Only continue when…": every row must hold (AND). Matching ignores case.
 * A field the run's subject does not have (no deal on a contact event) reads
 * as empty.
 */
export function ConditionEditor({ value, onChange, disabled }: { value: WorkflowCondition[]; onChange: (c: WorkflowCondition[]) => void; disabled?: boolean }) {
  const fields = useContactCustomFields();
  const customFields = fields.data ?? [];
  return (
    <div className="flex flex-col gap-2">
      {value.length === 0 ? (
        <p className="text-xs text-text-3">No conditions: the workflow runs every time the trigger fires.</p>
      ) : (
        <ol className="flex flex-col gap-2">
          {value.map((c, i) => (
            <ConditionRow
              key={i}
              condition={c}
              customFields={customFields}
              disabled={disabled}
              onChange={(next) => onChange(value.map((x, j) => (j === i ? next : x)))}
              onRemove={() => onChange(value.filter((_, j) => j !== i))}
            />
          ))}
        </ol>
      )}
      {!disabled && value.length < 20 && (
        <Button size="sm" variant="ghost" icon={<Plus />} className="self-start" onClick={() => onChange([...value, { field: "contact.status", op: "is", value: "" }])}>
          Add condition
        </Button>
      )}
    </div>
  );
}
