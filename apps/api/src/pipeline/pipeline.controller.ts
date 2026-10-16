import { Controller, Delete, Get, HttpCode, Module, Param, Patch, Post, Put, Query as Q } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { z } from "zod";
import { DealInput, MeetingInput, MoveDealInput, NoteInput, PipelineInput, TaskInput, ListQuery, TASK_TYPES, patchOf } from "@growthdesk/shared";
import { Body, Ctx, Permission, Query } from "../common/decorators.js";
import type { RequestContext } from "../common/context.js";
import { PipelineService } from "./pipeline.service.js";
import { TasksService, type TaskView } from "../tasks/tasks.service.js";
import { CrmExtrasService } from "../crm/crm-extras.service.js";

const DealListQuery = ListQuery.extend({
  pipelineId: z.string().uuid().optional(),
  status: z.enum(["open", "won", "lost"]).optional(),
  ownerId: z.string().max(40).optional(),
  contactId: z.string().uuid().optional(),
  q: z.string().max(200).optional(),
  /** Only open deals past their stage's "stale after" (forecast/progress.ts). */
  stale: z.enum(["true", "false"]).optional(),
  pageSize: z.coerce.number().int().min(1).max(1000).default(500),
});
const TaskListQuery = ListQuery.extend({
  view: z.enum(["today", "overdue", "upcoming", "completed", "mine", "team", "all"]).default("today"),
  assigneeId: z.string().max(40).optional(),
  contactId: z.string().uuid().optional(),
  dealId: z.string().uuid().optional(),
  type: z.enum(TASK_TYPES).optional(),
});

@ApiTags("pipeline")
@Controller("workspaces/:workspaceId")
export class PipelineController {
  constructor(
    private readonly pipeline: PipelineService,
    private readonly extras: CrmExtrasService,
  ) {}

  @Permission("deals.read")
  @Get("pipelines")
  pipelines(@Ctx() ctx: RequestContext) {
    return this.pipeline.pipelines(ctx);
  }

  @Permission("pipelines.manage")
  @Post("pipelines")
  createPipeline(@Ctx() ctx: RequestContext, @Body(PipelineInput) body: z.infer<typeof PipelineInput>) {
    return this.pipeline.createPipeline(ctx, body);
  }

  @Permission("pipelines.manage")
  @Put("pipelines/:id")
  updatePipeline(@Ctx() ctx: RequestContext, @Param("id") id: string, @Body(PipelineInput) body: z.infer<typeof PipelineInput>) {
    return this.pipeline.updatePipeline(ctx, id, body);
  }

  @Permission("pipelines.manage")
  @Delete("pipelines/:id")
  async archivePipeline(@Ctx() ctx: RequestContext, @Param("id") id: string) {
    await this.pipeline.archivePipeline(ctx, id);
    return { archived: true };
  }

  @Permission("deals.read")
  @Get("deals")
  deals(@Ctx() ctx: RequestContext, @Query(DealListQuery) q: z.infer<typeof DealListQuery>) {
    return this.pipeline.deals(ctx, { ...q, stale: q.stale === "true" }, q.page, q.pageSize);
  }

  @Permission("deals.write")
  @Post("deals")
  createDeal(@Ctx() ctx: RequestContext, @Body(DealInput) body: z.infer<typeof DealInput>) {
    return this.pipeline.createDeal(ctx, body);
  }

  @Permission("deals.read")
  @Get("deals/:id")
  deal(@Ctx() ctx: RequestContext, @Param("id") id: string) {
    return this.pipeline.deal(ctx, id);
  }

  @Permission("deals.write")
  @Patch("deals/:id")
  updateDeal(@Ctx() ctx: RequestContext, @Param("id") id: string, @Body(patchOf(DealInput)) body: Partial<z.infer<typeof DealInput>>) {
    return this.pipeline.updateDeal(ctx, id, body);
  }

