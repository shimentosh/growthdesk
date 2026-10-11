import { Controller, Delete, Get, HttpCode, Param, Patch, Post } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import type { z } from "zod";
import { EnrollInput } from "@growthdesk/shared";
import { ApiKeyScope, Body, Ctx, Permission, Query } from "../common/decorators.js";
import type { RequestContext } from "../common/context.js";
import { CampaignCreateBody, CampaignListQuery, CampaignPatchBody, CampaignsService, EnrollmentListQuery } from "./campaigns.service.js";

@ApiTags("campaigns")
@Controller("workspaces/:workspaceId/campaigns")
export class CampaignsController {
  constructor(private readonly campaigns: CampaignsService) {}

  @ApiKeyScope("campaigns:read")
  @Permission("campaigns.read")
  @Get()
  list(@Ctx() ctx: RequestContext, @Query(CampaignListQuery) q: z.infer<typeof CampaignListQuery>) {
    return this.campaigns.list(ctx, q);
  }

  @Permission("campaigns.write")
  @Post()
  create(@Ctx() ctx: RequestContext, @Body(CampaignCreateBody) body: z.infer<typeof CampaignCreateBody>) {
    return this.campaigns.create(ctx, body);
  }

  @ApiKeyScope("campaigns:read")
  @Permission("campaigns.read")
  @Get(":id")
  get(@Ctx() ctx: RequestContext, @Param("id") id: string) {
    return this.campaigns.get(ctx, id);
  }

  @Permission("campaigns.write")
  @Patch(":id")
  update(@Ctx() ctx: RequestContext, @Param("id") id: string, @Body(CampaignPatchBody) body: z.infer<typeof CampaignPatchBody>) {
    return this.campaigns.update(ctx, id, body);
  }

  @Permission("campaigns.write")
  @Delete(":id")
  remove(@Ctx() ctx: RequestContext, @Param("id") id: string) {
    return this.campaigns.remove(ctx, id);
  }

  @Permission("campaigns.write")
  @Post(":id/duplicate")
  duplicate(@Ctx() ctx: RequestContext, @Param("id") id: string) {
    return this.campaigns.duplicate(ctx, id);
  }

  @Permission("campaigns.read")
  @Get(":id/readiness")
  readiness(@Ctx() ctx: RequestContext, @Param("id") id: string) {
    return this.campaigns.readiness(ctx, id);
  }

  @Permission("campaigns.read")
  @Get(":id/step-stats")
  stepStats(@Ctx() ctx: RequestContext, @Param("id") id: string) {
    return this.campaigns.stepStats(ctx, id);
  }

  @Permission("campaigns.launch")
  @HttpCode(200)
  @Post(":id/launch")
  launch(@Ctx() ctx: RequestContext, @Param("id") id: string) {
    return this.campaigns.launch(ctx, id);
  }

  @Permission("campaigns.launch")
  @HttpCode(200)
  @Post(":id/pause")
  pause(@Ctx() ctx: RequestContext, @Param("id") id: string) {
    return this.campaigns.pause(ctx, id);
  }

  @Permission("campaigns.launch")
  @HttpCode(200)
  @Post(":id/resume")
  resume(@Ctx() ctx: RequestContext, @Param("id") id: string) {
    return this.campaigns.resume(ctx, id);
  }

  @Permission("campaigns.launch")
  @HttpCode(200)
  @Post(":id/stop")
  stop(@Ctx() ctx: RequestContext, @Param("id") id: string) {
    return this.campaigns.stop(ctx, id);
  }

  @ApiKeyScope("campaigns:read")
  @Permission("campaigns.read")
  @Get(":id/enrollments")
  enrollments(@Ctx() ctx: RequestContext, @Param("id") id: string, @Query(EnrollmentListQuery) q: z.infer<typeof EnrollmentListQuery>) {
    return this.campaigns.enrollments(ctx, id, q);
  }

  // Enrolling starts sending to those contacts, so it needs the launch permission.
  @Permission("campaigns.launch")
  @HttpCode(200)
  @Post(":id/enroll")
  enroll(@Ctx() ctx: RequestContext, @Param("id") id: string, @Body(EnrollInput) body: z.infer<typeof EnrollInput>) {
    return this.campaigns.enroll(ctx, id, body.contactIds);
  }

  @Permission("campaigns.launch")
  @HttpCode(200)
  @Post(":id/enrollments/:enrollmentId/stop")
  stopEnrollment(@Ctx() ctx: RequestContext, @Param("id") id: string, @Param("enrollmentId") enrollmentId: string) {
    return this.campaigns.stopEnrollment(ctx, id, enrollmentId);
  }
}
