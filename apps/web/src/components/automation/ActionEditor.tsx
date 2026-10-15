"use client";

import type { ReactNode } from "react";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { CONTACT_STATUSES, KIND_ACTIONS, PRIORITIES, QUALIFICATIONS, TASK_TYPES, WORKFLOW_ACTIONS, WORKSPACE_ROLES, labelOf, type WorkflowKind } from "@growthdesk/shared";
import { Button, IconButton } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Checkbox";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/DropdownMenu";
import { Field } from "@/components/ui/Field";
import { Input, NativeSelect, Textarea } from "@/components/ui/Input";
import { CampaignPicker, MemberPicker } from "@/components/pickers/Pickers";
import { ACTION_LABELS, type WorkflowAction, type WorkflowActionType } from "@/lib/types/automation";
import { useMarketingLists } from "@/components/marketing/common";
import { selectOptions, useContactCustomFields } from "./ConditionEditor";
import { DurationInput, MemberChecklist, TagListInput } from "./fields";
import { ActionGlyph, ActionTile } from "./glyphs";

/*
 * The ordered action list and one form per action type. Each form writes the
 * `config` that apps/api/src/automation/actions.ts ACTION_CONFIG accepts for
 * its type; the API re-validates on save and names the action and field when
 * something is off.
 */

type Config = Record<string, unknown>;
type FormProps = { config: Config; set: (patch: Config) => void; disabled?: boolean };

const str = (v: unknown) => (typeof v === "string" ? v : "");
const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const bool = (v: unknown) => v === true;

/** A fresh action's config: the API's defaults, spelled out so the form shows them. */
export function defaultConfig(type: WorkflowActionType): Config {
  switch (type) {
    case "assign_contact":
      return { strategy: "user", overwrite: false };
    case "update_contact":
      return { field: "status", value: "" };
    case "create_task":
      return { title: "", type: "follow_up", priority: "medium", assignTo: "owner" };
    case "notify":
      return { contactOwner: true, email: false };
    case "enroll_campaign":
      return { campaignId: "" };
    case "stop_campaigns":
      return {};
    case "add_tag":
      return { tags: [] };
    case "add_to_list":
    case "remove_from_list":
      return { listId: "" };
    case "hand_to_sales":
      return { createTask: true, taskTitle: "Follow up: handed over from marketing", dueInMinutes: 24 * 60 };
  }
}

function AssignForm({ config, set, disabled }: FormProps) {
  const strategy = str(config.strategy) || "user";
  return (
    <div className="flex flex-col gap-3">
      <Field label="Assign to">
        <NativeSelect
          value={strategy}
          disabled={disabled}
          onChange={(e) => set({ strategy: e.target.value })}
          options={[
            { value: "user", label: "A specific teammate" },
            { value: "round_robin", label: "Round-robin across teammates" },
          ]}
        />
      </Field>
      {strategy === "user" ? (
        <Field label="Teammate" required>
          <MemberPicker value={str(config.userId) || null} disabled={disabled} onChange={(id) => set({ userId: id ?? undefined })} clearable={false} />
        </Field>
      ) : (
        <Field label="Rotate between">
          <MemberChecklist
            value={strs(config.userIds)}
            onChange={(ids) => set({ userIds: ids.length ? ids : undefined })}
            emptyHint="Nobody ticked: rotates between every member who can own records (viewers are left out)."
          />
        </Field>
      )}
      <Checkbox checked={bool(config.overwrite)} disabled={disabled} onCheckedChange={(c) => set({ overwrite: c })} label="Re-assign contacts that already have an owner" />
    </div>
  );
}

const FIXED_FIELDS: Record<string, { label: string; values?: readonly string[] }> = {
  status: { label: "Status", values: CONTACT_STATUSES },
  qualification: { label: "Qualification", values: QUALIFICATIONS },
  priority: { label: "Priority", values: PRIORITIES },
  leadSource: { label: "Lead source" },
};

