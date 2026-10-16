import { Injectable, Logger } from "@nestjs/common";
import type { Prisma, WorkflowRun } from "../generated/prisma/client.js";
import { PrismaService, type Tx } from "../prisma/prisma.service.js";
import { EntitlementsService } from "../billing/entitlements.service.js";
import { EventsService } from "../core/events.service.js";
import { NotificationsService } from "../notifications/notifications.service.js";
import { ActivityService } from "../crm/activity.service.js";
import { ContactsService } from "../crm/contacts.service.js";
import { SuppressionService } from "../crm/suppression.service.js";
import { EnrollmentService, SKIP_LABELS, SKIP_REASONS } from "../campaigns/enrollment.service.js";
import { Queues } from "../queues/queues.js";
import { queueConfirmations } from "../marketing/double-opt-in.js";
import { type Condition, type SubjectSnapshot, evaluateConditions } from "./conditions.js";
import { type ParsedAction, parseAction } from "./actions.js";
import { advanceStage } from "../crm/lifecycle.js";
import { runAs } from "../common/actor.js";

/** Runs at this depth or deeper (a workflow's action triggering another workflow, and so on) are not started. */
export const MAX_WORKFLOW_DEPTH = 3;
/** An action is tried this many times before the run fails. */
const MAX_ATTEMPTS = 3;
/** A run left "running" this long was abandoned by a crashed worker. */
const STALE_RUNNING_MS = 10 * 60_000;
const FAILURE_ALERT_WINDOW_MS = 60 * 60_000;

type ContactRow = Prisma.ContactGetPayload<{ include: { tags: { include: { tag: true } } } }>;
type DealRow = Prisma.DealGetPayload<{ include: { stage: true } }>;

type RunContext = {
  workspaceId: string;
  run: WorkflowRun;
  workflow: { id: string; name: string; createdById: string | null };
  contact: ContactRow | null;
  deal: DealRow | null;
  payload: Record<string, unknown>;
  depth: number;
};

type ActionOutcome = {
  status: "ok" | "skipped";
  detail: string;
  data?: Record<string, unknown>;
  /** Side effects that must wait until the action's transaction has committed. */
  after?: () => Promise<void>;
  emitted?: boolean;
};

/** An action that cannot succeed however often it is retried (a deleted campaign, a missing member). */
class PermanentActionError extends Error {}

type LogEntry = Record<string, unknown>;

/*
 * Executes workflow runs. The WorkflowRun row is the run's whole state —
 * which action is next (actionIndex), when a delay or a retry ends
 * (resumeAt), how many times the current action has failed (attempts) and
 * what happened so far (log) — so a duplicated, late or replayed job is
 * harmless: a run is claimed with a conditional update before anything
 * happens, and each action commits together with the progress it made.
 */
@Injectable()
export class WorkflowExecutor {
  private readonly log = new Logger("workflows");

  constructor(
    private readonly prisma: PrismaService,
    private readonly entitlements: EntitlementsService,
    private readonly events: EventsService,
    private readonly notifications: NotificationsService,
    private readonly activity: ActivityService,
    private readonly contacts: ContactsService,
    private readonly queues: Queues,
    private readonly enrollment: EnrollmentService,
    private readonly suppression: SuppressionService,
  ) {}

