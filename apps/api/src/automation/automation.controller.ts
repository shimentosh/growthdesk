import { Controller, Delete, Get, HttpCode, Param, Patch, Post } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { z } from "zod";
import { ListQuery, WebhookInput, WorkflowInput, patchOf } from "@growthdesk/shared";
import { Body, Ctx, Permission, Query } from "../common/decorators.js";
import type { RequestContext } from "../common/context.js";
import { WorkflowsService } from "./workflows.service.js";
import { WebhooksService } from "./webhooks.service.js";

const RunsQuery = ListQuery.extend({ status: z.string().max(40).optional(), workflowId: z.string().uuid().optional() });
const DeliveriesQuery = ListQuery.extend({ status: z.enum(["pending", "succeeded", "failed"]).optional() });
const WorkflowPatch = patchOf(WorkflowInput);
const WebhookPatch = patchOf(WebhookInput);

@ApiTags("automation")
@Controller("workspaces/:workspaceId")
export class AutomationController {
  constructor(
    private readonly workflows: WorkflowsService,
    private readonly webhooks: WebhooksService,
  ) {}

  // ─── Workflows ─────────────────────────────────────────────────────────────

  @Permission("automation.read")
  @Get("workflows")
  list(@Ctx() ctx: RequestContext) {
    return this.workflows.list(ctx);
  }

  @Permission("automation.write")
  @Post("workflows")
  create(@Ctx() ctx: RequestContext, @Body(WorkflowInput) body: z.infer<typeof WorkflowInput>) {
    return this.workflows.create(ctx, body);
  }

  @Permission("automation.read")
  @Get("workflows/:id")
  get(@Ctx() ctx: RequestContext, @Param("id") id: string) {
    return this.workflows.get(ctx, id);
  }

  @Permission("automation.write")
  @Patch("workflows/:id")
  update(@Ctx() ctx: RequestContext, @Param("id") id: string, @Body(WorkflowPatch) body: z.infer<typeof WorkflowPatch>) {
    return this.workflows.update(ctx, id, body);
  }

  @Permission("automation.write")
  @Delete("workflows/:id")
  remove(@Ctx() ctx: RequestContext, @Param("id") id: string) {
    return this.workflows.remove(ctx, id);
  }

  @Permission("automation.read")
  @Get("workflows/:id/runs")
  runsFor(@Ctx() ctx: RequestContext, @Param("id") id: string, @Query(ListQuery) q: z.infer<typeof ListQuery>) {
    return this.workflows.runsFor(ctx, id, q.page, q.pageSize);
  }

  @Permission("automation.read")
  @Get("workflow-runs")
  runs(@Ctx() ctx: RequestContext, @Query(RunsQuery) q: z.infer<typeof RunsQuery>) {
    return this.workflows.runs(ctx, { status: q.status, workflowId: q.workflowId }, q.page, q.pageSize);
  }

  @Permission("automation.write")
  @HttpCode(200)
  @Post("workflow-runs/:id/approve")
  approve(@Ctx() ctx: RequestContext, @Param("id") id: string) {
    return this.workflows.approve(ctx, id);
  }

  @Permission("automation.write")
  @HttpCode(200)
  @Post("workflow-runs/:id/reject")
  reject(@Ctx() ctx: RequestContext, @Param("id") id: string) {
    return this.workflows.reject(ctx, id);
  }

  // ─── Outgoing webhooks ─────────────────────────────────────────────────────

  @Permission("webhooks.manage")
  @Get("webhooks")
  listWebhooks(@Ctx() ctx: RequestContext) {
    return this.webhooks.list(ctx);
  }

  @Permission("webhooks.manage")
  @Post("webhooks")
  createWebhook(@Ctx() ctx: RequestContext, @Body(WebhookInput) body: z.infer<typeof WebhookInput>) {
    return this.webhooks.create(ctx, body);
  }

  @Permission("webhooks.manage")
  @Get("webhooks/:id")
  getWebhook(@Ctx() ctx: RequestContext, @Param("id") id: string) {
    return this.webhooks.get(ctx, id);
  }

  @Permission("webhooks.manage")
  @Patch("webhooks/:id")
  updateWebhook(@Ctx() ctx: RequestContext, @Param("id") id: string, @Body(WebhookPatch) body: z.infer<typeof WebhookPatch>) {
    return this.webhooks.update(ctx, id, body);
  }

  @Permission("webhooks.manage")
  @Delete("webhooks/:id")
  removeWebhook(@Ctx() ctx: RequestContext, @Param("id") id: string) {
    return this.webhooks.remove(ctx, id);
  }

  @Permission("webhooks.manage")
  @HttpCode(200)
  @Post("webhooks/:id/test")
  testWebhook(@Ctx() ctx: RequestContext, @Param("id") id: string) {
    return this.webhooks.test(ctx, id);
  }

  @Permission("webhooks.manage")
  @HttpCode(200)
  @Post("webhooks/:id/rotate-secret")
  rotateSecret(@Ctx() ctx: RequestContext, @Param("id") id: string) {
    return this.webhooks.rotateSecret(ctx, id);
  }

  @Permission("webhooks.manage")
  @Get("webhooks/:id/deliveries")
  deliveries(@Ctx() ctx: RequestContext, @Param("id") id: string, @Query(DeliveriesQuery) q: z.infer<typeof DeliveriesQuery>) {
    return this.webhooks.deliveries(ctx, id, q.page, q.pageSize, q.status);
  }
}
