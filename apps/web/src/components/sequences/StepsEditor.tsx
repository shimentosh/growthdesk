"use client";

import { useRef, useState, type ReactNode, type Ref } from "react";
import {
  ArrowDown,
  ArrowUp,
  AudioLines,
  Bell,
  CheckSquare,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Flag,
  GitBranch,
  Hourglass,
  ListOrdered,
  PenLine,
  PhoneCall,
  Plus,
  Trash2,
  UserRoundPlus,
  type LucideIcon,
} from "lucide-react";
import {
  CALL_OUTCOMES,
  CONTACT_STATUSES,
  FEATURE_LABELS,
  PRIORITIES,
  QUALIFICATIONS,
  RULE_FIELDS,
  RULE_OPS,
  STEP_TYPES,
  TASK_TYPES,
  flowTrouble,
  labelOf,
  toFlow,
  type RuleOp,
  type StepType,
} from "@growthdesk/shared";
import { AiWriteButton } from "@/components/ai/AiWriteDialog";
import { Badge } from "@/components/ui/Badge";
import { Button, IconButton } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { EmptyState } from "@/components/ui/EmptyState";
import { IconTile, type Tint } from "@/components/ui/IconTile";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/DropdownMenu";
import { Field } from "@/components/ui/Field";
import { Input, NativeSelect, Textarea } from "@/components/ui/Input";
import { Select, type SelectOption } from "@/components/ui/Select";
import { MemberPicker } from "@/components/pickers/Pickers";
import { selectOptions, useContactCustomFields, type CustomFieldDef } from "@/components/automation/ConditionEditor";
import { AiAgentSelect } from "@/components/calls/AiAgentSelect";
import { useAiAgents } from "@/components/calls/callHooks";
import { DurationInput } from "@/components/automation/fields";
import { CHANNEL_ICON } from "@/components/templates/channel";
import { VariableMenu, focusAt, spliceToken } from "@/components/templates/VariableMenu";
import { cn } from "@/lib/cn";
import { useApiQuery } from "@/lib/query";
import { useWorkspace } from "@/lib/session";
import type { Paged } from "@/lib/types";
import type { AiAgent } from "@/lib/types/ai-calling";
import type { Template } from "@/lib/types/templates";
import {
  STEP_META,
  stepFeatures,
  type AssignStrategy,
  type SequenceStep,
  type StepConfig,
  type StepRule,
  type StepsEditorProps,
} from "@/lib/types/sequences";

/*
 * The ordered steps of a sequence (or a campaign's own copy of one). A
 * controlled component: `steps` in, `onChange(steps)` out, nothing fetched
 * about the sequence itself, so the sequence builder and the campaign editor
 * can both use it.
 *
 * Each form writes the config apps/api/src/campaigns/engine.service.ts reads
 * for its type; step-rules.service.ts re-checks everything on save and its
 * 400 answer comes back through `errors`, keyed `steps.<i>.config.<key>`.
 *
 * Branches follow packages/shared/src/flow.ts: the list stays flat, and a
 * branch owns the `thenLength` steps after it (the "yes" path), then the
 * `elseLength` steps after those (the "no" path); both rejoin the main path
 * after the "no" path.
 */

const MAX_STEPS = 50;
const MAX_RULES = 20;
const DAY = 1440;

type SetConfig = (patch: StepConfig) => void;
type FormProps = { config: StepConfig; set: SetConfig; err: (key: string) => string | undefined };

const str = (v: unknown) => (typeof v === "string" ? v : "");
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** A fresh step's config. */
export function defaultStepConfig(type: StepType): StepConfig {
  switch (type) {
    case "email":
      return { subject: "", body: "" };
    case "wait":
      return { delayMinutes: 2 * DAY };
    case "branch":
      return { logic: { match: "all", rules: [{ field: "replied", op: "is", value: "yes" }] }, thenLength: 0, elseLength: 0 };
    case "call_task":
      return { taskTitle: "" };
    case "ai_call":
      return { agentId: "" };
    case "create_task":
      return { taskTitle: "", taskType: "follow_up" };
    case "whatsapp":
    case "telegram":
      return { body: "" };
    case "update_field":
      return { field: "status", value: "" };
    case "assign_owner":
      return { strategy: "round_robin" };
    case "notify":
      return { message: "" };
    case "end":
      return {};
  }
}

/** One glyph and one colour per step type; message steps match their channel's (components/templates/channel). */
export const STEP_ICON: Record<StepType, { icon: LucideIcon; tint: Tint }> = {
  email: CHANNEL_ICON.email,
  whatsapp: CHANNEL_ICON.whatsapp,
  telegram: CHANNEL_ICON.telegram,
  wait: { icon: Hourglass, tint: "gray" },
  branch: { icon: GitBranch, tint: "purple" },
  call_task: { icon: PhoneCall, tint: "teal" },
  ai_call: { icon: AudioLines, tint: "cyan" },
  create_task: { icon: CheckSquare, tint: "orange" },
  update_field: { icon: PenLine, tint: "indigo" },
  assign_owner: { icon: UserRoundPlus, tint: "brown" },
  notify: { icon: Bell, tint: "pink" },
  end: { icon: Flag, tint: "red" },
};

/** The step type's coloured tile (step cards, the add-step menu, a campaign's "By step" table). */
export function StepTile({ type, size = "sm", className }: { type: StepType; size?: "sm" | "md"; className?: string }) {
  const { icon: Icon, tint } = STEP_ICON[type] ?? STEP_ICON.end;
  return <IconTile icon={<Icon />} tint={tint} size={size} className={className} />;
}

/** "2 days", "3 hours", "90 minutes". */
export function formatMinutes(m: number): string {
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
  if (m > 0 && m % DAY === 0) return plural(m / DAY, "day");
  if (m > 0 && m % 60 === 0) return plural(m / 60, "hour");
  return plural(m, "minute");
}

const STRATEGY_LABELS: Record<AssignStrategy, string> = {
  round_robin: "Round-robin",
  user: "A specific teammate",
  campaign_owner: "The campaign's owner",
};

