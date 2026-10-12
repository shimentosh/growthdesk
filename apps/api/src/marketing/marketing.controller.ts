import { Controller, Delete, Get, HttpCode, Param, Patch, Post, Put } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { z } from "zod";
import {
  EmailDesignInput,
  EspConnectionInput,
  ListMembersAdd,
  ListMembersQuery,
  ListMembersRemove,
  MarketingAudience,
  MarketingCampaignInput,
  MarketingListInput,
  MarketingRecipientsQuery,
  MarketingSendInput,
  MarketingTestInput,
  SendingDomainInput,
  SendingDomainUpdate,
  patchOf,
} from "@growthdesk/shared";
import { Body, Ctx, Permission, Query } from "../common/decorators.js";
import type { RequestContext } from "../common/context.js";
import { ListsService } from "./lists.service.js";
import { MarketingSetupService } from "./setup.service.js";
import { DesignsService } from "./designs.service.js";
import { MarketingCampaignsService } from "./campaigns.service.js";

const Archive = z.object({ archived: z.boolean() });
const IncludeArchived = z.object({ archived: z.enum(["true", "false"]).optional() });

/*
 * Email marketing, per workspace. PATCH bodies go through patchOf(), so a
 * partial update never resets a field the client did not send
 * (docs/GAP_PLAN.md §0.7).
 */
@ApiTags("marketing")
@Controller("workspaces/:workspaceId/marketing")
export class MarketingController {
  constructor(
    private readonly lists: ListsService,
    private readonly setupService: MarketingSetupService,
    private readonly designs: DesignsService,
    private readonly campaigns: MarketingCampaignsService,
  ) {}

  // ─── Lists (lead lists: shared with outreach, so contact permissions also reach them) ────────────────────────────────────────────────────────────────

  @Permission("marketing.read", "contacts.read")
  @Get("lists")
  listLists(@Ctx() ctx: RequestContext, @Query(IncludeArchived) q: z.infer<typeof IncludeArchived>) {
    return this.lists.list(ctx, q.archived === "true");
  }

  @Permission("marketing.write", "contacts.write")
  @Post("lists")
  createList(@Ctx() ctx: RequestContext, @Body(MarketingListInput) body: z.infer<typeof MarketingListInput>) {
    return this.lists.create(ctx, body);
  }

  @Permission("marketing.read", "contacts.read")
  @Get("lists/:id")
  getList(@Ctx() ctx: RequestContext, @Param("id") id: string) {
    return this.lists.get(ctx, id);
  }

  @Permission("marketing.write", "contacts.write")
  @Patch("lists/:id")
  updateList(@Ctx() ctx: RequestContext, @Param("id") id: string, @Body(patchOf(MarketingListInput)) body: Partial<z.infer<typeof MarketingListInput>>) {
    return this.lists.update(ctx, id, body);
  }

  @Permission("marketing.write", "contacts.write")
  @HttpCode(200)
  @Post("lists/:id/archive")
  archiveList(@Ctx() ctx: RequestContext, @Param("id") id: string, @Body(Archive) body: z.infer<typeof Archive>) {
    return this.lists.archive(ctx, id, body.archived);
  }

  @Permission("marketing.read", "contacts.read")
  @Get("lists/:id/members")
  members(@Ctx() ctx: RequestContext, @Param("id") id: string, @Query(ListMembersQuery) q: z.infer<typeof ListMembersQuery>) {
    return this.lists.members(ctx, id, q);
  }

  @Permission("marketing.write", "contacts.write")
  @HttpCode(200)
  @Post("lists/:id/members")
  addMembers(@Ctx() ctx: RequestContext, @Param("id") id: string, @Body(ListMembersAdd) body: z.infer<typeof ListMembersAdd>) {
    return this.lists.addMembers(ctx, id, body);
  }

  @Permission("marketing.write", "contacts.write")
  @HttpCode(200)
  @Post("lists/:id/members/remove")
  removeMembers(@Ctx() ctx: RequestContext, @Param("id") id: string, @Body(ListMembersRemove) body: z.infer<typeof ListMembersRemove>) {
    return this.lists.removeMembers(ctx, id, body.contactIds);
  }

  @Permission("marketing.read", "contacts.read")
  @Get("contacts/:contactId/lists")
  contactLists(@Ctx() ctx: RequestContext, @Param("contactId") contactId: string) {
    return this.lists.forContact(ctx, contactId);
  }

  // ─── Sending setup ────────────────────────────────────────────────────────

  @Permission("marketing.read")
  @Get("setup")
  setup(@Ctx() ctx: RequestContext) {
    return this.setupService.setup(ctx);
  }

  @Permission("marketing.manage")
  @Put("esp")
  connectEsp(@Ctx() ctx: RequestContext, @Body(EspConnectionInput) body: z.infer<typeof EspConnectionInput>) {
    return this.setupService.connectEsp(ctx, body);
  }

  @Permission("marketing.manage")
  @Delete("esp")
  disconnectEsp(@Ctx() ctx: RequestContext) {
    return this.setupService.disconnectEsp(ctx);
  }

  @Permission("marketing.manage")
  @Post("domains")
  addDomain(@Ctx() ctx: RequestContext, @Body(SendingDomainInput) body: z.infer<typeof SendingDomainInput>) {
    return this.setupService.addDomain(ctx, body);
  }

  @Permission("marketing.manage")
  @Patch("domains/:id")
  updateDomain(@Ctx() ctx: RequestContext, @Param("id") id: string, @Body(SendingDomainUpdate) body: z.infer<typeof SendingDomainUpdate>) {
    return this.setupService.updateDomain(ctx, id, body);
  }