  /** Runs (or resumes) one run. Returns the status it was left in, or null when there was nothing to do. */
  async execute(workspaceId: string, runId: string, now = new Date()): Promise<WorkflowRun["status"] | null> {
    const claimed = await this.prisma.db.workflowRun.updateMany({
      where: { id: runId, workspaceId, OR: [{ status: "pending" }, { status: "waiting", resumeAt: { lte: now } }] },
      data: { status: "running" },
    });
    if (!claimed.count) return null;
    const run = await this.prisma.db.workflowRun.findFirstOrThrow({ where: { id: runId, workspaceId } });
    try {
      return await this.advance(run, now);
    } catch (e) {
      // Something outside an action broke (the database, a bug). Put the run back to be tried again.
      this.log.error(`run ${runId}: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
      const attempts = run.attempts + 1;
      if (attempts >= MAX_ATTEMPTS) {
        await this.finish(run, "failed", this.logOf(run), `Unexpected error: ${e instanceof Error ? e.message : String(e)}`.slice(0, 1000));
        return "failed";
      }
      await this.prisma.db.workflowRun.update({
        where: { id: run.id, workspaceId },
        data: { status: "waiting", attempts, resumeAt: new Date(Date.now() + backoffMs(attempts)) },
      });
      return "waiting";
    }
  }

  private logOf(run: WorkflowRun): LogEntry[] {
    return Array.isArray(run.log) ? [...(run.log as LogEntry[])] : [];
  }

  private async advance(run: WorkflowRun, now: Date): Promise<WorkflowRun["status"]> {
    const workspaceId = run.workspaceId;
    const log = this.logOf(run);
    const workflow = await this.prisma.db.workflow.findFirst({ where: { id: run.workflowId, workspaceId } });
    if (!workflow || workflow.deletedAt || !workflow.enabled) {
      return this.finish(run, "canceled", log, "The workflow was turned off or deleted before this run finished");
    }
    const workspace = await this.prisma.db.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { billingAccountId: true, status: true } });
    if (workspace.status === "suspended") return this.finish(run, "canceled", log, "The workspace is suspended");
    const ent = await this.entitlements.forAccount(workspace.billingAccountId);
    if (!ent.features.automation) {
      log.push({ step: "plan", status: "skipped", detail: `The ${ent.effectivePlan.name} plan does not include workflow automation`, at: now.toISOString() });
      return this.finish(run, "skipped", log, "");
    }

    const event = await this.prisma.db.domainEvent.findFirst({ where: { id: run.eventId, workspaceId } });
    const payload = (event?.payload && typeof event.payload === "object" ? event.payload : {}) as Record<string, unknown>;
    const depth = Number(payload.workflowDepth ?? 0) || 0;
    const { contact, deal } = await this.loadSubject(workspaceId, run, payload);
    const ctx: RunContext = { workspaceId, run, workflow, contact, deal, payload, depth };

    // 1. Conditions, once, before the first action.
    if (run.actionIndex === 0 && !log.some((l) => l.step === "conditions")) {
      const conditions = (Array.isArray(workflow.conditions) ? workflow.conditions : []) as Condition[];
      const result = evaluateConditions(conditions, snapshot(contact, deal, payload));
      log.push({ step: "conditions", met: result.met, ...(result.failed ? { failed: result.failed } : {}), at: now.toISOString() });
      if (!result.met) return this.finish(run, "skipped", log, "");
    }

    // 2. Approval, once.
    if (workflow.requiresApproval && !run.approvedById) {
      if (!log.some((l) => l.step === "approval" && l.status === "requested")) {
        log.push({ step: "approval", status: "requested", at: now.toISOString() });
      }
      await this.prisma.db.workflowRun.update({ where: { id: run.id, workspaceId }, data: { status: "waiting_approval", log: log as never } });
      const who = contact ? ` for ${contact.fullName || contact.email || "a contact"}` : "";
      await this.notifications.notifyRoles(workspaceId, ["owner", "admin"], {
        type: "workflow.approval",
        title: `Workflow "${workflow.name}" is waiting for approval${who}`,
        body: "Approve or reject the run from Automation → Runs.",
        link: `/w/${workspaceId}/automation/runs?run=${run.id}`,
      });
      return "waiting_approval";
    }

    // 3. Actions, from where the run left off.
    const actions = Array.isArray(workflow.actions) ? (workflow.actions as unknown[]) : [];
    // A run claimed after its resumeAt passed has already served the wait (a delay or a retry backoff) for the current action.
    let resumed = run.resumeAt !== null && run.resumeAt <= now;
    let attempts = run.attempts;
    for (let i = run.actionIndex; i < actions.length; i++) {
      const parsed = parseAction(actions[i]);
      const type = (actions[i] as { type?: string })?.type ?? "unknown";
      if ("error" in parsed) {
        log.push({ step: "action", index: i, type, status: "error", error: parsed.error, at: new Date().toISOString() });
        await this.notifyFailure(ctx, parsed.error);
        return this.finish(run, "failed", log, parsed.error, i);
      }
      const action = parsed.action;
      if (action.delayMinutes > 0 && !resumed) {
        const until = new Date(now.getTime() + action.delayMinutes * 60_000);
        log.push({ step: "action", index: i, type, status: "delayed", until: until.toISOString(), at: now.toISOString() });
        await this.prisma.db.workflowRun.update({
          where: { id: run.id, workspaceId },
          data: { status: "waiting", resumeAt: until, actionIndex: i, attempts: 0, log: log as never },
        });
        return "waiting";
      }
      resumed = false;

      let outcome: ActionOutcome;
      try {
        // Everything the action writes (timeline, audit) says this workflow did it — and who approved the run, if anyone.
        const actor = { type: "workflow" as const, id: ctx.workflow.id, name: ctx.workflow.name, ref: `workflow:${ctx.workflow.id}:run:${run.id}`, onBehalfOf: run.approvedById ? { id: run.approvedById } : null };
        outcome = await runAs(actor, () => this.prisma.db.$transaction(async (tx) => {
          const res = await this.runAction(tx, ctx, action);
          const entry: LogEntry = { step: "action", index: i, type, status: res.status, detail: res.detail, ...(res.data ? { data: res.data } : {}), at: new Date().toISOString() };
          await tx.workflowRun.update({
            where: { id: run.id, workspaceId },
            data: { actionIndex: i + 1, attempts: 0, resumeAt: null, error: "", log: [...log, entry] as never },
          });
          log.push(entry);
          return res;
        }));
      } catch (e) {
        const message = (e instanceof Error ? e.message : String(e)).slice(0, 1000);
        attempts += 1;
        log.push({ step: "action", index: i, type, status: "error", error: message, attempt: attempts, at: new Date().toISOString() });
        if (e instanceof PermanentActionError || attempts >= MAX_ATTEMPTS) {
          await this.notifyFailure(ctx, message);
          return this.finish(run, "failed", log, message, i, attempts);
        }
        if (!(e instanceof PermanentActionError)) this.log.warn(`run ${run.id} action ${i} (${type}) attempt ${attempts}: ${message}`);
        await this.prisma.db.workflowRun.update({
          where: { id: run.id, workspaceId },
          data: { status: "waiting", resumeAt: new Date(Date.now() + backoffMs(attempts)), attempts, actionIndex: i, error: message, log: log as never },
        });
        return "waiting";
      }
      attempts = 0;
      if (outcome.emitted) await this.events.kick();
      if (outcome.after) await outcome.after().catch((e) => this.log.warn(`run ${run.id} after-effect: ${e instanceof Error ? e.message : String(e)}`));
    }
    // A run whose every action was skipped (no email, already enrolled…) did nothing: say so instead of "succeeded".
    const ran = log.filter((e) => e.step === "action" && (e.status === "ok" || e.status === "skipped"));
    const allSkipped = ran.length > 0 && ran.every((e) => e.status === "skipped");
    return this.finish(run, allSkipped ? "skipped" : "succeeded", log, "", actions.length);
  }

  private async finish(run: WorkflowRun, status: "succeeded" | "failed" | "skipped" | "canceled", log: LogEntry[], error: string, actionIndex?: number, attempts?: number) {
    const now = new Date();
    await this.prisma.db.workflowRun.update({
      where: { id: run.id, workspaceId: run.workspaceId },
      data: {
        status,
        log: log as never,
        error,
        finishedAt: now,
        resumeAt: null,
        ...(actionIndex !== undefined ? { actionIndex } : {}),
        ...(attempts !== undefined ? { attempts } : {}),
      },
    });
    if (status === "succeeded" || status === "failed") {
      await this.prisma.db.workflow.updateMany({ where: { id: run.workflowId, workspaceId: run.workspaceId }, data: { runCount: { increment: 1 }, lastRunAt: now } });
    }
    return status;
  }

  private async notifyFailure(ctx: RunContext, message: string) {
    // One alert per workflow per hour: a big import into a broken workflow fails every run the same way.
    const title = `Workflow "${ctx.workflow.name}" failed`;
    const recent = await this.prisma.db.notification.findFirst({
      where: { workspaceId: ctx.workspaceId, type: "workflow.failed", title, createdAt: { gt: new Date(Date.now() - FAILURE_ALERT_WINDOW_MS) } },
      select: { id: true },
    });
    if (recent) return;
    const roles = await this.prisma.db.membership.findMany({ where: { workspaceId: ctx.workspaceId, role: { in: ["owner", "admin"] } }, select: { userId: true } });
    const ids = [...roles.map((r) => r.userId), ...(ctx.workflow.createdById ? [ctx.workflow.createdById] : [])];
    await this.notifications.notify(ctx.workspaceId, ids, {
      type: "workflow.failed",
      title,
      body: `${message.slice(0, 500)}\nFurther failures of this workflow in the next hour are in its run history, not notified.`,
      link: `/w/${ctx.workspaceId}/automation/runs?run=${ctx.run.id}`,
    });
  }

  private async loadSubject(workspaceId: string, run: WorkflowRun, payload: Record<string, unknown>) {
    const str = (v: unknown) => (typeof v === "string" && /^[0-9a-f-]{36}$/i.test(v) ? v : null);
    let contactId = run.subjectType === "contact" ? str(run.subjectId) : str(payload.contactId);
    let dealId = run.subjectType === "deal" ? str(run.subjectId) : str(payload.dealId);
    if (run.subjectType === "task" && str(run.subjectId)) {
      const task = await this.prisma.db.task.findFirst({ where: { id: run.subjectId, workspaceId }, select: { contactId: true, dealId: true } });
      contactId ??= task?.contactId ?? null;
      dealId ??= task?.dealId ?? null;
    }
    if ((run.subjectType === "conversation" || run.subjectType === "message") && !contactId && str(payload.conversationId ?? run.subjectId)) {
      const conversationId = str(payload.conversationId) ?? run.subjectId;
      const convo = await this.prisma.db.conversation.findFirst({ where: { id: conversationId, workspaceId }, select: { contactId: true, dealId: true } });
      contactId ??= convo?.contactId ?? null;
      dealId ??= convo?.dealId ?? null;
    }
    const deal = dealId ? await this.prisma.db.deal.findFirst({ where: { id: dealId, workspaceId, deletedAt: null }, include: { stage: true } }) : null;
    contactId ??= deal?.contactId ?? null;
    const contact = contactId
      ? await this.prisma.db.contact.findFirst({ where: { id: contactId, workspaceId, deletedAt: null }, include: { tags: { include: { tag: true } } } })
      : null;
    return { contact, deal };
  }

  // ─── Actions ───────────────────────────────────────────────────────────────

  private async runAction(tx: Tx, ctx: RunContext, action: ParsedAction): Promise<ActionOutcome> {
    switch (action.type) {
      case "assign_contact":
        return this.assignContact(tx, ctx, action.config);
      case "update_contact":
        return this.updateContact(tx, ctx, action.config);
      case "create_task":
        return this.createTask(tx, ctx, action.config);
      case "notify":
        return this.notify(tx, ctx, action.config);
      case "enroll_campaign":
        return this.enrollCampaign(tx, ctx, action.config);
      case "stop_campaigns":
        return this.stopCampaigns(tx, ctx, action.config);
      case "add_tag":
        return this.addTag(tx, ctx, action.config);
      case "add_to_list":
        return this.addToList(tx, ctx, action.config);
      case "remove_from_list":
        return this.removeFromList(tx, ctx, action.config);
      case "hand_to_sales":
        return this.handToSales(tx, ctx, action.config);
    }
  }

  private noContact(): ActionOutcome {
    return { status: "skipped", detail: "This event has no contact to act on" };
  }

  private eventPayload(ctx: RunContext, extra: Record<string, unknown>) {
    return { ...extra, workflowId: ctx.workflow.id, workflowRunId: ctx.run.id, workflowDepth: ctx.depth + 1 };
  }

  private async assignContact(tx: Tx, ctx: RunContext, config: Extract<ParsedAction, { type: "assign_contact" }>["config"]): Promise<ActionOutcome> {
    const contact = ctx.contact;
    if (!contact) return this.noContact();
    const current = await tx.contact.findFirst({ where: { id: contact.id, workspaceId: ctx.workspaceId }, select: { ownerId: true } });
    if (current?.ownerId && !config.overwrite) return { status: "skipped", detail: "The contact already has an owner" };

    let ownerId: string | null = null;
    if (config.strategy === "user") {
      const member = await tx.membership.findUnique({ where: { workspaceId_userId: { workspaceId: ctx.workspaceId, userId: config.userId! } } });
      if (!member) throw new PermanentActionError("The person this workflow assigns to is no longer a member of the workspace");
      ownerId = member.userId;
    } else {
      const members = await tx.membership.findMany({
        where: {
          workspaceId: ctx.workspaceId,
          ...(config.userIds?.length ? { userId: { in: config.userIds } } : { role: { in: ["owner", "admin", "manager", "member"] } }),
          user: { suspendedAt: null },
        },
        orderBy: [{ createdAt: "asc" }, { userId: "asc" }],
        select: { userId: true, deactivatedAt: true, user: { select: { outOfOfficeUntil: true } } },
      });
      const pool = members.map((m) => m.userId);
      if (!pool.length) throw new PermanentActionError("Nobody is left in this workflow's round-robin pool");
      // Paused members and people marked away keep their place in the turn order but are skipped.
      const now = Date.now();
      const present = new Set(members.filter((m) => !m.deactivatedAt && !(m.user.outOfOfficeUntil && m.user.outOfOfficeUntil.getTime() > now)).map((m) => m.userId));
      if (!present.size) return { status: "skipped", detail: "Everyone in the round-robin pool is away or paused" };
      // The last contact this workflow assigned tells us whose turn it is.
      const last = await tx.activity.findFirst({
        where: { workspaceId: ctx.workspaceId, type: "contact.assigned", data: { path: ["workflowId"], equals: ctx.workflow.id } },
        orderBy: { occurredAt: "desc" },
        select: { data: true },
      });
      const lastOwner = (last?.data as { ownerId?: string } | null)?.ownerId;
      const idx = lastOwner ? pool.indexOf(lastOwner) : -1;
      for (let step = 1; step <= pool.length; step++) {
        const candidate = pool[(idx + step) % pool.length]!;
        if (present.has(candidate)) {
          ownerId = candidate;
          break;
        }
      }
    }
    if (current?.ownerId === ownerId) return { status: "skipped", detail: "Already owned by that person" };
    await tx.contact.update({ where: { id: contact.id, workspaceId: ctx.workspaceId }, data: { ownerId } });
    await this.activity.log(
      { workspaceId: ctx.workspaceId, contactId: contact.id, type: "contact.assigned", summary: `Assigned by workflow "${ctx.workflow.name}"`, data: { ownerId, workflowId: ctx.workflow.id } },
      tx,
    );
    await this.events.emitIn(tx, {
      workspaceId: ctx.workspaceId,
      type: "contact.updated",
      subjectType: "contact",
      subjectId: contact.id,
      payload: this.eventPayload(ctx, { fields: ["ownerId"] }),
    });
    const name = contact.fullName || contact.email || "A contact";
    return {
      status: "ok",
      detail: "Owner assigned",
      data: { ownerId },
      emitted: true,
      after: () =>
        this.notifications.notify(ctx.workspaceId, [ownerId!], {
          type: "contact.assigned",
          title: `${name} was assigned to you`,
          body: `By workflow "${ctx.workflow.name}"`,
          link: `/w/${ctx.workspaceId}/contacts/${contact.id}`,
        }),
    };
  }

  private async updateContact(tx: Tx, ctx: RunContext, config: Extract<ParsedAction, { type: "update_contact" }>["config"]): Promise<ActionOutcome> {
    const contact = ctx.contact;
    if (!contact) return this.noContact();
    const fresh = await tx.contact.findFirst({ where: { id: contact.id, workspaceId: ctx.workspaceId, deletedAt: null } });
    if (!fresh) return { status: "skipped", detail: "The contact was deleted" };
    const data: Prisma.ContactUpdateInput = {};
    if (config.field.startsWith("custom.")) {
      const key = config.field.slice(7);
      data.customFields = { ...((fresh.customFields ?? {}) as object), [key]: config.value } as never;
    } else if (config.field === "leadSource") {
      data.leadSource = config.value;
    } else {
      (data as Record<string, unknown>)[config.field] = config.value;
    }
    if (config.field === "status" && fresh.doNotContact && config.value !== "do_not_contact") {
      return { status: "skipped", detail: "The contact is marked do-not-contact; its status is left alone" };
    }
    await tx.contact.update({ where: { id: fresh.id, workspaceId: ctx.workspaceId }, data });
    await this.activity.log(
      { workspaceId: ctx.workspaceId, contactId: fresh.id, type: "contact.updated", summary: `Workflow "${ctx.workflow.name}" set ${config.field} to ${config.value || "(blank)"}`, data: { workflowId: ctx.workflow.id } },
      tx,
    );
    if (config.field === "qualification" && config.value === "qualified" && fresh.qualification !== "qualified") {
      await this.events.emitIn(tx, { workspaceId: ctx.workspaceId, type: "contact.qualified", subjectType: "contact", subjectId: fresh.id, payload: this.eventPayload(ctx, {}) });
    }
    await this.events.emitIn(tx, {
      workspaceId: ctx.workspaceId,
      type: "contact.updated",
      subjectType: "contact",
      subjectId: fresh.id,
      payload: this.eventPayload(ctx, { fields: [config.field.startsWith("custom.") ? "customFields" : config.field] }),
    });
    return { status: "ok", detail: `${config.field} set to ${config.value || "(blank)"}`, emitted: true };
  }

  private async createTask(tx: Tx, ctx: RunContext, config: Extract<ParsedAction, { type: "create_task" }>["config"]): Promise<ActionOutcome> {
    let assigneeId: string | null = null;
    if (config.assignTo === "owner") {
      assigneeId = ctx.contact?.ownerId ?? ctx.deal?.ownerId ?? null;
      if (ctx.contact) {
        const fresh = await tx.contact.findFirst({ where: { id: ctx.contact.id, workspaceId: ctx.workspaceId }, select: { ownerId: true } });
        assigneeId = fresh?.ownerId ?? ctx.deal?.ownerId ?? null;
      }
    } else {
      const member = await tx.membership.findUnique({ where: { workspaceId_userId: { workspaceId: ctx.workspaceId, userId: config.assignTo } } });
      if (!member) throw new PermanentActionError("The person this workflow assigns tasks to is no longer a member of the workspace");
      assigneeId = member.userId;
    }
    const dueAt = config.dueInMinutes !== undefined ? new Date(Date.now() + config.dueInMinutes * 60_000) : null;
    const task = await tx.task.create({
      data: {
        workspaceId: ctx.workspaceId,
        type: config.type,
        title: config.title,
        description: config.description ?? "",
        priority: config.priority,
        dueAt,
        assigneeId,
        contactId: ctx.contact?.id ?? null,
        dealId: ctx.deal?.id ?? null,
        source: "automation",
      },
    });
    if (task.contactId) {
      await this.activity.log({ workspaceId: ctx.workspaceId, contactId: task.contactId, dealId: task.dealId, type: "task.created", summary: `Task: ${task.title} (workflow "${ctx.workflow.name}")` }, tx);
    }
    return {
      status: "ok",
      detail: `Task "${task.title}" created`,
      data: { taskId: task.id, assigneeId },
      after: assigneeId
        ? () =>
            this.notifications.notify(ctx.workspaceId, [assigneeId!], {
              type: "task.assigned",
              title: `New task: ${task.title}`,
              body: dueAt ? `Due ${dueAt.toISOString().slice(0, 16).replace("T", " ")} UTC` : "",
              link: `/w/${ctx.workspaceId}/tasks?task=${task.id}`,
            })
        : undefined,
    };
  }

  private async notify(tx: Tx, ctx: RunContext, config: Extract<ParsedAction, { type: "notify" }>["config"]): Promise<ActionOutcome> {
    const ids = new Set(config.userIds ?? []);
    if (config.roles?.length) {
      const members = await tx.membership.findMany({ where: { workspaceId: ctx.workspaceId, role: { in: config.roles } }, select: { userId: true } });
      for (const m of members) ids.add(m.userId);
    }
    if (config.contactOwner && ctx.contact?.ownerId) ids.add(ctx.contact.ownerId);
    if (!ids.size) return { status: "skipped", detail: "Nobody matched the people to notify" };
    const who = ctx.contact ? ctx.contact.fullName || ctx.contact.email || "a contact" : ctx.deal?.name ?? "";
    const title = config.title || `Workflow "${ctx.workflow.name}"${who ? `: ${who}` : ""}`;
    const link = ctx.contact ? `/w/${ctx.workspaceId}/contacts/${ctx.contact.id}` : ctx.deal ? `/w/${ctx.workspaceId}/deals/${ctx.deal.id}` : `/w/${ctx.workspaceId}/automation`;
    const recipients = [...ids];
    return {
      status: "ok",
      detail: `Notified ${recipients.length} ${recipients.length === 1 ? "person" : "people"}`,
      data: { userIds: recipients },
      after: () => this.notifications.notify(ctx.workspaceId, recipients, { type: "workflow.notify", title, body: config.message ?? "", link, email: config.email }),
    };
  }

  private async enrollCampaign(tx: Tx, ctx: RunContext, config: Extract<ParsedAction, { type: "enroll_campaign" }>["config"]): Promise<ActionOutcome> {
    const contact = ctx.contact;
    if (!contact) return this.noContact();
    const campaign = await tx.campaign.findFirst({ where: { id: config.campaignId, workspaceId: ctx.workspaceId, deletedAt: null } });
    if (!campaign) throw new PermanentActionError("The campaign this workflow enrolls into no longer exists");
    if (campaign.status !== "running" && campaign.status !== "paused" && campaign.status !== "scheduled") {
      throw new PermanentActionError(
        campaign.status === "draft"
          ? `The campaign "${campaign.name}" has not been launched yet; launch it (it may start empty when "Always on" is set)`
          : `The campaign "${campaign.name}" is ${campaign.status} and takes no new contacts. Turn on "Always on" in a campaign's settings so it stays open for new leads`,
      );
    }
    // The same path as a manual enrollment: eligibility (email only when the first step is an email),
    // the first step's delay, the daily new-contact limit and the gap between starts.
    const res = await this.enrollment.enroll(ctx.workspaceId, campaign, [contact.id], { source: "automation", enrolledById: null });
    if (!res.enrolled) {
      const reason = SKIP_REASONS.find((r) => (res.skipped[r] ?? 0) > 0);
      return { status: "skipped", detail: reason ? `Not enrolled: ${SKIP_LABELS[reason]}` : "Not enrolled" };
    }
    // EnrollmentService writes the contact's "Enrolled in the campaign" timeline entry.
    return { status: "ok", detail: `Enrolled in "${campaign.name}"`, data: { campaignId: campaign.id } };
  }

