import { z } from "zod";
import {
  CampaignSettingsInput,
  ContactFilter,
  ScheduleInput,
  type FlowStep,
  toFlow,
} from "@growthdesk/shared";
import { badRequest } from "../common/errors.js";
import type { StepType } from "../generated/prisma/client.js";

/*
 * Small pure helpers shared by the campaign API and the sequence engine:
 * how a stored schedule/settings blob is read, which step kinds act, and
 * how an audience is described to a person.
 */

export type ScheduleT = z.infer<typeof ScheduleInput>;
export type SettingsT = z.infer<typeof CampaignSettingsInput>;

/** Steps that do something to or for the contact (as opposed to wait / branch / end, which only route). */
export const ACTION_STEPS: ReadonlySet<string> = new Set([
  "email",
  "whatsapp",
  "telegram",
  "call_task",
  "ai_call",
  "create_task",
  "update_field",
  "assign_owner",
  "notify",
]);

/** Steps that send a message through a channel. */
export const MESSAGE_STEPS: ReadonlySet<string> = new Set(["email", "whatsapp", "telegram"]);

/** Step kinds that act outside Growthdesk (a provider is asked to deliver): a "running" execution may have happened. */
export const EXTERNAL_STEPS: ReadonlySet<string> = new Set(["email", "whatsapp", "telegram", "ai_call"]);

/** Step kinds that need the plan's "multichannel" feature. */
export const MULTICHANNEL_STEPS: ReadonlySet<string> = new Set(["whatsapp", "telegram", "call_task", "ai_call"]);

/** A step as stored: its kind and its free-form config. */
export type StepLike = { type: StepType | string; config: unknown };

export type StepConfigT = {
  delayMinutes?: number;
  subject?: string;
  body?: string;
  templateId?: string | null;
  logic?: { match: "all" | "any"; rules: { field: string; op: string; value: string }[] };
  thenLength?: number;
  elseLength?: number;
  taskTitle?: string;
  taskType?: string;
  taskDueMinutes?: number;
  field?: string;
  value?: string;
  userId?: string | null;
  strategy?: "user" | "round_robin" | "campaign_owner";
  message?: string;
  integrationId?: string | null;
  description?: string;
  agentId?: string | null;
  [key: string]: unknown;
};

export const configOf = (step: { config: unknown }): StepConfigT =>
  (step.config && typeof step.config === "object" && !Array.isArray(step.config) ? step.config : {}) as StepConfigT;

export const flowOf = (steps: StepLike[]): FlowStep[] => toFlow(steps.map((s) => ({ type: String(s.type), config: s.config })));