function UpdateContactForm({ config, set, disabled }: FormProps) {
  const custom = useContactCustomFields().data ?? [];
  const field = str(config.field) || "status";
  const fixed = FIXED_FIELDS[field];
  const def = field.startsWith("custom.") ? custom.find((d) => `custom.${d.key}` === field) : undefined;
  const values = fixed?.values ?? selectOptions(def);
  const value = str(config.value);
  const known = Boolean(fixed) || Boolean(def);
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label="Field">
        <NativeSelect value={field} disabled={disabled} onChange={(e) => set({ field: e.target.value, value: "" })}>
          {!known && <option value={field}>{field}</option>}
          <optgroup label="Contact">
            {Object.entries(FIXED_FIELDS).map(([k, f]) => (
              <option key={k} value={k}>
                {f.label}
              </option>
            ))}
          </optgroup>
          {custom.length > 0 && (
            <optgroup label="Custom fields">
              {custom.map((d) => (
                <option key={d.id} value={`custom.${d.key}`}>
                  {d.label}
                </option>
              ))}
            </optgroup>
          )}
        </NativeSelect>
      </Field>
      <Field label="Set it to" required={Boolean(fixed?.values)}>
        {values.length ? (
          <NativeSelect
            value={value}
            disabled={disabled}
            placeholder="Choose…"
            options={values.map((v) => ({ value: v, label: fixed?.values ? labelOf(v) : v }))}
            onChange={(e) => set({ value: e.target.value })}
          />
        ) : (
          <Input value={value} maxLength={500} disabled={disabled} onChange={(e) => set({ value: e.target.value })} placeholder="Leave empty to clear it" />
        )}
      </Field>
    </div>
  );
}

function CreateTaskForm({ config, set, disabled }: FormProps) {
  const assignTo = str(config.assignTo) || "owner";
  const due = typeof config.dueInMinutes === "number" ? config.dueInMinutes : undefined;
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label="Title" required className="sm:col-span-2">
        <Input value={str(config.title)} maxLength={300} disabled={disabled} onChange={(e) => set({ title: e.target.value })} placeholder="Follow up with the new lead" />
      </Field>
      <Field label="Description" className="sm:col-span-2">
        <Textarea rows={2} value={str(config.description)} maxLength={5000} disabled={disabled} onChange={(e) => set({ description: e.target.value || undefined })} />
      </Field>
      <Field label="Type">
        <NativeSelect
          value={str(config.type) || "follow_up"}
          disabled={disabled}
          options={TASK_TYPES.map((t) => ({ value: t, label: labelOf(t) }))}
          onChange={(e) => set({ type: e.target.value })}
        />
      </Field>
      <Field label="Priority">
        <NativeSelect
          value={str(config.priority) || "medium"}
          disabled={disabled}
          options={PRIORITIES.map((p) => ({ value: p, label: labelOf(p) }))}
          onChange={(e) => set({ priority: e.target.value })}
        />
      </Field>
      <Field label="Due" hint="After the task is created. Empty for no due date.">
        <DurationInput value={due} optional max={60 * 24 * 365} aria-label="Due in" onChange={(m) => set({ dueInMinutes: m })} />
      </Field>
      <Field label="Assign to">
        <NativeSelect
          value={assignTo === "owner" ? "owner" : "member"}
          disabled={disabled}
          options={[
            { value: "owner", label: "The record's owner" },
            { value: "member", label: "A specific teammate" },
          ]}
          onChange={(e) => set({ assignTo: e.target.value === "owner" ? "owner" : "" })}
        />
      </Field>
      {assignTo !== "owner" && (
        <Field label="Teammate" required className="sm:col-span-2">
          <MemberPicker value={assignTo || null} disabled={disabled} clearable={false} onChange={(id) => set({ assignTo: id ?? "" })} />
        </Field>
      )}
    </div>
  );
}

function NotifyForm({ config, set, disabled }: FormProps) {
  const roles = strs(config.roles);
  return (
    <div className="flex flex-col gap-3">
      <Checkbox checked={bool(config.contactOwner)} disabled={disabled} onCheckedChange={(c) => set({ contactOwner: c })} label="The contact's owner" />
      <Field label="Everyone with these roles">
        <div className="flex flex-wrap gap-x-4 gap-y-2">
          {WORKSPACE_ROLES.map((r) => (
            <Checkbox
              key={r}
              checked={roles.includes(r)}
              disabled={disabled}
              label={labelOf(r)}
              onCheckedChange={(on) => {
                const next = on ? [...roles, r] : roles.filter((x) => x !== r);
                set({ roles: next.length ? next : undefined });
              }}
            />
          ))}
        </div>
      </Field>
      <Field label="These teammates">
        <MemberChecklist value={strs(config.userIds)} onChange={(ids) => set({ userIds: ids.length ? ids : undefined })} />
      </Field>
      <Field label="Title" hint="Empty: the workflow's name and who it is about.">
        <Input value={str(config.title)} maxLength={200} disabled={disabled} onChange={(e) => set({ title: e.target.value || undefined })} />
      </Field>
      <Field label="Message">
        <Textarea rows={2} value={str(config.message)} maxLength={2000} disabled={disabled} onChange={(e) => set({ message: e.target.value || undefined })} />
      </Field>
      <Checkbox checked={bool(config.email)} disabled={disabled} onCheckedChange={(c) => set({ email: c })} label="Also send it by email" />
    </div>
  );
}

