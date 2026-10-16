import { z } from "zod";
import { WORKFLOW_KINDS, WORKFLOW_TEMPLATES, WorkflowActionInput, WorkflowConditionInput, WorkflowInput, patchOf, workflowKind, type WorkflowTemplate } from "@growthdesk/shared";
import { WorkflowsService } from "../../automation/workflows.service.js";
import { EntitlementsService } from "../../billing/entitlements.service.js";
import { parseWith } from "../../common/decorators.js";
import { badRequest, conflict, notFound } from "../../common/errors.js";
import { definePrompt, defineTool, pageInput, paged, type McpCtx, type McpDeps } from "../tool.js";

/*
 * Automation through MCP: workflows (trigger → conditions → actions) and
 * their runs. A workflow is always created switched off; turning one on is an
 * important action, because from then on it acts by itself on every matching
 * event — the preview spells out the trigger and each action in plain words.
 * Deleting one and approving a held run are important too.
 */

const uuid = z.string().uuid();

const TRIGGER_WORDS: Record<string, string> = {
  "contact.created": "a contact or lead is created",
  "lead.imported": "a lead arrives from a form, the API or an import",
  "contact.qualified": "a contact is marked qualified",
  "reply.received": "someone replies to an email or message",
  "call.completed": "a call is completed",
  "meeting.booked": "a meeting is booked",
  "deal.stage_changed": "a deal changes stage",
  "deal.stale": "a deal has had no activity for a while",
  "quote.accepted": "a customer accepts a quote",
  "task.overdue": "a task becomes overdue",
  "list.subscribed": "someone joins a list",
  "marketing.opened": "someone opens a marketing email",
  "marketing.clicked": "someone clicks a link in a marketing email",
  "marketing.unsubscribed": "someone unsubscribes from marketing email",
};

const OP_WORDS: Record<string, string> = { is: "is", is_not: "is not", contains: "contains", gt: "is greater than", lt: "is less than", exists: "is set" };

type Action = { type: string; delayMinutes?: number; config?: Record<string, unknown> };
type Names = { users: Map<string, string>; campaigns: Map<string, string>; lists: Map<string, string> };

const duration = (m: number) => (m % 1440 === 0 ? `${m / 1440} day${m === 1440 ? "" : "s"}` : m % 60 === 0 ? `${m / 60} hour${m === 60 ? "" : "s"}` : `${m} minute${m === 1 ? "" : "s"}`);

function actionWords(a: Action, n: Names): string {
  const c = (a.config ?? {}) as Record<string, any>;
  const who = (id: unknown) => (id === "owner" ? "the contact's owner" : (n.users.get(String(id)) ?? `member ${String(id)}`));
  const list = (id: unknown) => (id ? `"${n.lists.get(String(id)) ?? String(id)}"` : "(no list chosen)");
  let s: string;
  switch (a.type) {
    case "assign_contact":
      s = c.strategy === "round_robin" ? `assign an owner round-robin${c.userIds?.length ? ` among ${c.userIds.map(who).join(", ")}` : ""}` : `assign the contact to ${who(c.userId)}`;
      if (!c.overwrite) s += " (only if unowned)";
      break;
    case "update_contact":
      s = `set ${String(c.field)} to "${String(c.value)}"`;
      break;
    case "create_task":
      s = `create a ${c.priority ?? "medium"}-priority task "${String(c.title)}" for ${who(c.assignTo ?? "owner")}${c.dueInMinutes !== undefined ? `, due in ${duration(Number(c.dueInMinutes))}` : ""}`;
      break;
    case "notify": {
      const to = [...(c.contactOwner ? ["the contact's owner"] : []), ...(c.roles ?? []).map((r: string) => `every ${r}`), ...(c.userIds ?? []).map(who)];
      s = `notify ${to.join(", ") || "nobody"}${c.title ? ` ("${c.title}")` : ""}${c.email ? " by in-app notification and email" : " in the app"}`;
      break;
    }
    case "enroll_campaign":
      s = c.campaignId ? `ENROLL the contact in the outreach campaign "${n.campaigns.get(String(c.campaignId)) ?? c.campaignId}" — its sequence will email them` : "enroll in a campaign (none chosen)";
      break;
    case "stop_campaigns":
      s = c.campaignId ? `stop their sequence in "${n.campaigns.get(String(c.campaignId)) ?? c.campaignId}"` : "stop all their outreach sequences";
      break;
    case "add_tag":
      s = `tag them ${[c.tag, ...(c.tags ?? [])].filter(Boolean).join(", ")}`;
      break;
    case "add_to_list":
      s = `add them to the list ${list(c.listId)}`;
      break;
    case "remove_from_list":
      s = `remove them from the list ${list(c.listId)}`;
      break;
    case "hand_to_sales":
      s = `hand them to sales (stage In sales, outreach stops${c.createTask === false ? "" : ", plus a task for the owner"})`;
      break;
    default:
      s = a.type;
  }
  return a.delayMinutes ? `after ${duration(a.delayMinutes)}, ${s}` : s;
}