const RULE_FIELD_LABELS: Record<(typeof RULE_FIELDS)[number], string> = {
  replied: "Replied",
  opened: "Opened an email",
  clicked: "Clicked a link",
  has_phone: "Has a phone number",
  has_email: "Has an email address",
  status: "Status",
  qualification: "Qualification",
  priority: "Priority",
  job_title: "Job title",
  company: "Company",
  country: "Country",
  tag: "Tag",
  call_outcome: "AI call outcome",
};

const OP_LABELS: Record<RuleOp, string> = { is: "is", is_not: "is not", contains: "contains", gt: "is more than", lt: "is less than" };

/** Facts the engine answers with "yes" / "no" (engine.service.ts `facts()`). */
const YES_NO = new Set(["replied", "opened", "clicked", "has_phone", "has_email"]);
const RULE_ENUMS: Record<string, readonly string[]> = { status: CONTACT_STATUSES, qualification: QUALIFICATIONS, priority: PRIORITIES };
/**
 * Facts only a branch reads (never set by an update step). call_outcome is the
 * enrollment's latest AI call: its outcome, "pending" until it is judged,
 * "failed" when it never connected (engine.service.ts `lastAiCallOutcome`).
 */
const BRANCH_ENUMS: Record<string, readonly string[]> = { call_outcome: [...CALL_OUTCOMES, "pending", "failed"] };
const BRANCH_VALUE_LABELS: Record<string, string> = { pending: "Pending (not judged yet)", failed: "Failed (never connected)" };
const ruleEnum = (field: string): readonly string[] | undefined => RULE_ENUMS[field] ?? BRANCH_ENUMS[field];
const ruleValueLabel = (field: string, value: string) => (YES_NO.has(field) || ruleEnum(field) ? (BRANCH_VALUE_LABELS[value] ?? labelOf(value)) : value);

/** The agent names stepSummary may show ("AI call by Ava"). */
type AgentNames = readonly { id: string; name: string }[];

/** One line saying what a step will do. Pass the AI agents to name the one an AI call step uses. */
export function stepSummary(step: SequenceStep, agents?: AgentNames): string {
  const c = step.config ?? {};
  switch (step.type) {
    case "email":
      return str(c.subject).trim() || (c.templateId ? "From a template" : "No subject: replies in the first email's thread");
    case "wait":
      return `Wait ${formatMinutes(num(c.delayMinutes))}`;
    case "branch": {
      const rules = c.logic?.rules ?? [];
      if (!rules.length) return "No rules: every contact takes the yes path";
      const first = rules[0]!;
      const one = `${first.field.startsWith("custom.") ? first.field.slice(7) : (RULE_FIELD_LABELS[first.field as keyof typeof RULE_FIELD_LABELS] ?? first.field)} ${OP_LABELS[first.op] ?? first.op} ${first.value ? ruleValueLabel(first.field, first.value) : "(blank)"}`;
      return rules.length === 1 ? `If ${one}` : `If ${one} ${c.logic?.match === "any" ? "or" : "and"} ${rules.length - 1} more`;
    }
    case "call_task":
      return str(c.taskTitle).trim() || "Call {{full_name}}";
    case "ai_call": {
      if (!c.agentId) return "No agent chosen";
      const agent = agents?.find((a) => a.id === c.agentId);
      return agent ? `AI call by ${agent.name}` : "AI call";
    }
    case "create_task":
      return str(c.taskTitle).trim() || "Follow up with {{full_name}}";
    case "whatsapp":
    case "telegram":
      return str(c.body).trim().slice(0, 80) || (c.templateId ? "From a template" : "No message yet");
    case "update_field":
      return c.field
        ? `Set ${c.field.startsWith("custom.") ? c.field.slice(7) : labelOf(c.field)} to ${c.value ? (RULE_ENUMS[c.field] ? labelOf(String(c.value)) : String(c.value)) : "(blank)"}`
        : "No field chosen";
    case "assign_owner":
      return STRATEGY_LABELS[c.strategy ?? (c.userId ? "user" : "round_robin")];
    case "notify":
      return str(c.message).trim() || "{{full_name}} reached a step in a campaign";
    case "end":
      return "The contact finishes the sequence here";
  }
}

/** Mirrors campaign-config.ts `updateFieldTrouble`; `customKeys` null when the custom fields cannot be listed. */
function updateFieldTrouble(field: string, value: string, customKeys: string[] | null): string | null {
  if (!field) return "Choose the field to update.";
  const allowed = RULE_ENUMS[field];
  if (allowed) return allowed.includes(value) ? null : `Choose the ${labelOf(field).toLowerCase()} to set.`;
  if (field === "leadSource") return value.length <= 100 ? null : "Lead source is too long (100 characters at most).";
  if (field.startsWith("custom.")) {
    const key = field.slice(7);
    return customKeys === null || customKeys.includes(key) ? null : `There is no contact custom field “${key}”.`;
  }
  return "Only status, qualification, priority, lead source or a contact custom field can be updated.";
}

/** Config keys each type's form shows an error under; any other error for the step is listed at the top of its card. */
const SHOWN: Record<StepType, string[]> = {
  email: ["templateId", "subject", "body"],
  whatsapp: ["templateId", "body"],
  telegram: ["templateId", "body"],
  call_task: ["taskTitle", "description", "taskDueMinutes"],
  ai_call: ["agentId"],
  create_task: ["taskTitle", "description", "taskDueMinutes", "taskType"],
  update_field: ["field", "value"],
  assign_owner: ["strategy", "userId"],
  notify: ["userId", "message"],
  branch: ["thenLength", "elseLength"],
  wait: [],
  end: [],
};

// ─── Small controls ──────────────────────────────────────────────────────────

