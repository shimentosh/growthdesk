import { Injectable } from "@nestjs/common";
import type { z } from "zod";
import type { WorkflowInput } from "@growthdesk/shared";
import { Prisma, type WorkflowRunStatus } from "../generated/prisma/client.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { EntitlementsService } from "../billing/entitlements.service.js";
import { AuditService } from "../core/audit.service.js";
import { Queues } from "../queues/queues.js";
import { badRequest, conflict, notFound } from "../common/errors.js";
import { actorId, ws, type RequestContext } from "../common/context.js";
import { CONDITION_PATH } from "./conditions.js";
import { parseAction } from "./actions.js";

type WorkflowInputT = z.infer<typeof WorkflowInput>;

const MAX_WORKFLOWS = 100;

const RUN_STATUSES: WorkflowRunStatus[] = ["pending", "waiting_approval", "waiting", "running", "succeeded", "failed", "skipped", "canceled"];

function workflowDto(w: Prisma.WorkflowGetPayload<object>) {
  return {
    id: w.id,
    name: w.name,
    description: w.description,
    enabled: w.enabled,
    trigger: w.trigger,
    conditions: w.conditions,
    actions: w.actions,
    requiresApproval: w.requiresApproval,
    runCount: w.runCount,
    lastRunAt: w.lastRunAt,
    createdById: w.createdById,
    createdAt: w.createdAt,
    updatedAt: w.updatedAt,
  };
}

function runDto(r: Prisma.WorkflowRunGetPayload<object> & { workflow?: { id: string; name: string } | null }) {
  return {
    id: r.id,
    workflowId: r.workflowId,
    workflow: r.workflow ?? undefined,
    eventId: r.eventId,
    status: r.status,
    subjectType: r.subjectType,
    subjectId: r.subjectId,
    actionIndex: r.actionIndex,
    resumeAt: r.resumeAt,
    log: r.log,
    error: r.error,
    attempts: r.attempts,
    approvedById: r.approvedById,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    finishedAt: r.finishedAt,
  };
}