  @Permission("deals.write")
  @HttpCode(200)
  @Post("deals/:id/move")
  async move(@Ctx() ctx: RequestContext, @Param("id") id: string, @Body(MoveDealInput) body: z.infer<typeof MoveDealInput>) {
    const deal = await this.pipeline.moveDeal(ctx, id, body.stageId, body.reason);
    // A nudge, not a rule: an open deal moved on without a next step says so, and the move still happens.
    return deal.status === "open" && !deal.nextStep.trim() ? { ...deal, warning: "This deal has no next step. Add one so it doesn't stall." } : deal;
  }

  @Permission("deals.delete")
  @Delete("deals/:id")
  async deleteDeal(@Ctx() ctx: RequestContext, @Param("id") id: string) {
    await this.pipeline.deleteDeal(ctx, id);
    return { deleted: true };
  }

  @Permission("deals.write")
  @Post("deals/:id/notes")
  addDealNote(@Ctx() ctx: RequestContext, @Param("id") id: string, @Body(NoteInput) body: z.infer<typeof NoteInput>) {
    return this.extras.addNote(ctx, { dealId: id }, body.body, body.pinned);
  }

  @Permission("deals.read")
  @Get("deals/:id/timeline")
  dealTimeline(@Ctx() ctx: RequestContext, @Param("id") id: string) {
    return this.extras.timeline(ctx, { dealId: id });
  }

  @Permission("deals.read", "contacts.read")
  @Get("meetings")
  meetings(@Ctx() ctx: RequestContext, @Q("from") from?: string, @Q("to") to?: string) {
    return this.pipeline.meetings(ctx, from ? new Date(from) : undefined, to ? new Date(to) : undefined);
  }

  @Permission("deals.write", "contacts.write")
  @Post("meetings")
  createMeeting(@Ctx() ctx: RequestContext, @Body(MeetingInput) body: z.infer<typeof MeetingInput>) {
    return this.pipeline.createMeeting(ctx, body);
  }

  @Permission("deals.write", "contacts.write")
  @Patch("meetings/:id")
  updateMeeting(@Ctx() ctx: RequestContext, @Param("id") id: string, @Body(patchOf(MeetingInput)) body: Partial<z.infer<typeof MeetingInput>>) {
    return this.pipeline.updateMeeting(ctx, id, body);
  }
}

@ApiTags("tasks")
@Controller("workspaces/:workspaceId/tasks")
export class TasksController {
  constructor(private readonly tasks: TasksService) {}

  @Permission("tasks.read")
  @Get()
  list(@Ctx() ctx: RequestContext, @Query(TaskListQuery) q: z.infer<typeof TaskListQuery>) {
    return this.tasks.list(ctx, q.view as TaskView, q);
  }

  @Permission("tasks.read")
  @Get("summary")
  summary(@Ctx() ctx: RequestContext) {
    return this.tasks.summary(ctx);
  }

  @Permission("tasks.write")
  @Post()
  create(@Ctx() ctx: RequestContext, @Body(TaskInput) body: z.infer<typeof TaskInput>) {
    return this.tasks.create(ctx, body);
  }

  @Permission("tasks.read")
  @Get(":id")
  get(@Ctx() ctx: RequestContext, @Param("id") id: string) {
    return this.tasks.get(ctx, id);
  }

  @Permission("tasks.write")
  @Patch(":id")
  update(@Ctx() ctx: RequestContext, @Param("id") id: string, @Body(patchOf(TaskInput)) body: Partial<z.infer<typeof TaskInput>>) {
    return this.tasks.update(ctx, id, body);
  }

  @Permission("tasks.write")
  @Delete(":id")
  async remove(@Ctx() ctx: RequestContext, @Param("id") id: string) {
    await this.tasks.remove(ctx, id);
    return { deleted: true };
  }
}

@Module({
  controllers: [PipelineController, TasksController],
  providers: [PipelineService, TasksService],
  exports: [PipelineService, TasksService],
})
export class PipelineModule {}