/** Names for the members, campaigns and lists a set of actions mentions. */
async function namesFor(ctx: McpCtx, deps: McpDeps, actions: Action[]): Promise<Names> {
  const db = deps.prisma.db;
  const users = new Set<string>();
  const campaigns = new Set<string>();
  const lists = new Set<string>();
  for (const a of actions) {
    const c = (a.config ?? {}) as Record<string, any>;
    for (const u of [c.userId, c.assignTo, ...(c.userIds ?? [])]) if (typeof u === "string" && /^[0-9a-f-]{36}$/i.test(u)) users.add(u);
    if (typeof c.campaignId === "string" && c.campaignId) campaigns.add(c.campaignId);
    if (typeof c.listId === "string" && c.listId) lists.add(c.listId);
  }
  const wid = ctx.workspace.id;
  const [u, cp, l] = await Promise.all([
    users.size ? db.membership.findMany({ where: { workspaceId: wid, userId: { in: [...users] } }, select: { userId: true, user: { select: { name: true } } } }) : [],
    campaigns.size ? db.campaign.findMany({ where: { workspaceId: wid, id: { in: [...campaigns] } }, select: { id: true, name: true } }) : [],
    lists.size ? db.marketingList.findMany({ where: { workspaceId: wid, id: { in: [...lists] } }, select: { id: true, name: true } }) : [],
  ]);
  return { users: new Map(u.map((m) => [m.userId, m.user.name])), campaigns: new Map(cp.map((x) => [x.id, x.name])), lists: new Map(l.map((x) => [x.id, x.name])) };
}

/** A workflow in plain words: "When …, if …, then …". */
async function describeWorkflow(ctx: McpCtx, deps: McpDeps, w: { trigger: string; conditions: unknown; actions: unknown; requiresApproval: boolean }) {
  const actions = (Array.isArray(w.actions) ? w.actions : []) as Action[];
  const conditions = (Array.isArray(w.conditions) ? w.conditions : []) as { field: string; op: string; value: string }[];
  const names = await namesFor(ctx, deps, actions);
  const when = `When ${TRIGGER_WORDS[w.trigger] ?? w.trigger}`;
  const cond = conditions.length ? `, and ${conditions.map((c) => `${c.field} ${OP_WORDS[c.op] ?? c.op}${c.op === "exists" ? "" : ` "${c.value}"`}`).join(" and ")}` : "";
  const steps = actions.map((a, i) => `${i + 1}. ${actionWords(a, names)}`);
  return [`${when}${cond}:`, ...steps, ...(w.requiresApproval ? ["Each run waits for someone to approve it (approve_workflow_run) before acting."] : [])].join("\n");
}

const templateById = (id: string): WorkflowTemplate => {
  const t = WORKFLOW_TEMPLATES.find((x) => x.id === id);
  if (!t) throw notFound(`The template "${id}"`);
  return t;
};

const workflowBrief = (w: { id: string; name: string; enabled: boolean; trigger: string; requiresApproval: boolean; runCount: number; lastRunAt: Date | null; awaitingApproval?: number }) => ({
  id: w.id,
  name: w.name,
  kind: workflowKind(w.trigger),
  enabled: w.enabled,
  trigger: w.trigger,
  requiresApproval: w.requiresApproval,
  runCount: w.runCount,
  lastRunAt: w.lastRunAt,
  ...(w.awaitingApproval ? { awaitingApproval: w.awaitingApproval } : {}),
});

const WorkflowPatch = patchOf(WorkflowInput.omit({ enabled: true }));