/** Campaigns a workflow can enroll into, now or once launched (completed and canceled ones never take anyone). */
const ENROLL_STATUSES = ["draft", "scheduled", "running", "paused"] as const;

function CampaignForm({ config, set, disabled, optional }: FormProps & { optional?: boolean }) {
  return (
    <Field
      label="Campaign"
      required={!optional}
      hint={
        optional
          ? "Empty: stop every active or paused campaign the contact is in."
          : "A running, paused or scheduled campaign takes new contacts. Launch a draft first, and turn on “Always on” in its settings so it stays open for leads that arrive later."
      }
    >
      <CampaignPicker
        value={str(config.campaignId) || null}
        statuses={optional ? undefined : ENROLL_STATUSES}
        disabled={disabled}
        placeholder={optional ? "Every campaign" : "Choose a campaign"}
        clearable={optional}
        onChange={(id) => set({ campaignId: id ?? (optional ? undefined : "") })}
      />
    </Field>
  );
}

function ListForm({ config, set, disabled, remove = false }: FormProps & { remove?: boolean }) {
  const lists = useMarketingLists();
  return (
    <Field
      label="List"
      required
      hint={
        remove
          ? "An unsubscribe from the list is kept, so they are not mailed again if someone adds them back."
          : "Someone who unsubscribed from the list, refused consent or is suppressed is not re-added. Only people with marketing consent receive its campaigns."
      }
    >
      <NativeSelect
        value={str(config.listId)}
        disabled={disabled || lists.isPending}
        placeholder={lists.isPending ? "Loading lists…" : "Choose a list"}
        onChange={(e) => set({ listId: e.target.value })}
        options={(lists.data ?? []).map((l) => ({ value: l.id, label: l.name }))}
      />
    </Field>
  );
}

function HandToSalesForm({ config, set, disabled }: FormProps) {
  const withTask = config.createTask !== false;
  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-text-3">Moves the contact to In sales (never back from Contact), marks a lead qualified and stops their outreach sequences.</p>
      <Checkbox checked={withTask} disabled={disabled} onCheckedChange={(c) => set({ createTask: c })} label="Give the owner a task" description="High priority, assigned to the contact's owner." />
      {withTask && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Task title" required>
            <Input value={str(config.taskTitle)} disabled={disabled} maxLength={300} onChange={(e) => set({ taskTitle: e.target.value })} />
          </Field>
          <Field label="Due in">
            <DurationInput value={typeof config.dueInMinutes === "number" ? config.dueInMinutes : 24 * 60} max={60 * 24 * 365} aria-label="Due in" onChange={(m) => set({ dueInMinutes: m ?? 0 })} />
          </Field>
        </div>
      )}
    </div>
  );
}

function TagForm({ config, set }: FormProps) {
  // A stored single `tag` is folded into the list the form edits.
  const tags = [...new Set([...(str(config.tag) ? [str(config.tag)] : []), ...strs(config.tags)])];
  return (
    <Field label="Tags" required hint="Tags that do not exist yet are created.">
      <TagListInput value={tags} onChange={(next) => set({ tag: undefined, tags: next })} />
    </Field>
  );
}

function ConfigForm({ action, set, disabled }: { action: WorkflowAction; set: (patch: Config) => void; disabled?: boolean }) {
  const props = { config: action.config, set, disabled };
  switch (action.type) {
    case "assign_contact":
      return <AssignForm {...props} />;
    case "update_contact":
      return <UpdateContactForm {...props} />;
    case "create_task":
      return <CreateTaskForm {...props} />;
    case "notify":
      return <NotifyForm {...props} />;
    case "enroll_campaign":
      return <CampaignForm {...props} />;
    case "stop_campaigns":
      return <CampaignForm {...props} optional />;
    case "add_tag":
      return <TagForm {...props} />;
    case "add_to_list":
      return <ListForm {...props} />;
    case "remove_from_list":
      return <ListForm {...props} remove />;
    case "hand_to_sales":
      return <HandToSalesForm {...props} />;
  }
}