  private async stopCampaigns(tx: Tx, ctx: RunContext, config: Extract<ParsedAction, { type: "stop_campaigns" }>["config"]): Promise<ActionOutcome> {
    const contact = ctx.contact;
    if (!contact) return this.noContact();
    const res = await tx.enrollment.updateMany({
      where: { workspaceId: ctx.workspaceId, contactId: contact.id, status: { in: ["active", "paused"] }, ...(config.campaignId ? { campaignId: config.campaignId } : {}) },
      data: { status: "stopped", stopReason: "Stopped by workflow", nextRunAt: null },
    });
    if (res.count) {
      await this.activity.log(
        { workspaceId: ctx.workspaceId, contactId: contact.id, type: "campaign.stopped", summary: `Sequences stopped by workflow "${ctx.workflow.name}"`, data: { count: res.count, workflowId: ctx.workflow.id } },
        tx,
      );
    }
    return { status: "ok", detail: res.count ? `Stopped ${res.count} enrollment${res.count === 1 ? "" : "s"}` : "No active enrollments", data: { stopped: res.count } };
  }

  private async addTag(tx: Tx, ctx: RunContext, config: Extract<ParsedAction, { type: "add_tag" }>["config"]): Promise<ActionOutcome> {
    const contact = ctx.contact;
    if (!contact) return this.noContact();
    const names = [...new Set([...(config.tag ? [config.tag] : []), ...(config.tags ?? [])])];
    await this.contacts.tag(tx, ctx.workspaceId, [contact.id], names);
    return { status: "ok", detail: `Tagged ${names.join(", ")}`, data: { tags: names } };
  }