export const AUTOMATION_TOOLS = [
  defineTool({
    name: "list_workflow_templates",
    title: "List workflow templates",
    description:
      "Ready-made sales and marketing workflows (speed to lead, round-robin, new lead → sequence, reply → task, deal won → onboarding, subscriber → welcome list, clicked pricing → hand to sales, …) with their trigger, conditions and actions. `todo` says what must be chosen before it can be used (a campaign, a list). Create one with create_workflow { templateId }.",
    input: z.object({ kind: z.enum(WORKFLOW_KINDS).optional() }),
    permission: "automation.read",
    risk: "read",
    handler: async (_ctx, args) => ({
      items: WORKFLOW_TEMPLATES.filter((t) => !args.kind || t.kind === args.kind).map((t) => ({
        id: t.id,
        kind: t.kind,
        name: t.name,
        summary: t.summary,
        trigger: t.trigger,
        conditions: t.conditions,
        actions: t.actions,
        ...(t.todo ? { todo: t.todo } : {}),
      })),
    }),
  }),

  defineTool({
    name: "list_workflows",
    title: "List workflows",
    description: "The workspace's workflows: on or off, trigger, how often they ran, and runs waiting for approval.",
    input: z.object({ enabled: z.boolean().optional() }),
    permission: "automation.read",
    risk: "read",
    handler: async (ctx, args, deps) => {
      const rows = await deps.get(WorkflowsService).list(ctx);
      return { items: rows.filter((w) => args.enabled === undefined || w.enabled === args.enabled).map(workflowBrief) };
    },
  }),

  defineTool({
    name: "get_workflow",
    title: "Get a workflow",
    description: "One workflow's full definition (trigger, conditions, actions with their config) and a plain-words explanation of what it does.",
    input: z.object({ workflowId: uuid }),
    permission: "automation.read",
    risk: "read",
    handler: async (ctx, args, deps) => {
      const w = await deps.get(WorkflowsService).get(ctx, args.workflowId);
      return { ...workflowBrief(w), description: w.description || undefined, conditions: w.conditions, actions: w.actions, explained: await describeWorkflow(ctx, deps, w) };
    },
  }),

  defineTool({
    name: "create_workflow",
    title: "Create a workflow (switched off)",
    description:
      "Creates a workflow, always switched OFF — turn it on with enable_workflow once the user agrees. Either from a template (templateId from list_workflow_templates; fill its blanks: campaignId for enroll_campaign, listId for add_to_list, removeListId for remove_from_list, or replace conditions / actions entirely) or from a full definition (name, trigger, conditions, actions). Actions: assign_contact, update_contact, create_task, notify, enroll_campaign, stop_campaigns, add_tag, add_to_list, remove_from_list, hand_to_sales, each with a config and an optional delayMinutes. For a workflow no template covers, call get_workflow_reference first: it lists every trigger, action config schema and condition path.",
    input: z.object({
      templateId: z.string().max(80).optional(),
      campaignId: uuid.optional().describe("Fills enroll_campaign in a template (an always-on or running outreach campaign)."),
      listId: uuid.optional().describe("Fills add_to_list in a template."),
      removeListId: uuid.optional().describe("Fills remove_from_list in a template."),
      name: z.string().trim().min(1).max(120).optional(),
      description: z.string().trim().max(1000).optional(),
      trigger: WorkflowInput.shape.trigger.optional(),
      conditions: z.array(WorkflowConditionInput).max(20).optional(),
      actions: z.array(WorkflowActionInput).min(1).max(20).optional(),
      requiresApproval: z.boolean().optional().describe("Hold every run until someone approves it."),
    }),
    permission: "automation.write",
    risk: "write",
    handler: async (ctx, args, deps) => {
      let def: Record<string, unknown>;
      if (args.templateId) {
        const t = templateById(args.templateId);
        const actions = (args.actions ?? t.actions).map((a) => {
          const config = { ...(a.config ?? {}) } as Record<string, unknown>;
          if (a.type === "enroll_campaign" && !config.campaignId && args.campaignId) config.campaignId = args.campaignId;
          if (a.type === "add_to_list" && !config.listId && args.listId) config.listId = args.listId;
          if (a.type === "remove_from_list" && !config.listId && args.removeListId) config.listId = args.removeListId;
          return { ...a, config };
        });
        const conditions = args.conditions ?? t.conditions;
        const blank = conditions.find((c) => c.op !== "exists" && !String(c.value ?? "").trim());
        if (blank) throw badRequest(`Fill the condition on ${blank.field}: pass conditions with a value (the template leaves it blank).`, { conditions: "Blank value" });
        def = { name: args.name ?? t.name, description: args.description ?? t.summary, trigger: args.trigger ?? t.trigger, conditions, actions, requiresApproval: args.requiresApproval ?? false };
      } else {
        if (!args.name || !args.trigger || !args.actions) throw badRequest("Give a templateId, or name, trigger and actions", { templateId: "Or a full definition" });
        def = { name: args.name, description: args.description, trigger: args.trigger, conditions: args.conditions ?? [], actions: args.actions, requiresApproval: args.requiresApproval ?? false };
      }
      const input = parseWith(WorkflowInput, { ...def, enabled: false });
      const w = await deps.get(WorkflowsService).create(ctx, input);
      return { ...workflowBrief(w), explained: await describeWorkflow(ctx, deps, w), next: "It is OFF. Show the user what it does; turn it on with enable_workflow when they agree." };
    },
  }),

  defineTool({
    name: "update_workflow",
    title: "Update a workflow",
    description: "Changes a workflow's name, description, trigger, conditions, actions or approval setting (actions and conditions are replaced as a whole). Does not switch it on or off — use enable_workflow / disable_workflow.",
    input: WorkflowPatch.extend({ workflowId: uuid }),
    permission: "automation.write",
    risk: "write",
    handler: async (ctx, args, deps) => {
      const { workflowId, ...patch } = args;
      if (!Object.keys(patch).length) throw badRequest("Give at least one field to change");
      const w = await deps.get(WorkflowsService).update(ctx, workflowId, patch);
      return { ...workflowBrief(w), explained: await describeWorkflow(ctx, deps, w) };
    },
  }),

  defineTool({
    name: "enable_workflow",
    title: "Turn a workflow on",
    description: "Switches a workflow on: from then on it acts by itself on every matching event (assigning, tagging, creating tasks, enrolling people in sequences that email them…). The preview explains its trigger and actions.",
    input: z.object({ workflowId: uuid }),
    permission: "automation.write",
    risk: "important",
    preview: async (ctx, args, deps) => {
      const w = await deps.get(WorkflowsService).get(ctx, args.workflowId);
      if (w.enabled) throw conflict(`"${w.name}" is already on.`);
      await deps.get(EntitlementsService).assertFeature(ctx.workspace.billingAccountId, "automation");
      const explained = await describeWorkflow(ctx, deps, w);
      return {
        summary: `Turn on the workflow "${w.name}". From now on it runs automatically:\n${explained}`,
        details: { workflowId: w.id, name: w.name, trigger: w.trigger, actions: Array.isArray(w.actions) ? w.actions.length : 0, requiresApproval: w.requiresApproval },
      };
    },
    handler: async (ctx, args, deps) => {
      const w = await deps.get(WorkflowsService).update(ctx, args.workflowId, { enabled: true });
      return workflowBrief(w);
    },
  }),

  defineTool({
    name: "disable_workflow",
    title: "Turn a workflow off",
    description: "Switches a workflow off. Runs already waiting (on a delay or an approval) still finish; nothing new starts.",
    input: z.object({ workflowId: uuid }),
    permission: "automation.write",
    risk: "write",
    idempotent: true,
    handler: async (ctx, args, deps) => workflowBrief(await deps.get(WorkflowsService).update(ctx, args.workflowId, { enabled: false })),
  }),

  defineTool({
    name: "delete_workflow",
    title: "Delete a workflow",
    description: "Deletes a workflow; its runs still waiting (on a delay or an approval) are canceled. disable_workflow keeps it for later.",
    input: z.object({ workflowId: uuid }),
    permission: "automation.write",
    risk: "important",
    preview: async (ctx, args, deps) => {
      const w = await deps.get(WorkflowsService).get(ctx, args.workflowId);
      const waiting = await deps.prisma.db.workflowRun.count({ where: { workspaceId: ctx.workspace.id, workflowId: w.id, status: { in: ["pending", "waiting", "waiting_approval"] } } });
      return {
        summary: `Delete the workflow "${w.name}" (${w.enabled ? "on" : "off"}, ran ${w.runCount} times)${waiting ? ` and cancel its ${waiting} waiting run${waiting > 1 ? "s" : ""}` : ""}.`,
        details: { workflowId: w.id, name: w.name, enabled: w.enabled, waitingRuns: waiting },
      };
    },
    handler: async (ctx, args, deps) => deps.get(WorkflowsService).remove(ctx, args.workflowId),
  }),

  defineTool({
    name: "list_workflow_runs",
    title: "List workflow runs",
    description: "Recent workflow runs, newest first: which workflow, on what (contact / deal / task id), status and error. status waiting_approval lists runs held for approval.",
    input: z.object({
      workflowId: uuid.optional(),
      status: z.enum(["pending", "waiting_approval", "waiting", "running", "succeeded", "failed", "skipped", "canceled"]).optional(),
      ...pageInput,
    }),
    permission: "automation.read",
    risk: "read",
    handler: async (ctx, args, deps) => {
      const r = await deps.get(WorkflowsService).runs(ctx, { workflowId: args.workflowId, status: args.status }, args.page, args.limit);
      return paged(
        r.items.map((x) => ({ id: x.id, workflow: x.workflow, status: x.status, subjectType: x.subjectType, subjectId: x.subjectId, step: x.actionIndex, error: x.error ?? undefined, resumeAt: x.resumeAt ?? undefined, createdAt: x.createdAt, finishedAt: x.finishedAt ?? undefined })),
        r.total,
        args.page,
        args.limit,
      );
    },
  }),

  defineTool({
    name: "approve_workflow_run",
    title: "Approve a held workflow run",
    description: "Lets a run that is waiting for approval carry out its actions. The preview names the workflow, who it acts on and what it will do.",
    input: z.object({ runId: uuid }),
    permission: "automation.write",
    risk: "important",
    preview: async (ctx, args, deps) => {
      const db = deps.prisma.db;
      const run = await db.workflowRun.findFirst({ where: { id: args.runId, workspaceId: ctx.workspace.id }, include: { workflow: true } });
      if (!run) throw notFound("That workflow run");
      if (run.status !== "waiting_approval") throw conflict(`That run is ${run.status.replace("_", " ")}, not waiting for approval.`);
      let subject = `${run.subjectType} ${run.subjectId ?? ""}`.trim();
      if (run.subjectType === "contact" && run.subjectId) {
        const c = await db.contact.findFirst({ where: { id: run.subjectId, workspaceId: ctx.workspace.id }, select: { fullName: true, email: true } });
        if (c) subject = `${c.fullName || c.email}${c.email && c.fullName ? ` <${c.email}>` : ""}`;
      } else if (run.subjectType === "deal" && run.subjectId) {
        const d = await db.deal.findFirst({ where: { id: run.subjectId, workspaceId: ctx.workspace.id }, select: { name: true } });
        if (d) subject = `the deal "${d.name}"`;
      }
      const explained = await describeWorkflow(ctx, deps, run.workflow);
      return {
        summary: `Approve the "${run.workflow.name}" run for ${subject}. It will then carry out:\n${explained.split("\n").slice(1).filter((l) => /^\d+\./.test(l)).join("\n")}`,
        details: { runId: run.id, workflow: run.workflow.name, subjectType: run.subjectType, subjectId: run.subjectId },
      };
    },
    handler: async (ctx, args, deps) => {
      const r = await deps.get(WorkflowsService).approve(ctx, args.runId);
      return { runId: r.id, status: r.status, approved: true };
    },
  }),

  defineTool({
    name: "reject_workflow_run",
    title: "Reject a held workflow run",
    description: "Cancels a run that is waiting for approval; its actions never happen.",
    input: z.object({ runId: uuid }),
    permission: "automation.write",
    risk: "write",
    handler: async (ctx, args, deps) => {
      const r = await deps.get(WorkflowsService).reject(ctx, args.runId);
      return { runId: r.id, status: r.status, rejected: true };
    },
  }),
];