/** A text box (or area) with an "Insert variable" menu that drops the token at the caret. */
function TokenText({
  label,
  value,
  onChange,
  multiline,
  rows = 6,
  maxLength,
  placeholder,
  hint,
  error,
  required,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  multiline?: boolean;
  rows?: number;
  maxLength?: number;
  placeholder?: string;
  hint?: ReactNode;
  error?: string;
  required?: boolean;
}) {
  const ref = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  const insert = (token: string) => {
    const next = spliceToken(ref.current, value, token);
    onChange(next.value);
    focusAt(ref.current, next.caret);
  };
  return (
    <Field label={label} hint={hint} error={error} required={required} labelAction={<VariableMenu onPick={insert} label="Variable" />}>
      {multiline ? (
        <Textarea ref={ref as Ref<HTMLTextAreaElement>} rows={rows} value={value} maxLength={maxLength} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <Input ref={ref as Ref<HTMLInputElement>} value={value} maxLength={maxLength} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
      )}
    </Field>
  );
}

/** The workspace's templates for one channel (archived ones included, so a step that still points at one shows it). */
function useChannelTemplates(channel: "email" | "whatsapp" | "telegram") {
  const ws = useWorkspace();
  return useApiQuery<Paged<Template>>(ws.key("templates", "picker", channel), ws.can("templates.read") ? ws.path("/templates") : null, {
    query: { channel, pageSize: 200, archived: "all" },
    staleTime: 30_000,
  });
}

/**
 * The picker's options: grouped by category (library order kept by name within
 * a group), searchable by name and category, the library ones marked.
 */
function templateOptions(rows: Template[], value: string | null | undefined, pending: boolean): SelectOption[] {
  const usable = rows.filter((t) => !t.archivedAt || t.id === value);
  const groups = new Map<string, Template[]>();
  for (const t of usable) {
    const key = t.category.trim() || "Other";
    groups.set(key, [...(groups.get(key) ?? []), t]);
  }
  const ordered = [...groups.entries()].sort(([a], [b]) => (a === "Other" ? 1 : b === "Other" ? -1 : a.localeCompare(b)));
  const out: SelectOption[] = [{ value: "", label: pending ? "Loading templates…" : "No template: write the message here" }];
  for (const [category, items] of ordered)
    for (const t of [...items].sort((a, b) => a.name.localeCompare(b.name)))
      out.push({
        value: t.id,
        label: (
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate">
              {t.name}
              {t.archivedAt ? " (archived)" : ""}
            </span>
            {t.fromLibrary && <Badge tone="info">Library</Badge>}
          </span>
        ),
        text: `${t.name} ${category}`,
        group: groups.size > 1 ? category : undefined,
      });
  if (value && !usable.some((t) => t.id === value) && !pending) out.push({ value, label: "A template that no longer exists" });
  return out;
}