  /**
   * Subscribes the contact to a lead list, as "Add to list" does: never
   * re-adds someone who unsubscribed from it, refused consent or may not be
   * contacted. Only people with marketing consent count against the plan's
   * subscriber allowance (they are the ones marketing email reaches).
   */
  private async addToList(tx: Tx, ctx: RunContext, config: Extract<ParsedAction, { type: "add_to_list" }>["config"]): Promise<ActionOutcome> {
    const contact = ctx.contact;
    if (!contact) return this.noContact();
    const list = await tx.marketingList.findFirst({ where: { id: config.listId, workspaceId: ctx.workspaceId } });
    if (!list) throw new PermanentActionError("The list this workflow adds to no longer exists");
    if (list.archivedAt) throw new PermanentActionError(`The list "${list.name}" is archived; restore it to add people`);
    const fresh = await tx.contact.findFirst({ where: { id: contact.id, workspaceId: ctx.workspaceId, deletedAt: null } });
    if (!fresh) return { status: "skipped", detail: "The contact was deleted" };
    const held = await tx.listMembership.findFirst({ where: { workspaceId: ctx.workspaceId, listId: list.id, contactId: fresh.id }, select: { id: true, status: true } });
    if (held?.status === "subscribed") return { status: "skipped", detail: `Already on "${list.name}"` };
    if (held?.status === "unsubscribed") return { status: "skipped", detail: `Unsubscribed from "${list.name}"; not re-added` };
    const reason = fresh.doNotContact
      ? "marked do-not-contact"
      : fresh.consentStatus === "denied"
        ? "refused marketing consent"
        : fresh.email
          ? await this.suppression.check(ctx.workspaceId, { email: fresh.email }, tx, "marketing")
          : null;
    if (reason) return { status: "skipped", detail: `Not added: ${reason}` };

    // A double opt-in list takes someone without recorded consent as pending and emails them a link;
    // list.subscribed waits for their confirmation (DoubleOptInService). Still pending: the email goes again, at most once a day.
    if (list.doubleOptIn && fresh.consentStatus !== "granted") {
      if (!fresh.email) return { status: "skipped", detail: `Not added: "${list.name}" asks people to confirm by email, and the contact has no email address` };
      const pending =
        held ??
        (await tx.listMembership.create({ data: { workspaceId: ctx.workspaceId, listId: list.id, contactId: fresh.id, status: "pending", source: `Workflow "${ctx.workflow.name}"`.slice(0, 200) }, select: { id: true, status: true } }));
      if (!held) {
        await this.activity.log(
          { workspaceId: ctx.workspaceId, contactId: fresh.id, actorId: null, type: "marketing.pending", summary: `Added to the list ${list.name} by workflow "${ctx.workflow.name}"; waiting for them to confirm by email`, data: { listId: list.id, workflowId: ctx.workflow.id } },
          tx,
        );
      }
      return {
        status: "ok",
        detail: held ? `Still waiting to confirm "${list.name}"` : `Added to "${list.name}"; waiting for them to confirm by email`,
        data: { listId: list.id, pending: true },
        after: () => queueConfirmations(this.queues, ctx.workspaceId, [pending.id]),
      };
    }

    if (fresh.email && fresh.consentStatus === "granted") {
      const counted = await tx.listMembership.findFirst({ where: { workspaceId: ctx.workspaceId, contactId: fresh.id, status: "subscribed" }, select: { id: true } });
      if (!counted) {
        const workspace = await tx.workspace.findUniqueOrThrow({ where: { id: ctx.workspaceId }, select: { billingAccountId: true } });
        try {
          await this.entitlements.assertCapacityIn(tx, workspace.billingAccountId, "marketingContacts", 1);
        } catch (e) {
          throw new PermanentActionError(e instanceof Error ? e.message : "The plan's subscriber allowance is used up");
        }
      }
    }

    const now = new Date();
    const source = `Workflow "${ctx.workflow.name}"`.slice(0, 200);
    if (held) await tx.listMembership.update({ where: { id: held.id, workspaceId: ctx.workspaceId }, data: { status: "subscribed", source, subscribedAt: now, unsubscribedAt: null } });
    else await tx.listMembership.create({ data: { workspaceId: ctx.workspaceId, listId: list.id, contactId: fresh.id, status: "subscribed", source, subscribedAt: now } });
    await this.activity.log(
      { workspaceId: ctx.workspaceId, contactId: fresh.id, actorId: null, type: "marketing.subscribed", summary: `Added to the list ${list.name} by workflow "${ctx.workflow.name}"`, data: { listId: list.id, workflowId: ctx.workflow.id } },
      tx,
    );
    await this.events.emitIn(tx, {
      workspaceId: ctx.workspaceId,
      type: "list.subscribed",
      subjectType: "contact",
      subjectId: fresh.id,
      payload: this.eventPayload(ctx, { contactId: fresh.id, listId: list.id, listName: list.name, source: "workflow" }),
    });
    return { status: "ok", detail: `Added to "${list.name}"`, data: { listId: list.id }, emitted: true };
  }

