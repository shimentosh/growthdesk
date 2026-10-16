/*
 * Workflow automation shapes and the labels the builder shows. Kept in step
 * with apps/api/src/automation/workflows.service.ts (DTOs), actions.ts (what
 * each action's config accepts) and conditions.ts (which paths a condition
 * may read).
 */
import type { WorkflowRunStatus, WorkflowTrigger, WORKFLOW_ACTIONS } from "@growthdesk/shared";

export type WorkflowActionType = (typeof WORKFLOW_ACTIONS)[number];
export type ConditionOp = "is" | "is_not" | "contains" | "gt" | "lt" | "exists";

export type WorkflowCondition = { field: string; op: ConditionOp; value: string };
export type WorkflowAction = { type: WorkflowActionType; delayMinutes: number; config: Record<string, unknown> };

/** GET /workflows/:id, POST, PATCH — `workflowDto()` */
export type Workflow = {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  trigger: WorkflowTrigger;
  conditions: WorkflowCondition[];
  actions: WorkflowAction[];
  requiresApproval: boolean;
  runCount: number;
  lastRunAt: string | null;
  createdById: string | null;
  createdAt: string;
  updatedAt: string;
};

/** GET /workflows — each row also counts its runs held for approval. */
export type WorkflowListItem = Workflow & { awaitingApproval: number };

/** One entry of a run's log, as the executor writes it (open-ended; these are the keys it uses). */
export type RunLogEntry = {
  step?: "plan" | "conditions" | "approval" | "action" | string;
  status?: string;
  met?: boolean;
  failed?: WorkflowCondition;
  index?: number;
  type?: string;
  detail?: string;
  error?: string;
  until?: string;
  attempt?: number;
  by?: string;
  at?: string;
  [key: string]: unknown;
};

/** GET /workflow-runs, GET /workflows/:id/runs (paged) — `runDto()` */
export type WorkflowRun = {
  id: string;
  workflowId: string;
  workflow?: { id: string; name: string };
  eventId: string | null;
  status: WorkflowRunStatus;
  subjectType: string | null;
  subjectId: string | null;
  actionIndex: number;
  resumeAt: string | null;
  log: RunLogEntry[] | null;
  error: string | null;
  attempts: number;
  approvedById: string | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
};

export const TRIGGER_LABELS: Record<WorkflowTrigger, { label: string; description: string }> = {
  "contact.created": { label: "Contact created", description: "A contact is added any way other than an import." },
  "lead.imported": {
    label: "Lead imported",
    description: "A lead arrives through a CSV import, a form or the API. A known contact sent again through a form or the API fires it too, with event.returning = true.",
  },
  "contact.qualified": { label: "Contact qualified", description: "A contact is marked as qualified." },
  "reply.received": { label: "Reply received", description: "A contact replies by email, WhatsApp or Telegram." },
  "call.completed": { label: "Call completed", description: "A call finishes with an outcome: logged by hand, placed with click-to-call, or made by an AI agent. Filter by event.outcome." },
  "meeting.booked": { label: "Meeting booked", description: "A meeting is scheduled with a contact." },
  "deal.stage_changed": { label: "Deal stage changed", description: "A deal moves to another pipeline stage." },
  "deal.stale": { label: "Deal went stale", description: "An open deal has had no progress for longer than its stage allows (set per stage in Settings → Pipelines)." },
  "quote.accepted": { label: "Quote accepted", description: "A buyer accepts and signs a quote. event.total and event.quoteNumber say which." },
  "task.overdue": { label: "Task overdue", description: "An open task passes its due date." },
  "list.subscribed": {
    label: "Joined a list",
    description: "A contact is added to a lead list (by hand, import, the API or a workflow). Add a condition on event.listName or event.listId for one list.",
  },
  "marketing.opened": { label: "Opened a marketing email", description: "A person opens a marketing campaign for the first time (once per email). Filter by event.campaignName." },
  "marketing.clicked": { label: "Clicked a link", description: "A person clicks a link in a marketing email (first click per email). Filter by event.url, e.g. contains “pricing”." },
  "marketing.unsubscribed": {
    label: "Unsubscribed",
    description: "A person unsubscribes from marketing email — from everything (event.scope = all) or one list (event.scope = list, event.listName).",
  },
};

export const triggerLabel = (t: string) => TRIGGER_LABELS[t as WorkflowTrigger]?.label ?? t;

export const ACTION_LABELS: Record<WorkflowActionType, { label: string; description: string }> = {
  assign_contact: { label: "Assign contact", description: "Give the contact an owner — one person or round-robin." },
  update_contact: { label: "Update contact field", description: "Set status, qualification, priority, lead source or a custom field." },
  create_task: { label: "Create task", description: "Add a task for the owner or a teammate." },
  notify: { label: "Notify teammates", description: "Send an in-app (and optionally email) notification." },
  enroll_campaign: { label: "Enroll in campaign", description: "Add the contact to a campaign." },
  stop_campaigns: { label: "Stop campaigns", description: "Stop the contact's active or paused campaign enrollments." },
  add_tag: { label: "Add tags", description: "Tag the contact." },
  add_to_list: { label: "Add to list", description: "Subscribe the contact to a lead list for marketing email." },
  remove_from_list: { label: "Remove from list", description: "Take the contact off a lead list (an unsubscribe is kept)." },
  hand_to_sales: { label: "Hand to sales", description: "Move the contact to In sales, stop outreach sequences and give the owner a task." },
};

export const OP_LABELS: Record<ConditionOp, string> = {
  is: "is",
  is_not: "is not",
  contains: "contains",
  gt: "is greater than",
  lt: "is less than",
  exists: "has a value",
};

/** The fixed paths a condition may read (conditions.ts CONDITION_PATH), apart from contact.custom.<key> and event.<key>. */
export const CONDITION_FIELDS: { value: string; label: string }[] = [
  { value: "contact.status", label: "Contact · Status" },
  { value: "contact.qualification", label: "Contact · Qualification" },
  { value: "contact.priority", label: "Contact · Priority" },
  { value: "contact.leadSource", label: "Contact · Lead source" },
  { value: "contact.tags", label: "Contact · Tags" },
  { value: "contact.country", label: "Contact · Country" },
  { value: "deal.value", label: "Deal · Value" },
  { value: "deal.stage", label: "Deal · Stage name" },
  { value: "deal.status", label: "Deal · Status" },
];

/** Same rule as the API: a custom-field or event key. */
export const CONDITION_KEY = /^[A-Za-z0-9_]{1,60}$/;