function TemplateSelect({ channel, value, onChange, error }: { channel: "email" | "whatsapp" | "telegram"; value: string | null | undefined; onChange: (id: string | null) => void; error?: string }) {
  const ws = useWorkspace();
  const list = useChannelTemplates(channel);
  const rows = list.data?.items ?? [];
  const current = rows.find((t) => t.id === value);
  if (!ws.can("templates.read")) {
    return (
      <Field label="Template" error={error}>
        <p className="text-xs text-text-3">Your role cannot list templates{value ? "; this step uses one" : ""}.</p>
      </Field>
    );
  }
  return (
    <Field
      label="Template"
      error={error}
      hint={current?.archivedAt ? "This template is archived. Steps that use it still send it." : undefined}
      labelAction={
        value ? (
          <a href={ws.href(`/templates/${value}`)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-text-3 hover:text-text">
            Open <ExternalLink aria-hidden className="size-3" />
          </a>
        ) : undefined
      }
    >
      <Select
        value={value ?? ""}
        placeholder={list.isPending ? "Loading templates…" : "No template: write the message here"}
        searchable={rows.length > 8}
        onValueChange={(v) => onChange(v || null)}
        options={templateOptions(rows, value, list.isPending)}
      />
    </Field>
  );
}

// ─── One form per step type ──────────────────────────────────────────────────

function EmailForm({ config, set, err, isFirstEmail, stepNumber }: FormProps & { isFirstEmail: boolean; stepNumber?: number }) {
  const list = useChannelTemplates("email");
  const template = config.templateId ? list.data?.items.find((t) => t.id === config.templateId) : undefined;
  return (
    <>
      <AiStepWriter channel="email" config={config} set={set} stepNumber={isFirstEmail ? 1 : stepNumber} />
      <TemplateSelect channel="email" value={config.templateId} error={err("templateId")} onChange={(id) => set({ templateId: id ?? undefined })} />
      <TokenText
        label="Subject"
        value={str(config.subject)}
        maxLength={300}
        onChange={(v) => set({ subject: v })}
        error={err("subject")}
        placeholder={template?.subject ? `From the template: ${template.subject}` : undefined}
        hint={
          isFirstEmail
            ? "The first email needs a subject (its own or its template's): it opens the thread the follow-ups reply in."
            : template
              ? "Empty: the template's subject. If that is empty too, it replies in the first email's thread (“Re: …”)."
              : "Empty: it replies in the first email's thread (“Re: …”)."
        }
      />
      <TokenText
        label="Body"
        multiline
        rows={7}
        value={str(config.body)}
        maxLength={50000}
        onChange={(v) => set({ body: v })}
        error={err("body")}
        required={!config.templateId}
        placeholder={template ? "Empty: the template's body is sent." : "Hi {{first_name|there}}, …"}
        hint={template ? "Text here replaces the template's body for this step." : "Needed unless a template is chosen."}
      />
    </>
  );
}

function ChatForm({ channel, config, set, err, stepNumber }: FormProps & { channel: "whatsapp" | "telegram"; stepNumber?: number }) {
  const list = useChannelTemplates(channel);
  const template = config.templateId ? list.data?.items.find((t) => t.id === config.templateId) : undefined;
  return (
    <>
      <AiStepWriter channel={channel} config={config} set={set} stepNumber={stepNumber} />
      <TemplateSelect channel={channel} value={config.templateId} error={err("templateId")} onChange={(id) => set({ templateId: id ?? undefined })} />
      {template?.waTemplate && (
        <p className="-mt-1 text-xs text-text-3">
          Sends the approved WhatsApp template <span className="font-medium text-text-2">{template.waTemplate}</span>
          {template.waLanguage ? ` (${template.waLanguage})` : ""}.
        </p>
      )}
      <TokenText
        label="Message"
        multiline
        rows={5}
        value={str(config.body)}
        maxLength={50000}
        onChange={(v) => set({ body: v })}
        error={err("body")}
        required={!config.templateId}
        placeholder={template ? "Empty: the template's text is sent." : "Hi {{first_name|there}}, …"}
        hint={template ? "Text here replaces the template's text for this step." : "Needed unless a template is chosen."}
      />
    </>
  );
}

/** "Write with AI" for a message step; the result replaces the step's own subject/body (not its template). */
function AiStepWriter({ channel, config, set, stepNumber }: { channel: "email" | "whatsapp" | "telegram"; config: StepConfig; set: SetConfig; stepNumber?: number }) {
  return (
    <div className="-mb-1 flex justify-end">
      <AiWriteButton
        target="sequence_step"
        channel={channel}
        subject={str(config.subject)}
        body={str(config.body)}
        stepNumber={stepNumber}
        onApply={(out) => set(channel === "email" ? { subject: out.subject, body: out.body } : { body: out.body })}
      />
    </div>
  );
}

function TaskForm({ config, set, err, isCall }: FormProps & { isCall: boolean }) {
  const fallbackTitle = isCall ? "Call {{full_name}}" : "Follow up with {{full_name}}";
  return (
    <>
      <TokenText
        label="Task title"
        value={str(config.taskTitle)}
        maxLength={300}
        onChange={(v) => set({ taskTitle: v })}
        error={err("taskTitle")}
        placeholder={fallbackTitle}
        hint={`Empty: “${fallbackTitle}”. Variables the contact has no value for are left out.`}
      />
      <Field label="Notes" error={err("description")}>
        <Textarea rows={3} maxLength={5000} value={typeof config.description === "string" ? config.description : str(config.body)} onChange={(e) => set({ description: e.target.value, body: undefined })} placeholder="What to cover, links, talking points" />
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Due" error={err("taskDueMinutes")} hint="After the task is created. Empty: due right away.">
          <DurationInput value={config.taskDueMinutes} optional max={90 * DAY} aria-label="Due in" onChange={(m) => set({ taskDueMinutes: m })} />
        </Field>
        {!isCall && (
          <Field label="Task type" error={err("taskType")}>
            <NativeSelect value={config.taskType ?? "follow_up"} options={TASK_TYPES.map((t) => ({ value: t, label: labelOf(t) }))} onChange={(e) => set({ taskType: e.target.value as StepConfig["taskType"] })} />
          </Field>
        )}
      </div>
      <p className="text-xs text-text-3">Assigned to the contact&apos;s owner; a contact with no owner goes to the campaign&apos;s owner.</p>
    </>
  );
}

/**
 * The AI agent that places the call. Whether someone is called, and when, is
 * decided right before dialling (AiCallsService.callForStep), so the form
 * only says what those rules are.
 */
function AiCallForm({ config, set, err, agents, pending, loadError }: FormProps & { agents: AiAgent[]; pending: boolean; loadError?: string }) {
  const ws = useWorkspace();
  const value = str(config.agentId);
  const current = agents.find((a) => a.id === value);
  const usable = agents.filter((a) => !a.archivedAt);
  const link = "inline-flex items-center gap-1 text-xs text-text-3 hover:text-text";
  if (!ws.can("calls.read")) {
    return (
      <Field label="AI agent" error={err("agentId")}>
        <p className="text-xs text-text-3">Your role cannot list AI agents{value ? "; this step uses one" : ""}.</p>
      </Field>
    );
  }
  return (
    <>
      {!pending && !loadError && !usable.length && !current ? (
        <EmptyState
          compact
          icon={<AudioLines />}
          title="No AI agents yet"
          description="Create an agent with a voice and a script, then choose it here."
          action={
            <Button size="sm" icon={<Plus />} href={ws.href("/ai-agents")} external>
              Create an agent
            </Button>
          }
        />
      ) : (
        <Field
          label="AI agent"
          required
          error={err("agentId") ?? (loadError ? `Agents could not be loaded: ${loadError}` : undefined)}
          hint={
            current?.archivedAt
              ? "This agent is archived, so the step cannot be saved with it. Choose another."
              : current && !current.sync.saved
                ? `This agent's latest version is not saved on Cartesia yet${current.sync.error ? `: ${current.sync.error}` : "."}`
                : undefined
          }
          labelAction={
            <span className="flex items-center gap-3">
              {value && current && (
                <a href={ws.href(`/ai-agents/${value}`)} target="_blank" rel="noreferrer" className={link}>
                  Open agent <ExternalLink aria-hidden className="size-3" />
                </a>
              )}
              <a href={ws.href("/ai-agents")} target="_blank" rel="noreferrer" className={link}>
                Manage AI agents <ExternalLink aria-hidden className="size-3" />
              </a>
            </span>
          }
        >
          <AiAgentSelect agents={agents} value={value} pending={pending} invalid={Boolean(err("agentId"))} onChange={(id) => set({ agentId: id })} />
        </Field>
      )}
      <Callout tone="info">
        Only contacts with consent recorded as granted and a phone number are called; anyone else skips this step and moves on. Calls wait for the calling hours in
        the contact&apos;s own time zone, and nobody on the do-not-contact list is called. A booked meeting, “not interested”, “do not call” or a wrong number stops
        the contact&apos;s enrollment.
      </Callout>
    </>
  );
}

const FIXED_FIELDS: { value: string; label: string }[] = [
  { value: "status", label: "Status" },
  { value: "qualification", label: "Qualification" },
  { value: "priority", label: "Priority" },
  { value: "leadSource", label: "Lead source" },
];

function UpdateFieldForm({ config, set, err, custom, customKnown }: FormProps & { custom: CustomFieldDef[]; customKnown: boolean }) {
  const field = str(config.field);
  const value = str(config.value);
  const enumValues = RULE_ENUMS[field];
  const def = field.startsWith("custom.") ? custom.find((d) => `custom.${d.key}` === field) : undefined;
  const choices = enumValues ?? selectOptions(def);
  const known = FIXED_FIELDS.some((f) => f.value === field) || Boolean(def);
  const trouble = updateFieldTrouble(field, value, customKnown ? custom.map((d) => d.key) : null);
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label="Field" required error={err("field") ?? (trouble && !enumValues ? trouble : undefined)}>
        <NativeSelect value={field} placeholder={field ? undefined : "Choose a field"} onChange={(e) => set({ field: e.target.value, value: "" })}>
          {field && !known && <option value={field}>{field}</option>}
          <optgroup label="Contact">
            {FIXED_FIELDS.map((f) => (
              <option key={f.value} value={f.value}>
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
      <Field label="Set it to" required={Boolean(enumValues)} error={err("value") ?? (trouble && enumValues ? trouble : undefined)}>
        {choices.length ? (
          <NativeSelect value={value} placeholder="Choose…" options={choices.map((v) => ({ value: v, label: enumValues ? labelOf(v) : v }))} onChange={(e) => set({ value: e.target.value })} />
        ) : (
          <Input value={value} maxLength={field === "leadSource" ? 100 : 500} placeholder="Leave empty to clear it" onChange={(e) => set({ value: e.target.value })} />
        )}
      </Field>
    </div>
  );
}

function AssignForm({ config, set, err }: FormProps) {
  const strategy: AssignStrategy = config.strategy ?? (config.userId ? "user" : "round_robin");
  return (
    <>
      <Field
        label="Assign to"
        error={err("strategy")}
        hint={
          strategy === "round_robin"
            ? "The owner, admin, manager or member who owns the fewest contacts right now."
            : strategy === "campaign_owner"
              ? "The campaign's owner, or whoever created it when it has none."
              : undefined
        }
      >
        <NativeSelect
          value={strategy}
          options={(Object.keys(STRATEGY_LABELS) as AssignStrategy[]).map((s) => ({ value: s, label: STRATEGY_LABELS[s] }))}
          onChange={(e) => {
            const next = e.target.value as AssignStrategy;
            set({ strategy: next, userId: next === "user" ? config.userId : undefined });
          }}
        />
      </Field>
      {strategy === "user" && (
        <Field label="Teammate" required error={err("userId")}>
          <MemberPicker value={config.userId ?? null} clearable={false} onChange={(id) => set({ userId: id ?? undefined })} />
        </Field>
      )}
    </>
  );
}

function NotifyForm({ config, set, err }: FormProps) {
  return (
    <>
      <Field label="Notify" error={err("userId")} hint="Empty: the contact's owner; a contact with no owner notifies the campaign's owner.">
        <MemberPicker value={config.userId ?? null} placeholder="The contact's owner" onChange={(id) => set({ userId: id ?? undefined })} />
      </Field>
      <TokenText
        label="Message"
        value={str(config.message)}
        maxLength={2000}
        onChange={(v) => set({ message: v })}
        error={err("message")}
        placeholder="{{full_name}} reached a step in a campaign"
        hint="The notification's title (up to 300 characters). Variables the contact has no value for are left out."
      />
    </>
  );
}

function RuleRow({ rule, onChange, onRemove, custom }: { rule: StepRule; onChange: (r: StepRule) => void; onRemove: () => void; custom: CustomFieldDef[] }) {
  const isCustom = rule.field.startsWith("custom.");
  const def = isCustom ? custom.find((d) => `custom.${d.key}` === rule.field) : undefined;
  const known = (RULE_FIELDS as readonly string[]).includes(rule.field) || Boolean(def);
  const choices = YES_NO.has(rule.field) ? ["yes", "no"] : (ruleEnum(rule.field) ?? selectOptions(def));
  const ops: RuleOp[] = YES_NO.has(rule.field) || ruleEnum(rule.field) ? ["is", "is_not"] : [...RULE_OPS];
  if (!ops.includes(rule.op)) ops.push(rule.op);
  return (
    <li className="flex flex-col gap-2 rounded-sm border border-line p-2 sm:flex-row sm:items-center">
      <div className="grid min-w-0 flex-1 gap-2 sm:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)_minmax(0,1fr)]">
        <NativeSelect
          size="sm"
          aria-label="Field"
          value={rule.field}
          onChange={(e) => {
            const field = e.target.value;
            onChange({ field, op: "is", value: YES_NO.has(field) ? "yes" : "" });
          }}
        >
          {!known && <option value={rule.field}>{rule.field}</option>}
          <optgroup label="Engagement">
            {(["replied", "opened", "clicked"] as const).map((f) => (
              <option key={f} value={f}>
                {RULE_FIELD_LABELS[f]}
              </option>
            ))}
          </optgroup>
          <optgroup label="Contact">
            {RULE_FIELDS.filter((f) => f !== "replied" && f !== "opened" && f !== "clicked").map((f) => (
              <option key={f} value={f}>
                {RULE_FIELD_LABELS[f]}
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
        <NativeSelect size="sm" aria-label="Comparison" value={rule.op} options={ops.map((o) => ({ value: o, label: OP_LABELS[o] }))} onChange={(e) => onChange({ ...rule, op: e.target.value as RuleOp })} />
        {choices.length && (rule.op === "is" || rule.op === "is_not") ? (
          <NativeSelect
            size="sm"
            aria-label="Value"
            value={rule.value}
            placeholder={choices.includes(rule.value) ? undefined : "Choose…"}
            options={choices.map((v) => ({ value: v, label: ruleValueLabel(rule.field, v) }))}
            onChange={(e) => onChange({ ...rule, value: e.target.value })}
          />
        ) : (
          <Input
            size="sm"
            aria-label="Value"
            value={rule.value}
            maxLength={200}
            inputMode={rule.op === "gt" || rule.op === "lt" ? "decimal" : undefined}
            placeholder={rule.field === "tag" ? "Tag name" : rule.op === "gt" || rule.op === "lt" ? "A number" : "Value"}
            onChange={(e) => onChange({ ...rule, value: e.target.value })}
          />
        )}
      </div>
      <IconButton size="sm" variant="danger" label="Remove rule" icon={<Trash2 />} onClick={onRemove} className="self-end sm:self-auto" />
    </li>
  );
}

function BranchForm({ config, set, err, index, total, custom }: FormProps & { index: number; total: number; custom: CustomFieldDef[] }) {
  const logic = config.logic ?? { match: "all" as const, rules: [] };
  const rules = logic.rules ?? [];
  const k = Math.max(0, num(config.thenLength));
  const m = Math.max(0, num(config.elseLength));
  const setRules = (next: StepRule[]) => set({ logic: { ...logic, rules: next } });
  const resume = index + k + m + 1;
  const stepNo = (i: number) => `step ${i + 1}`;
  const range = (from: number, n: number) => (n === 1 ? stepNo(from) : `steps ${from + 1}–${from + n}`);
  const lane = (n: number, from: number, word: string) =>
    n === 0 ? `${word}: skips straight to the main path.` : from + n > total ? `${word}: ${n} step${n === 1 ? "" : "s"}, but only ${Math.max(0, total - from)} follow.` : `${word}: ${range(from, n)}.`;
  const laneMax = Math.max(0, total - index - 1);
  return (
    <>
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2 text-sm text-text-2">
          <span>Take the yes path when</span>
          <div className="w-24">
            <NativeSelect
              size="sm"
              aria-label="Match"
              value={logic.match}
              options={[
                { value: "all", label: "all" },
                { value: "any", label: "any" },
              ]}
              onChange={(e) => set({ logic: { ...logic, match: e.target.value as "all" | "any" } })}
            />
          </div>
          <span>of these hold:</span>
        </div>
        {rules.length === 0 ? (
          <p className="text-xs text-text-3">No rules: every contact takes the yes path.</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {rules.map((r, i) => (
              <RuleRow key={i} rule={r} custom={custom} onChange={(next) => setRules(rules.map((x, j) => (j === i ? next : x)))} onRemove={() => setRules(rules.filter((_, j) => j !== i))} />
            ))}
          </ul>
        )}
        {rules.length < MAX_RULES && (
          <Button size="sm" variant="ghost" icon={<Plus />} className="self-start" onClick={() => setRules([...rules, { field: "replied", op: "is", value: "yes" }])}>
            Add rule
          </Button>
        )}
        <p className="text-xs text-text-3">Opens and clicks are only known when the campaign tracks them. Text matches ignore case; a tag rule matches any of the contact&apos;s tags.</p>
        {rules.some((r) => r.field === "call_outcome") && (
          <p className="text-xs text-text-3">
            The AI call outcome is that of the contact&apos;s latest AI call in this campaign: pending until the call is over and judged, failed when it never connected,
            and blank when no call was placed (no consent or no phone number). Wait a while after the call step so the result is in.
          </p>
        )}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Yes path: the next" error={err("thenLength")} hint={lane(k, index + 1, "Yes")}>
          <div className="flex items-center gap-2">
            <Input className="w-20" type="number" min={0} max={Math.min(50, laneMax)} value={String(k)} onChange={(e) => set({ thenLength: clampInt(e.target.value, 50) })} />
            <span className="text-sm text-text-2">step{k === 1 ? "" : "s"}</span>
          </div>
        </Field>
        <Field label="No path: the following" error={err("elseLength")} hint={lane(m, index + 1 + k, "No")}>
          <div className="flex items-center gap-2">
            <Input className="w-20" type="number" min={0} max={Math.min(50, laneMax)} value={String(m)} onChange={(e) => set({ elseLength: clampInt(e.target.value, 50) })} />
            <span className="text-sm text-text-2">step{m === 1 ? "" : "s"}</span>
          </div>
        </Field>
      </div>
      <p className="text-xs text-text-3">
        {resume < total ? `Both paths then continue at ${stepNo(resume)}.` : "Both paths then reach the end of the sequence."} A branch cannot sit inside another branch&apos;s paths.
      </p>
    </>
  );
}

const clampInt = (raw: string, max: number) => {
  const n = Math.round(Number(raw.replace(/\D/g, "")) || 0);
  return Math.min(max, Math.max(0, n));
};

// ─── Cards and the list ─────────────────────────────────────────────────────

type Lane = { branch: number; lane: "yes" | "no" };

/** Which branch path each step sits on (flow.ts lanes), or null on the main path. */
function lanesOf(steps: SequenceStep[]): (Lane | null)[] {
  const out: (Lane | null)[] = steps.map(() => null);
  steps.forEach((s, b) => {
    if (s.type !== "branch") return;
    const k = Math.max(0, num(s.config?.thenLength));
    const m = Math.max(0, num(s.config?.elseLength));
    for (let j = b + 1; j <= b + k && j < steps.length; j++) out[j] ??= { branch: b, lane: "yes" };
    for (let j = b + k + 1; j <= b + k + m && j < steps.length; j++) out[j] ??= { branch: b, lane: "no" };
  });
  return out;
}

function AddStepMenu({ onAdd, label, variant = "ghost", size = "sm" }: { onAdd: (type: StepType) => void; label: ReactNode; variant?: "ghost" | "secondary"; size?: "sm" | "md" }) {
  const ws = useWorkspace();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {typeof label === "string" ? (
          <Button size={size} variant={variant} icon={<Plus />}>
            {label}
          </Button>
        ) : (
          label
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-[min(460px,var(--radix-dropdown-menu-content-available-height))] w-72 overflow-y-auto">
        {STEP_TYPES.map((t) => {
          const meta = STEP_META[t];
          const locked = stepFeatures(t).some((f) => !ws.hasFeature(f));
          return (
            <DropdownMenuItem
              key={t}
              onSelect={() => onAdd(t)}
              // The menu item greys and resizes every svg inside it; the tile keeps its own white glyph.
              icon={<StepTile type={t} className="mt-0.5 [&_svg]:!size-3.5 [&_svg]:!text-white" />}
              className="!h-auto !items-start gap-2.5 py-1.5"
            >
              <span className="flex min-w-0 flex-col">
                <span className="flex items-center gap-1.5">
                  {labelOf(t)}
                  {locked && <Badge tone="warn">Upgrade</Badge>}
                </span>
                <span className="text-xs whitespace-normal text-text-3">{meta.description}</span>
              </span>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function StepCard({
  index,
  steps,
  step,
  lane,
  readOnly,
  errors,
  prefix,
  collapsed,
  onToggle,
  onChange,
  onMove,
  onRemove,
  onInsertAfter,
  custom,
  customKnown,
  actions,
}: {
  index: number;
  steps: SequenceStep[];
  step: SequenceStep;
  lane: Lane | null;
  readOnly?: boolean;
  errors: Record<string, string>;
  prefix: string;
  collapsed: boolean;
  onToggle: () => void;
  onChange: (s: SequenceStep) => void;
  onMove: (to: number) => void;
  onRemove: () => void;
  onInsertAfter: (type: StepType) => void;
  custom: CustomFieldDef[];
  customKnown: boolean;
  actions?: ReactNode;
}) {
  const ws = useWorkspace();
  const config = step.config ?? {};
  const missing = stepFeatures(step.type).find((f) => !ws.hasFeature(f));
  const isAiCall = step.type === "ai_call";
  const agents = useAiAgents(isAiCall, "all");
  const base = `${prefix}.${index}.`;
  const shown = new Set((SHOWN[step.type] ?? []).map((k) => `${base}config.${k}`));
  shown.add(`${base}config.delayMinutes`);
  const err = (key: string) => errors[`${base}config.${key}`];
  const leftover = Object.entries(errors).filter(([k]) => k.startsWith(base) && !shown.has(k));
  const hasError = Object.keys(errors).some((k) => k.startsWith(base));
  const set: SetConfig = (patch) => {
    const next: StepConfig = { ...config, ...patch };
    for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k];
    onChange({ ...step, config: next });
  };
  const delay = num(config.delayMinutes);
  const firstEmail = steps.findIndex((s) => s.type === "email");
  const isMessage = step.type === "email" || step.type === "whatsapp" || step.type === "telegram" || isAiCall;
  /** This step's position among the message steps (1 = the first touch), for "Write with AI". */
  const messageNumber = steps.slice(0, index + 1).filter((s) => s.type === "email" || s.type === "whatsapp" || s.type === "telegram").length;
  const props: FormProps = { config, set, err };

  let form: ReactNode = null;
  switch (step.type) {
    case "email":
      form = <EmailForm {...props} isFirstEmail={firstEmail === index} stepNumber={messageNumber} />;
      break;
    case "whatsapp":
    case "telegram":
      form = <ChatForm {...props} channel={step.type} stepNumber={messageNumber} />;
      break;
    case "call_task":
    case "create_task":
      form = <TaskForm {...props} isCall={step.type === "call_task"} />;
      break;
    case "ai_call":
      form = <AiCallForm {...props} agents={agents.data ?? []} pending={agents.isPending && ws.can("calls.read")} loadError={agents.error?.message} />;
      break;
    case "update_field":
      form = <UpdateFieldForm {...props} custom={custom} customKnown={customKnown} />;
      break;
    case "assign_owner":
      form = <AssignForm {...props} />;
      break;
    case "notify":
      form = <NotifyForm {...props} />;
      break;
    case "branch":
      form = <BranchForm {...props} index={index} total={steps.length} custom={custom} />;
      break;
    case "end":
      form = <p className="text-xs text-text-3">A contact who reaches this step finishes the sequence; nothing after it runs for them.</p>;
      break;
    case "wait":
      form = null;
      break;
  }

  return (
    <div className={cn("rounded-md border bg-panel", hasError ? "border-bad-edge" : "border-line")}>
      <div className="flex items-center gap-2 px-3 py-2">
        <button type="button" onClick={onToggle} aria-expanded={!collapsed} className="flex min-w-0 flex-1 items-center gap-2 text-left">
          {collapsed ? <ChevronRight aria-hidden className="size-3.5 shrink-0 text-text-3" /> : <ChevronDown aria-hidden className="size-3.5 shrink-0 text-text-3" />}
          <StepTile type={step.type} size="md" />
          <span className="min-w-0 flex-1">
            <span className="flex flex-wrap items-center gap-1.5">
              <span className="text-sm font-medium text-text-hi">
                <span className="mr-1 text-text-3 tabular-nums">{index + 1}.</span>
                {labelOf(step.type)}
              </span>
              {lane && (
                <Badge tone={lane.lane === "yes" ? "ok" : "bad"} quiet>
                  {lane.lane === "yes" ? "Yes" : "No"} path of step {lane.branch + 1}
                </Badge>
              )}
              {delay > 0 && step.type !== "wait" && <Badge quiet>after {formatMinutes(delay)}</Badge>}
              {missing && (
                <Badge tone="warn" title={`Needs a plan with: ${FEATURE_LABELS[missing]}`}>
                  Upgrade
                </Badge>
              )}
              {hasError && <Badge tone="bad">Needs attention</Badge>}
            </span>
            <span className="block truncate text-xs text-text-3">{stepSummary(step, agents.data)}</span>
          </span>
        </button>
        {actions && <div className="flex shrink-0 items-center">{actions}</div>}
        {!readOnly && (
          <div className="flex shrink-0 items-center">
            <IconButton size="sm" label="Move up" icon={<ArrowUp />} disabled={index === 0} onClick={() => onMove(index - 1)} />
            <IconButton size="sm" label="Move down" icon={<ArrowDown />} disabled={index === steps.length - 1} onClick={() => onMove(index + 1)} />
            {steps.length < MAX_STEPS && <AddStepMenu onAdd={onInsertAfter} label={<IconButton size="sm" label="Add a step below" icon={<Plus />} />} />}
            <IconButton size="sm" variant="danger" label="Remove step" icon={<Trash2 />} onClick={onRemove} />
          </div>
        )}
      </div>
      {!collapsed && (
        <fieldset disabled={readOnly} className="flex min-w-0 flex-col gap-3 border-t border-line p-3">
          {leftover.map(([k, message]) => (
            <p key={k} role="alert" className="text-xs text-bad-ink">
              {message}
            </p>
          ))}
          {missing && <Callout tone="warn">The current plan does not include {FEATURE_LABELS[missing].toLowerCase()}, so this step cannot be saved until the plan is upgraded.</Callout>}
          <Field
            label={step.type === "wait" ? "Wait for" : "Wait before this step"}
            error={err("delayMinutes")}
            hint={
              index === 0
                ? "Counted from when the contact is enrolled."
                : isAiCall
                  ? "Counted from the previous step. Two AI calls in a row are always at least a day apart."
                  : isMessage
                    ? "Counted from the previous step. Two messages on the same channel in a row are always at least a day apart."
                    : "Counted from the previous step."
            }
          >
            <DurationInput
              value={step.type === "wait" ? delay : config.delayMinutes}
              optional={step.type !== "wait"}
              max={365 * DAY}
              aria-label={step.type === "wait" ? "Wait for" : "Wait before"}
              onChange={(m) => set({ delayMinutes: step.type === "wait" ? (m ?? 0) : m || undefined })}
            />
          </Field>
          {form}
        </fieldset>
      )}
    </div>
  );
}

let keySeq = 0;
const newKey = () => `step-${++keySeq}`;

/**
 * The ordered steps editor.
 *
 *   <StepsEditor steps={draft.steps} onChange={(steps) => setDraft({ ...draft, steps })} errors={save.error?.fields} />
 */
export function StepsEditor({ steps, onChange, readOnly, errors = {}, errorPrefix = "steps", stepActions }: StepsEditorProps) {
  const custom = useContactCustomFields();
  const ws = useWorkspace();
  // Stable React keys that follow a step when it moves (the steps themselves carry no id).
  const keys = useRef<string[]>([]);
  if (keys.current.length !== steps.length) keys.current = steps.map(() => newKey());
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());

  const lanes = lanesOf(steps);
  const structure = steps.length ? flowTrouble(toFlow(steps)) : null;
  const listError = errors[errorPrefix];

  const insert = (at: number, type: StepType) => {
    if (steps.length >= MAX_STEPS) return;
    keys.current.splice(at, 0, newKey());
    const next = [...steps];
    next.splice(at, 0, { type, config: defaultStepConfig(type) });
    onChange(next);
  };
  const move = (from: number, to: number) => {
    if (to < 0 || to >= steps.length) return;
    const next = [...steps];
    const [item] = next.splice(from, 1);
    const [key] = keys.current.splice(from, 1);
    if (!item || !key) return;
    next.splice(to, 0, item);
    keys.current.splice(to, 0, key);
    onChange(next);
  };
  const remove = (i: number) => {
    keys.current.splice(i, 1);
    onChange(steps.filter((_, j) => j !== i));
  };
  const toggle = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const allCollapsed = steps.length > 0 && keys.current.every((k) => collapsed.has(k));

  return (
    <div className="flex min-w-0 flex-col gap-2">
      {listError && (
        <p role="alert" className="rounded-sm border border-bad-edge bg-bad-wash px-3 py-2 text-xs text-bad-ink">
          {listError}
        </p>
      )}
      {structure && structure !== listError && <Callout tone="warn">{structure}</Callout>}
      {steps.length === 0 ? (
        <EmptyState compact icon={<ListOrdered />} title="No steps yet" description="A sequence usually opens with an email, then waits and follows up." />
      ) : (
        <>
          {steps.length > 2 && (
            <div className="flex justify-end">
              <Button size="sm" variant="ghost" onClick={() => setCollapsed(allCollapsed ? new Set() : new Set(keys.current))}>
                {allCollapsed ? "Expand all" : "Collapse all"}
              </Button>
            </div>
          )}
          <ol className="flex flex-col gap-2">
            {steps.map((s, i) => {
              const key = keys.current[i]!;
              const lane = lanes[i] ?? null;
              return (
                <li key={key} className={cn("min-w-0", lane && "border-l-2 pl-2.5 sm:pl-4", lane?.lane === "yes" && "border-ok", lane?.lane === "no" && "border-bad")}>
                  <StepCard
                    index={i}
                    steps={steps}
                    step={s}
                    lane={lane}
                    readOnly={readOnly}
                    errors={errors}
                    prefix={errorPrefix}
                    collapsed={collapsed.has(key)}
                    onToggle={() => toggle(key)}
                    onChange={(next) => onChange(steps.map((x, j) => (j === i ? next : x)))}
                    onMove={(to) => move(i, to)}
                    onRemove={() => remove(i)}
                    onInsertAfter={(type) => insert(i + 1, type)}
                    custom={custom.data ?? []}
                    customKnown={Boolean(custom.data) && ws.can("contacts.read")}
                    actions={stepActions?.(s, i)}
                  />
                </li>
              );
            })}
          </ol>
        </>
      )}
      {!readOnly && steps.length < MAX_STEPS && (
        <div className={cn(!steps.length && "-mt-3 flex justify-center pb-4")}>
          <AddStepMenu onAdd={(t) => insert(steps.length, t)} label="Add step" variant={steps.length ? "ghost" : "secondary"} />
        </div>
      )}
      {!readOnly && steps.length >= MAX_STEPS && <p className="text-xs text-text-3">A sequence holds at most {MAX_STEPS} steps.</p>}
    </div>
  );
}