  /**
   * Takes the contact off a list. An unsubscribe is kept as it is (it is the
   * person's own choice and stops a later re-add); anything else is removed,
   * as "Remove from list" on the list page does.
   */
  private async removeFromList(tx: Tx, ctx: RunContext, config: Extract<ParsedAction, { type: "remove_from_list" }>["config"]): Promise<ActionOutcome> {
    const contact = ctx.contact;
    if (!contact) return this.noContact();
    const list = await tx.marketingList.findFirst({ where: { id: config.listId, workspaceId: ctx.workspaceId } });
    if (!list) throw new PermanentActionError("The list this workflow removes from no longer exists");
    const held = await tx.listMembership.findFirst({ where: { workspaceId: ctx.workspaceId, listId: list.id, contactId: contact.id }, select: { id: true, status: true } });
    if (!held) return { status: "skipped", detail: `Not on "${list.name}"` };
    if (held.status === "unsubscribed") return { status: "skipped", detail: `Already unsubscribed from "${list.name}"` };
    await tx.listMembership.delete({ where: { id: held.id, workspaceId: ctx.workspaceId } });
    await this.activity.log(
      { workspaceId: ctx.workspaceId, contactId: contact.id, actorId: null, type: "marketing.removed", summary: `Removed from the list ${list.name} by workflow "${ctx.workflow.name}"`, data: { listId: list.id, workflowId: ctx.workflow.id } },
      tx,
    );
    return { status: "ok", detail: `Removed from "${list.name}"`, data: { listId: list.id } };
  }