export const AUTOMATION_PROMPTS = [
  definePrompt({
    name: "setup_new_lead_automation",
    title: "Set up new-lead automation",
    description: "Every new lead gets an owner, a first-touch task and your always-on email sequence — built from templates, switched on only with your approval.",
    arguments: [{ name: "campaign", description: "The name (or id) of the outreach campaign new leads should enter, if you have one.", required: false }],
    render: (args, ctx) =>
      [
        `Set up automatic handling of new leads in "${ctx.workspace.name}".`,
        "",
        `1. Find the outreach campaign for new leads${args.campaign ? ` ("${args.campaign}")` : ""}: look for one that is running or always-on (the outreach campaign tools). If there is none, tell me what campaign to create (always-on, a short sequence) and stop there unless I ask you to build it.`,
        "2. list_workflow_templates (kind sales). Use \"sales-new-lead-sequence\" (new lead → tag and enroll) with that campaignId, and \"sales-round-robin\" (owner + first-touch task) unless I say otherwise.",
        "3. create_workflow for each — they are created switched off. Show me, in plain words, what each will do.",
        "4. Only when I agree: enable_workflow for each. These are important actions — show me the confirmation summary and wait for my explicit yes before confirm_action.",
        "5. Finally list_workflows to show what is on.",
      ].join("\n"),
  }),
];