  @Permission("marketing.manage")
  @HttpCode(200)
  @Post("domains/:id/verify")
  verifyDomain(@Ctx() ctx: RequestContext, @Param("id") id: string) {
    return this.setupService.verifyDomain(ctx, id);
  }

  @Permission("marketing.manage")
  @Delete("domains/:id")
  removeDomain(@Ctx() ctx: RequestContext, @Param("id") id: string) {
    return this.setupService.removeDomain(ctx, id);
  }

  // ─── Designs ──────────────────────────────────────────────────────────────

  @Permission("marketing.read")
  @Get("designs")
  listDesigns(@Ctx() ctx: RequestContext) {
    return this.designs.list(ctx);
  }

  @Permission("marketing.write")
  @Post("designs")
  createDesign(@Ctx() ctx: RequestContext, @Body(EmailDesignInput) body: z.infer<typeof EmailDesignInput>) {
    return this.designs.create(ctx, body);
  }

  @Permission("marketing.read")
  @Get("designs/:id")
  getDesign(@Ctx() ctx: RequestContext, @Param("id") id: string) {
    return this.designs.get(ctx, id);
  }

  @Permission("marketing.write")
  @Patch("designs/:id")
  updateDesign(@Ctx() ctx: RequestContext, @Param("id") id: string, @Body(patchOf(EmailDesignInput)) body: Partial<z.infer<typeof EmailDesignInput>>) {
    return this.designs.update(ctx, id, body);
  }

  @Permission("marketing.write")
  @Post("designs/:id/duplicate")
  duplicateDesign(@Ctx() ctx: RequestContext, @Param("id") id: string) {
    return this.designs.duplicate(ctx, id);
  }

  @Permission("marketing.write")
  @Delete("designs/:id")
  archiveDesign(@Ctx() ctx: RequestContext, @Param("id") id: string) {
    return this.designs.archive(ctx, id);
  }

  // ─── Campaigns ────────────────────────────────────────────────────────────

  @Permission("marketing.read")
  @HttpCode(200)
  @Post("audience/count")
  audienceCount(@Ctx() ctx: RequestContext, @Body(MarketingAudience) body: z.infer<typeof MarketingAudience>) {
    return this.campaigns.audienceCount(ctx, body);
  }

  @Permission("marketing.read")
  @Get("campaigns")
  listCampaigns(@Ctx() ctx: RequestContext) {
    return this.campaigns.list(ctx);
  }

  @Permission("marketing.write")
  @Post("campaigns")
  createCampaign(@Ctx() ctx: RequestContext, @Body(MarketingCampaignInput) body: z.infer<typeof MarketingCampaignInput>) {
    return this.campaigns.create(ctx, body);
  }

  @Permission("marketing.read")
  @Get("campaigns/:id")
  getCampaign(@Ctx() ctx: RequestContext, @Param("id") id: string) {
    return this.campaigns.get(ctx, id);
  }

  @Permission("marketing.write")
  @Patch("campaigns/:id")
  updateCampaign(@Ctx() ctx: RequestContext, @Param("id") id: string, @Body(patchOf(MarketingCampaignInput)) body: Partial<z.infer<typeof MarketingCampaignInput>>) {
    return this.campaigns.update(ctx, id, body);
  }

  @Permission("marketing.write")
  @Post("campaigns/:id/duplicate")
  duplicateCampaign(@Ctx() ctx: RequestContext, @Param("id") id: string) {
    return this.campaigns.duplicate(ctx, id);
  }

  @Permission("marketing.write")
  @Delete("campaigns/:id")
  deleteCampaign(@Ctx() ctx: RequestContext, @Param("id") id: string) {
    return this.campaigns.remove(ctx, id);
  }

  @Permission("marketing.read")
  @Get("campaigns/:id/readiness")
  readiness(@Ctx() ctx: RequestContext, @Param("id") id: string) {
    return this.campaigns.readiness(ctx, id);
  }

  @Permission("marketing.send")
  @HttpCode(200)
  @Post("campaigns/:id/test")
  testSend(@Ctx() ctx: RequestContext, @Param("id") id: string, @Body(MarketingTestInput) body: z.infer<typeof MarketingTestInput>) {
    return this.campaigns.testSend(ctx, id, body.emails);
  }

  @Permission("marketing.send")
  @HttpCode(200)
  @Post("campaigns/:id/send")
  send(@Ctx() ctx: RequestContext, @Param("id") id: string, @Body(MarketingSendInput) body: z.infer<typeof MarketingSendInput>) {
    return this.campaigns.send(ctx, id, body.scheduledAt);
  }

  @Permission("marketing.send")
  @HttpCode(200)
  @Post("campaigns/:id/pause")
  pause(@Ctx() ctx: RequestContext, @Param("id") id: string) {
    return this.campaigns.pause(ctx, id);
  }

  @Permission("marketing.send")
  @HttpCode(200)
  @Post("campaigns/:id/resume")
  resume(@Ctx() ctx: RequestContext, @Param("id") id: string) {
    return this.campaigns.resume(ctx, id);
  }

  @Permission("marketing.send")
  @HttpCode(200)
  @Post("campaigns/:id/cancel")
  cancel(@Ctx() ctx: RequestContext, @Param("id") id: string) {
    return this.campaigns.cancel(ctx, id);
  }

  @Permission("marketing.read")
  @Get("campaigns/:id/recipients")
  recipients(@Ctx() ctx: RequestContext, @Param("id") id: string, @Query(MarketingRecipientsQuery) q: z.infer<typeof MarketingRecipientsQuery>) {
    return this.campaigns.recipients(ctx, id, q);
  }
}