  /**
   * Marketing → sales, as "Transfer to sales" does: the stage moves to In
   * sales (never back from Contact), an unqualified lead counts as qualified,
   * outreach sequences stop so a rep is not talking over them, and by default
   * the owner gets a task.
   */
  private async handToSales(tx: Tx, ctx: RunContext, config: Extract<ParsedAction, { type: "hand_to_sales" }>["config"]): Promise<ActionOutcome> {
    const contact = ctx.contact;
    if (!contact) return this.noContact();
    const fresh = await tx.contact.findFirst({ where: { id: contact.id, workspaceId: ctx.workspaceId, deletedAt: null }, select: { id: true, archivedAt: true } });
    if (!fresh) return { status: "skipped", detail: "The contact was deleted" };
    if (fresh.archivedAt) return { status: "skipped", detail: "The contact is archived" };
    const moved = await advanceStage(tx, ctx.workspaceId, [fresh.id], "sales");
    await tx.contact.updateMany({ where: { workspaceId: ctx.workspaceId, id: fresh.id, qualification: { in: ["unqualified", "qualifying"] } }, data: { qualification: "qualified" } });
    const stopped = await tx.enrollment.updateMany({
      where: { workspaceId: ctx.workspaceId, contactId: fresh.id, status: { in: ["active", "paused"] } },
      data: { status: "stopped", stopReason: "Handed to sales", nextRunAt: null },
    });
    if (moved) {
      await this.activity.log(
        { workspaceId: ctx.workspaceId, contactId: fresh.id, actorId: null, type: "contact.stage_changed", summary: `Handed to sales by workflow "${ctx.workflow.name}"`, data: { to: "sales", workflowId: ctx.workflow.id } },
        tx,
      );
    }
    const detail = [moved ? "Moved to In sales" : "Already in sales or a contact", stopped.count ? `stopped ${stopped.count} sequence${stopped.count === 1 ? "" : "s"}` : null].filter(Boolean).join("; ");
    if (!config.createTask) return { status: "ok", detail, data: { moved: moved > 0, stopped: stopped.count } };
    const task = await this.createTask(tx, ctx, { title: config.taskTitle, type: "follow_up", priority: "high", dueInMinutes: config.dueInMinutes, assignTo: "owner" });
    return { ...task, detail: `${detail}; ${task.detail}`, data: { ...task.data, moved: moved > 0, stopped: stopped.count } };
  }