function ActionCard({
  index,
  count,
  action,
  onChange,
  onMove,
  onRemove,
  disabled,
}: {
  index: number;
  count: number;
  action: WorkflowAction;
  onChange: (a: WorkflowAction) => void;
  onMove: (to: number) => void;
  onRemove: () => void;
  disabled?: boolean;
}) {
  const meta = ACTION_LABELS[action.type];
  const set = (patch: Config) => {
    const config = { ...action.config, ...patch };
    for (const k of Object.keys(config)) if (config[k] === undefined) delete config[k];
    onChange({ ...action, config });
  };
  return (
    <li className="rounded-md border border-line bg-panel">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <ActionTile type={action.type} size="md" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-text-hi">
            <span className="mr-1.5 font-normal text-text-3 tabular-nums">{index + 1}.</span>
            {meta.label}
          </div>
          <div className="truncate text-xs text-text-3">{meta.description}</div>
        </div>
        {!disabled && (
          <div className="flex shrink-0 items-center">
            <IconButton size="sm" label="Move up" icon={<ArrowUp />} disabled={index === 0} onClick={() => onMove(index - 1)} />
            <IconButton size="sm" label="Move down" icon={<ArrowDown />} disabled={index === count - 1} onClick={() => onMove(index + 1)} />
            <IconButton size="sm" variant="danger" label="Remove action" icon={<Trash2 />} onClick={onRemove} />
          </div>
        )}
      </div>
      <div className="flex flex-col gap-3 p-3">
        <Field label="Wait first" hint={index === 0 ? "Time after the trigger before this runs." : "Time after the previous action before this runs."}>
          <DurationInput value={action.delayMinutes} max={60 * 24 * 30} aria-label="Wait" onChange={(m) => onChange({ ...action, delayMinutes: m ?? 0 })} />
        </Field>
        <ConfigForm action={action} set={set} disabled={disabled} />
      </div>
    </li>
  );
}

/** "Then do this": actions run in order, each after its own wait. */
export function ActionList({ value, onChange, disabled, kind }: { value: WorkflowAction[]; onChange: (a: WorkflowAction[]) => void; disabled?: boolean; kind?: WorkflowKind }) {
  // Each kind offers its own actions first; the menu never hides one the workflow already uses.
  const offered = kind ? KIND_ACTIONS[kind] : WORKFLOW_ACTIONS;
  const add = (type: WorkflowActionType) => onChange([...value, { type, delayMinutes: 0, config: defaultConfig(type) }]);
  const move = (from: number, to: number) => {
    const next = [...value];
    const [item] = next.splice(from, 1);
    if (item) next.splice(to, 0, item);
    onChange(next);
  };
  const menu: ReactNode = !disabled && value.length < 20 && (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant={value.length ? "ghost" : "secondary"} icon={<Plus />} className="self-start">
          Add action
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72">
        {offered.map((t) => (
          <DropdownMenuItem key={t} icon={<ActionGlyph type={t} className="mt-0.5" />} onSelect={() => add(t)} className="!h-auto !items-start py-1.5">
            <span className="flex flex-col">
              <span>{ACTION_LABELS[t].label}</span>
              <span className="text-xs whitespace-normal text-text-3">{ACTION_LABELS[t].description}</span>
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
  return (
    <div className="flex flex-col gap-2">
      {value.length === 0 ? (
        <p className="text-xs text-text-3">A workflow needs at least one action.</p>
      ) : (
        <ol className="flex flex-col gap-2">
          {value.map((a, i) => (
            <ActionCard
              key={i}
              index={i}
              count={value.length}
              action={a}
              disabled={disabled}
              onChange={(next) => onChange(value.map((x, j) => (j === i ? next : x)))}
              onMove={(to) => move(i, to)}
              onRemove={() => onChange(value.filter((_, j) => j !== i))}
            />
          ))}
        </ol>
      )}
      {menu}
    </div>
  );
}