/** Workflow definitions and their runs, as the workspace sees them. Execution lives in WorkflowExecutor. */
@Injectable()
export class WorkflowsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService,
    private readonly queues: Queues,
  ) {}

  /** Refuses conditions and actions the executor could not run, and references to other workspaces. */
  private async validate(workspaceId: string, input: Partial<WorkflowInputT>) {
    for (const c of input.conditions ?? []) {
      if (!CONDITION_PATH.test(c.field)) {
        throw badRequest(`"${c.field}" is not a field a condition can read`, { conditions: `Unknown field ${c.field}` });
      }
      if (["gt", "lt"].includes(c.op) && !Number.isFinite(Number(c.value))) {
        throw badRequest(`"${c.op}" compares numbers; "${c.value}" is not one`, { conditions: "Not a number" });
      }
    }
    const userIds = new Set<string>();
    const campaignIds = new Set<string>();
    const enrollIds = new Set<string>();
    const listIds = new Set<string>();
    for (const raw of input.actions ?? []) {
      const parsed = parseAction(raw);
      if ("error" in parsed) throw badRequest(parsed.error, { actions: parsed.error });
      const a = parsed.action;
      if (a.type === "assign_contact") {
        if (a.config.userId) userIds.add(a.config.userId);
        for (const u of a.config.userIds ?? []) userIds.add(u);
      }
      if (a.type === "create_task" && a.config.assignTo !== "owner") userIds.add(a.config.assignTo);
      if (a.type === "notify") for (const u of a.config.userIds ?? []) userIds.add(u);
      if (a.type === "enroll_campaign") {
        campaignIds.add(a.config.campaignId);
        enrollIds.add(a.config.campaignId);
      }
      if (a.type === "stop_campaigns" && a.config.campaignId) campaignIds.add(a.config.campaignId);
      if (a.type === "add_to_list" || a.type === "remove_from_list") listIds.add(a.config.listId);
    }
    if (userIds.size) {
      const members = await this.prisma.db.membership.count({ where: { workspaceId, userId: { in: [...userIds] } } });
      if (members !== userIds.size) throw badRequest("Every person a workflow names must be a member of this workspace", { actions: "Unknown member" });
    }
    if (campaignIds.size) {
      const found = await this.prisma.db.campaign.count({ where: { workspaceId, id: { in: [...campaignIds] }, deletedAt: null } });
      if (found !== campaignIds.size) throw badRequest("A workflow can only name campaigns in this workspace", { actions: "Unknown campaign" });
    }
    if (listIds.size) {
      const found = await this.prisma.db.marketingList.count({ where: { workspaceId, id: { in: [...listIds] }, archivedAt: null } });
      if (found !== listIds.size) throw badRequest("A workflow can only use active lists in this workspace", { actions: "Unknown or archived list" });
    }
    if (enrollIds.size) {
      const closed = await this.prisma.db.campaign.findFirst({ where: { workspaceId, id: { in: [...enrollIds] }, status: { in: ["completed", "canceled"] } }, select: { name: true, status: true } });
      if (closed) {
        throw badRequest(`The campaign "${closed.name}" is ${closed.status} and takes no new contacts. Choose another, or duplicate it and turn on "Always on".`, { actions: "Closed campaign" });
      }
    }
  }

  async list(ctx: RequestContext) {
    const w = ws(ctx);
    const rows = await this.prisma.db.workflow.findMany({ where: { workspaceId: w.id, deletedAt: null }, orderBy: { createdAt: "desc" } });
    const waiting = await this.prisma.db.workflowRun.groupBy({
      by: ["workflowId"],
      where: { workspaceId: w.id, status: "waiting_approval" },
      _count: { _all: true },
    });
    const byId = new Map(waiting.map((r) => [r.workflowId, r._count._all]));
    return rows.map((r) => ({ ...workflowDto(r), awaitingApproval: byId.get(r.id) ?? 0 }));
  }

  private async find(workspaceId: string, id: string) {
    const row = await this.prisma.db.workflow.findFirst({ where: { id, workspaceId, deletedAt: null } });
    if (!row) throw notFound("That workflow");
    return row;
  }

  async get(ctx: RequestContext, id: string) {
    return workflowDto(await this.find(ws(ctx).id, id));
  }

  async create(ctx: RequestContext, input: WorkflowInputT) {
    const w = ws(ctx);
    await this.entitlements.assertFeature(w.billingAccountId, "automation");
    const count = await this.prisma.db.workflow.count({ where: { workspaceId: w.id, deletedAt: null } });
    if (count >= MAX_WORKFLOWS) throw conflict(`A workspace can hold up to ${MAX_WORKFLOWS} workflows; delete one first.`);
    await this.validate(w.id, input);
    const row = await this.prisma.db.workflow.create({
      data: {
        workspaceId: w.id,
        name: input.name,
        description: input.description ?? "",
        trigger: input.trigger,
        conditions: input.conditions as never,
        actions: input.actions as never,
        requiresApproval: input.requiresApproval,
        enabled: input.enabled,
        createdById: actorId(ctx),
      },
    });
    await this.audit.record(ctx, { action: "workflow.created", targetType: "workflow", targetId: row.id, metadata: { name: row.name, trigger: row.trigger } });
    return workflowDto(row);
  }

  async update(ctx: RequestContext, id: string, input: Partial<WorkflowInputT>) {
    const w = ws(ctx);
    const existing = await this.find(w.id, id);
    if (input.enabled === true) await this.entitlements.assertFeature(w.billingAccountId, "automation");
    await this.validate(w.id, input);
    const data: Prisma.WorkflowUpdateInput = {};
    if (input.name !== undefined) data.name = input.name;
    if (input.description !== undefined) data.description = input.description;
    if (input.trigger !== undefined) data.trigger = input.trigger;
    if (input.conditions !== undefined) data.conditions = input.conditions as never;
    if (input.actions !== undefined) data.actions = input.actions as never;
    if (input.requiresApproval !== undefined) data.requiresApproval = input.requiresApproval;
    if (input.enabled !== undefined) data.enabled = input.enabled;
    const row = await this.prisma.db.workflow.update({ where: { id: existing.id, workspaceId: w.id }, data });
    await this.audit.record(ctx, { action: "workflow.updated", targetType: "workflow", targetId: row.id, metadata: { fields: Object.keys(data) } });
    return workflowDto(row);
  }

  /** Soft delete. Runs still waiting (on a delay or an approval) are canceled with it. */
  async remove(ctx: RequestContext, id: string) {
    const w = ws(ctx);
    const existing = await this.find(w.id, id);
    await this.prisma.db.$transaction(async (tx) => {
      await tx.workflow.update({ where: { id: existing.id, workspaceId: w.id }, data: { deletedAt: new Date(), enabled: false } });
      await tx.workflowRun.updateMany({
        where: { workspaceId: w.id, workflowId: existing.id, status: { in: ["pending", "waiting", "waiting_approval"] } },
        data: { status: "canceled", finishedAt: new Date(), error: "The workflow was deleted" },
      });
    });
    await this.audit.record(ctx, { action: "workflow.deleted", targetType: "workflow", targetId: existing.id, metadata: { name: existing.name } });
    return { deleted: true };
  }

  async runsFor(ctx: RequestContext, workflowId: string, page: number, pageSize: number) {
    const w = ws(ctx);
    await this.find(w.id, workflowId);
    return this.runs(ctx, { workflowId }, page, pageSize);
  }

  async runs(ctx: RequestContext, filter: { workflowId?: string; status?: string }, page: number, pageSize: number) {
    const w = ws(ctx);
    if (filter.status && !RUN_STATUSES.includes(filter.status as WorkflowRunStatus)) {
      throw badRequest(`status must be one of: ${RUN_STATUSES.join(", ")}`);
    }
    const where: Prisma.WorkflowRunWhereInput = {
      workspaceId: w.id,
      ...(filter.workflowId ? { workflowId: filter.workflowId } : {}),
      ...(filter.status ? { status: filter.status as WorkflowRunStatus } : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.db.workflowRun.findMany({
        where,
        include: { workflow: { select: { id: true, name: true } } },
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.db.workflowRun.count({ where }),
    ]);
    return { items: items.map(runDto), total, page, pageSize };
  }

  /** Lets a run that was held for approval continue. */
  async approve(ctx: RequestContext, runId: string) {
    const w = ws(ctx);
    const res = await this.prisma.db.workflowRun.updateMany({
      where: { id: runId, workspaceId: w.id, status: "waiting_approval" },
      data: { status: "pending", approvedById: actorId(ctx) },
    });
    if (!res.count) throw await this.notWaiting(w.id, runId);
    await this.appendLog(w.id, runId, { step: "approval", status: "approved", by: actorId(ctx), at: new Date().toISOString() });
    await this.queues.add("automation", "run", { workspaceId: w.id, runId }, { jobId: `run-${runId}-approved`, attempts: 1 });
    await this.audit.record(ctx, { action: "workflow.run_approved", targetType: "workflow_run", targetId: runId });
    return runDto(await this.prisma.db.workflowRun.findFirstOrThrow({ where: { id: runId, workspaceId: w.id } }));
  }

  async reject(ctx: RequestContext, runId: string) {
    const w = ws(ctx);
    const res = await this.prisma.db.workflowRun.updateMany({
      where: { id: runId, workspaceId: w.id, status: "waiting_approval" },
      data: { status: "canceled", finishedAt: new Date(), error: "Rejected" },
    });
    if (!res.count) throw await this.notWaiting(w.id, runId);
    await this.appendLog(w.id, runId, { step: "approval", status: "rejected", by: actorId(ctx), at: new Date().toISOString() });
    await this.audit.record(ctx, { action: "workflow.run_rejected", targetType: "workflow_run", targetId: runId });
    return runDto(await this.prisma.db.workflowRun.findFirstOrThrow({ where: { id: runId, workspaceId: w.id } }));
  }

  private async notWaiting(workspaceId: string, runId: string) {
    const exists = await this.prisma.db.workflowRun.findFirst({ where: { id: runId, workspaceId }, select: { status: true } });
    return exists ? conflict(`That run is ${exists.status.replace("_", " ")}, not waiting for approval.`) : notFound("That workflow run");
  }

  private async appendLog(workspaceId: string, runId: string, entry: Record<string, unknown>) {
    const run = await this.prisma.db.workflowRun.findFirst({ where: { id: runId, workspaceId }, select: { log: true } });
    if (!run) return;
    const log = Array.isArray(run.log) ? [...(run.log as unknown[])] : [];
    log.push(entry);
    await this.prisma.db.workflowRun.update({ where: { id: runId, workspaceId }, data: { log: log as never } });
  }
}