  // ─── Sweeps ────────────────────────────────────────────────────────────────

  /**
   * Re-discovers runs that need a nudge: waits that have ended, approved or
   * new runs whose job was lost, and runs a crashed worker left "running".
   * Returns the run ids it queued.
   */
  async resumeDue(now = new Date(), limit = 500): Promise<{ workspaceId: string; runId: string }[]> {
    // Unscoped by necessity: the sweep looks across workspaces for due runs; each is then executed with its own workspace scope.
    await this.prisma.unscoped.workflowRun.updateMany({
      where: { status: "running", updatedAt: { lt: new Date(now.getTime() - STALE_RUNNING_MS) } },
      data: { status: "pending" },
    });
    const due = await this.prisma.unscoped.workflowRun.findMany({
      where: {
        OR: [
          { status: "waiting", resumeAt: { lte: now } },
          { status: "pending", updatedAt: { lt: new Date(now.getTime() - 2 * 60_000) } },
        ],
      },
      select: { id: true, workspaceId: true, resumeAt: true, updatedAt: true },
      orderBy: { updatedAt: "asc" },
      take: limit,
    });
    for (const r of due) {
      // The stamp makes each wake-up its own job (a completed job with the same id would swallow a re-add).
      const stamp = (r.resumeAt ?? r.updatedAt).getTime();
      await this.queues.add("automation", "run", { workspaceId: r.workspaceId, runId: r.id }, { jobId: `run-${r.id}-${stamp}`, attempts: 1 });
    }
    return due.map((r) => ({ workspaceId: r.workspaceId, runId: r.id }));
  }
}

/** 1 minute, 2 minutes, 4 minutes… */
const backoffMs = (attempt: number) => 60_000 * 2 ** Math.max(0, attempt - 1);

export function snapshot(contact: ContactRow | null, deal: DealRow | null, payload: Record<string, unknown>): SubjectSnapshot {
  return {
    contact: contact
      ? {
          status: contact.status,
          qualification: contact.qualification,
          priority: contact.priority,
          leadSource: contact.leadSource,
          tags: contact.tags.map((t) => t.tag.name),
          country: contact.country,
          ordersCount: contact.ordersCount,
          paidOrdersCount: contact.paidOrdersCount,
          totalSpent: Number(contact.totalSpent),
          custom: (contact.customFields ?? {}) as Record<string, unknown>,
        }
      : null,
    deal: deal ? { value: Number(deal.value), stage: deal.stage.name, status: deal.status } : null,
    event: payload,
  };
}