/** The first step that acts (in list order), or null. */
export function firstActionStep<T extends StepLike>(steps: T[]): T | null {
  return steps.find((s) => ACTION_STEPS.has(String(s.type))) ?? null;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A stored schedule, read leniently: anything invalid falls back to the defaults. */
export function readSchedule(raw: unknown): ScheduleT {
  const parsed = ScheduleInput.safeParse(isObj(raw) ? raw : {});
  return parsed.success ? parsed.data : ScheduleInput.parse({});
}

/** Stored settings, read leniently (field by field, so one bad value does not reset the rest). */
export function readSettings(raw: unknown): SettingsT {
  const src = isObj(raw) ? raw : {};
  const parsed = CampaignSettingsInput.safeParse(src);
  if (parsed.success) return parsed.data;
  const base = CampaignSettingsInput.parse({});
  const out: Record<string, unknown> = { ...base };
  for (const key of Object.keys(base)) {
    const one = CampaignSettingsInput.safeParse({ [key]: src[key] });
    if (one.success) out[key] = (one.data as Record<string, unknown>)[key];
  }
  return out as SettingsT;
}

function parseNamed<T extends z.ZodTypeAny>(schema: T, value: unknown, prefix: string): z.infer<T> {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const fields: Record<string, string> = {};
  for (const issue of result.error.issues) {
    const key = [prefix, ...issue.path.map(String)].join(".");
    fields[key] ??= issue.message;
  }
  const first = Object.entries(fields)[0];
  throw badRequest(first ? `${first[0]}: ${first[1]}` : `Invalid ${prefix}`, fields);
}

/** Workspace defaults ← existing values ← what the request sent, parsed with the shared schema. */
export function mergeSchedule(...layers: unknown[]): ScheduleT {
  return parseNamed(ScheduleInput, Object.assign({}, ...layers.filter(isObj)), "schedule");
}

export function mergeSettings(...layers: unknown[]): SettingsT {
  return parseNamed(CampaignSettingsInput, Object.assign({}, ...layers.filter(isObj)), "settings");
}

/** The workspace's campaign defaults (settings.campaignDefaults), as loose objects. */
export function campaignDefaults(workspaceSettings: unknown): { schedule: Record<string, unknown>; settings: Record<string, unknown> } {
  const s = isObj(workspaceSettings) ? workspaceSettings : {};
  const d = isObj(s.campaignDefaults) ? s.campaignDefaults : {};
  return { schedule: isObj(d.schedule) ? d.schedule : {}, settings: isObj(d.settings) ? d.settings : {} };
}

/** A loose JSON object in a request body (schedule/settings are merged before they are validated). */
export const LooseObject = z.record(z.string(), z.unknown());

export type AudienceT =
  | { type: "contacts"; contactIds: string[] }
  | { type: "view"; viewId: string }
  | { type: "filter"; filter: z.infer<typeof ContactFilter> }
  | { type: "lists"; listIds: string[] };

export function readAudience(raw: unknown): AudienceT | null {
  if (!isObj(raw)) return null;
  if (raw.type === "contacts" && Array.isArray(raw.contactIds)) return { type: "contacts", contactIds: raw.contactIds.filter((v): v is string => typeof v === "string") };
  if (raw.type === "view" && typeof raw.viewId === "string") return { type: "view", viewId: raw.viewId };
  if (raw.type === "lists" && Array.isArray(raw.listIds)) return { type: "lists", listIds: raw.listIds.filter((v): v is string => typeof v === "string") };
  if (raw.type === "filter" && isObj(raw.filter)) {
    const parsed = ContactFilter.safeParse(raw.filter);
    return parsed.success ? { type: "filter", filter: parsed.data } : null;
  }
  return null;
}

const FILTER_LABELS: Record<string, string> = {
  q: "matching",
  status: "status",
  qualification: "qualification",
  priority: "priority",
  ownerId: "owner",
  companyId: "company",
  tag: "tag",
  leadSource: "lead source",
  hasEmail: "has email",
  hasPhone: "has phone",
  noNextAction: "no next action",
  createdAfter: "created after",
  createdBefore: "created before",
  campaignId: "in campaign",
  stage: "stage",
  listId: "in list",
  archived: "archived",
};

/** One line a person can read: who this campaign is for. `names` is the saved view's name, or the lists' names. */
export function describeAudience(audience: AudienceT | null, names?: string | string[] | null): string {
  const viewName = typeof names === "string" ? names : null;
  if (!audience) return "No audience chosen yet";
  if (audience.type === "contacts") {
    const n = new Set(audience.contactIds).size;
    return `${n.toLocaleString()} selected contact${n === 1 ? "" : "s"}`;
  }
  if (audience.type === "view") return viewName ? `Contacts in the saved view “${viewName}”` : "Contacts in a saved view that no longer exists";
  if (audience.type === "lists") {
    const listNames = Array.isArray(names) ? names : [];
    if (!listNames.length) return "Lead lists that no longer exist";
    return listNames.length === 1 ? `Leads in “${listNames[0]}”` : `Leads in ${listNames.length} lists: ${listNames.map((n) => `“${n}”`).join(", ")}`;
  }
  const parts = Object.entries(audience.filter)
    .filter(([, v]) => v !== undefined && !(Array.isArray(v) && v.length === 0))
    .map(([k, v]) => {
      const label = FILTER_LABELS[k] ?? k;
      if (typeof v === "boolean") return v ? label : `not ${label}`;
      if (Array.isArray(v)) return `${label}: ${v.join(", ")}`;
      if (v instanceof Date) return `${label} ${v.toISOString().slice(0, 10)}`;
      return `${label}: ${String(v)}`;
    });
  return parts.length ? `Contacts where ${parts.join("; ")}` : "All contacts";
}

/** Renders text for an internal step (task title, notification): unresolved tokens are dropped rather than shown raw. */
export function stripTokens(text: string): string {
  return text.replace(/\{\{[^}]*\}\}/g, "").replace(/[ \t]{2,}/g, " ").trim();
}

export const CONTACT_FIELD_ENUMS = {
  status: ["new", "contacted", "replied", "interested", "customer", "not_interested", "do_not_contact"],
  qualification: ["unqualified", "qualifying", "qualified", "disqualified"],
  priority: ["low", "medium", "high", "urgent"],
} as const;

/** Why an update_field step's field/value cannot be applied, or null. */
export function updateFieldTrouble(field: unknown, value: unknown, customKeys: readonly string[]): string | null {
  if (typeof field !== "string" || !field) return "choose the field to update";
  const v = typeof value === "string" ? value : "";
  if (field === "status" || field === "qualification" || field === "priority") {
    const allowed = CONTACT_FIELD_ENUMS[field] as readonly string[];
    return allowed.includes(v) ? null : `${field} must be one of: ${allowed.join(", ")}`;
  }
  if (field === "leadSource") return v.length <= 100 ? null : "lead source is too long";
  if (field.startsWith("custom.")) {
    const key = field.slice(7);
    return customKeys.includes(key) ? null : `there is no contact custom field "${key}"`;
  }
  return "only status, qualification, priority, leadSource or custom.<key> can be updated";
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Path ids are checked before they reach Postgres, so a malformed id is a 404 rather than a database error. */
export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID.test(v);
