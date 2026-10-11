import { Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Res } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import type { Response } from "express";
import type { z } from "zod";
import {
  EmailPreferencesInput,
  PlatformAudienceInput,
  PlatformAudiencePreviewInput,
  PlatformAudienceUpdate,
  PlatformBroadcastInput,
  PlatformBroadcastScheduleInput,
  PlatformBroadcastsQuery,
  PlatformBroadcastUpdate,
  PlatformDripSequenceInput,
  PlatformDripSequenceUpdate,
  PlatformDripStepInput,
  PlatformDripStepOrderInput,
  PlatformDripStepUpdate,
  PlatformMarketingPreviewInput,
  PlatformSubscribersQuery,
  PlatformUnsubscribeInput,
} from "@growthdesk/shared";
import { AllowUnverified, Body, Ctx, Platform, Public, Query, Raw } from "../common/decorators.js";
import type { RequestContext } from "../common/context.js";
import { AudiencesService } from "./audiences.service.js";
import { BroadcastsService } from "./broadcasts.service.js";
import { SequencesService } from "./sequences.service.js";
import { SubscribersService } from "./subscribers.service.js";

/*
 * /v1/admin/growth/… — platform marketing to our own users.
 * support reads (and previews, which change nothing); admin writes. Every
 * write is audited (platform.growth_*).
 */
@ApiTags("admin")
@Controller("admin/growth")
export class PlatformGrowthAdminController {
  constructor(
    private readonly audiences: AudiencesService,
    private readonly broadcasts: BroadcastsService,
    private readonly sequences: SequencesService,
    private readonly subscribers: SubscribersService,
  ) {}

  // ─── Audiences ─────────────────────────────────────────────────────────────

  @Platform("support")
  @Get("audiences")
  listAudiences() {
    return this.audiences.list();
  }

  @Platform("support")
  @HttpCode(200)
  @Post("audiences/preview")
  previewAudience(@Body(PlatformAudiencePreviewInput) body: z.infer<typeof PlatformAudiencePreviewInput>) {
    return this.audiences.preview(body.filter);
  }

  @Platform("support")
  @Get("audiences/:id")
  audience(@Param("id") id: string) {
    return this.audiences.detail(id);
  }

  @Platform("admin")
  @Post("audiences")
  createAudience(@Ctx() ctx: RequestContext, @Body(PlatformAudienceInput) body: z.infer<typeof PlatformAudienceInput>) {
    return this.audiences.create(ctx, body);
  }

  @Platform("admin")
  @Patch("audiences/:id")
  updateAudience(@Ctx() ctx: RequestContext, @Param("id") id: string, @Body(PlatformAudienceUpdate) body: z.infer<typeof PlatformAudienceUpdate>) {
    return this.audiences.update(ctx, id, body);
  }

  @Platform("admin")
  @Delete("audiences/:id")
  deleteAudience(@Ctx() ctx: RequestContext, @Param("id") id: string) {
    return this.audiences.remove(ctx, id);
  }

  // ─── Content preview (broadcasts and steps) ────────────────────────────────

  @Platform("support")
  @HttpCode(200)
  @Post("preview")
  preview(@Body(PlatformMarketingPreviewInput) body: z.infer<typeof PlatformMarketingPreviewInput>) {
    return this.broadcasts.preview(body);
  }

  // ─── Broadcasts ────────────────────────────────────────────────────────────

  @Platform("support")
  @Get("broadcasts")
  listBroadcasts(@Query(PlatformBroadcastsQuery) q: z.infer<typeof PlatformBroadcastsQuery>) {
    return this.broadcasts.list(q.status);
  }

  @Platform("support")
  @Get("broadcasts/:id")
  broadcast(@Param("id") id: string) {
    return this.broadcasts.detail(id);
  }

  @Platform("support")
  @Get("broadcasts/:id/stats")
  broadcastStats(@Param("id") id: string) {
    return this.broadcasts.stats(id);
  }

  @Platform("admin")
  @Post("broadcasts")
  createBroadcast(@Ctx() ctx: RequestContext, @Body(PlatformBroadcastInput) body: z.infer<typeof PlatformBroadcastInput>) {
    return this.broadcasts.create(ctx, body);
  }

  @Platform("admin")
  @Patch("broadcasts/:id")
  updateBroadcast(@Ctx() ctx: RequestContext, @Param("id") id: string, @Body(PlatformBroadcastUpdate) body: z.infer<typeof PlatformBroadcastUpdate>) {
    return this.broadcasts.update(ctx, id, body);
  }

  @Platform("admin")
  @Delete("broadcasts/:id")
  deleteBroadcast(@Ctx() ctx: RequestContext, @Param("id") id: string) {
    return this.broadcasts.remove(ctx, id);
  }

  @Platform("admin")
  @HttpCode(200)
  @Post("broadcasts/:id/test")
  testBroadcast(@Ctx() ctx: RequestContext, @Param("id") id: string) {
    return this.broadcasts.test(ctx, id);
  }

  @Platform("admin")
  @HttpCode(200)
  @Post("broadcasts/:id/schedule")
  scheduleBroadcast(@Ctx() ctx: RequestContext, @Param("id") id: string, @Body(PlatformBroadcastScheduleInput) body: z.infer<typeof PlatformBroadcastScheduleInput>) {
    return this.broadcasts.schedule(ctx, id, body);
  }

  @Platform("admin")
  @HttpCode(200)
  @Post("broadcasts/:id/cancel")
  cancelBroadcast(@Ctx() ctx: RequestContext, @Param("id") id: string) {
    return this.broadcasts.cancel(ctx, id);
  }

  // ─── Sequences ─────────────────────────────────────────────────────────────

  @Platform("support")
  @Get("sequences")
  listSequences() {
    return this.sequences.list();
  }

  @Platform("support")
  @Get("sequences/:id")
  sequence(@Param("id") id: string) {
    return this.sequences.detail(id);
  }

  @Platform("support")
  @Get("sequences/:id/stats")
  sequenceStats(@Param("id") id: string) {
    return this.sequences.stats(id);
  }

  @Platform("admin")
  @Post("sequences")
  createSequence(@Ctx() ctx: RequestContext, @Body(PlatformDripSequenceInput) body: z.infer<typeof PlatformDripSequenceInput>) {
    return this.sequences.create(ctx, body);
  }

  @Platform("admin")
  @Patch("sequences/:id")
  updateSequence(@Ctx() ctx: RequestContext, @Param("id") id: string, @Body(PlatformDripSequenceUpdate) body: z.infer<typeof PlatformDripSequenceUpdate>) {
    return this.sequences.update(ctx, id, body);
  }

  @Platform("admin")
  @Delete("sequences/:id")
  deleteSequence(@Ctx() ctx: RequestContext, @Param("id") id: string) {
    return this.sequences.remove(ctx, id);
  }

  @Platform("admin")
  @HttpCode(200)
  @Post("sequences/:id/activate")
  activate(@Ctx() ctx: RequestContext, @Param("id") id: string) {
    return this.sequences.activate(ctx, id);
  }

  @Platform("admin")
  @HttpCode(200)
  @Post("sequences/:id/deactivate")
  deactivate(@Ctx() ctx: RequestContext, @Param("id") id: string) {
    return this.sequences.deactivate(ctx, id);
  }

  @Platform("admin")
  @Post("sequences/:id/steps")
  addStep(@Ctx() ctx: RequestContext, @Param("id") id: string, @Body(PlatformDripStepInput) body: z.infer<typeof PlatformDripStepInput>) {
    return this.sequences.addStep(ctx, id, body);
  }

  @Platform("admin")
  @Put("sequences/:id/steps/order")
  reorder(@Ctx() ctx: RequestContext, @Param("id") id: string, @Body(PlatformDripStepOrderInput) body: z.infer<typeof PlatformDripStepOrderInput>) {
    return this.sequences.reorder(ctx, id, body.stepIds);
  }

  @Platform("admin")
  @Patch("sequences/:id/steps/:stepId")
  updateStep(@Ctx() ctx: RequestContext, @Param("id") id: string, @Param("stepId") stepId: string, @Body(PlatformDripStepUpdate) body: z.infer<typeof PlatformDripStepUpdate>) {
    return this.sequences.updateStep(ctx, id, stepId, body);
  }

  @Platform("admin")
  @Delete("sequences/:id/steps/:stepId")
  deleteStep(@Ctx() ctx: RequestContext, @Param("id") id: string, @Param("stepId") stepId: string) {
    return this.sequences.deleteStep(ctx, id, stepId);
  }

  @Platform("admin")
  @HttpCode(200)
  @Post("sequences/:id/steps/:stepId/test")
  testStep(@Ctx() ctx: RequestContext, @Param("id") id: string, @Param("stepId") stepId: string) {
    return this.sequences.stepContent(id, stepId).then((content) => this.broadcasts.sendTest(ctx, content, `drip_step:${stepId}`));
  }

  // ─── Subscribers ───────────────────────────────────────────────────────────

  @Platform("support")
  @Get("subscribers")
  listSubscribers(@Query(PlatformSubscribersQuery) q: z.infer<typeof PlatformSubscribersQuery>) {
    return this.subscribers.list(q);
  }

  @Platform("admin")
  @HttpCode(200)
  @Post("subscribers/:userId/suppress")
  suppress(@Ctx() ctx: RequestContext, @Param("userId") userId: string) {
    return this.subscribers.suppress(ctx, userId);
  }

  @Platform("admin")
  @HttpCode(200)
  @Post("subscribers/:userId/unsuppress")
  unsuppress(@Ctx() ctx: RequestContext, @Param("userId") userId: string) {
    return this.subscribers.unsuppress(ctx, userId);
  }
}

/*
 * The product-email preference links in every broadcast and drip email
 * (signed token, no session). Reached as ${PUBLIC_APP_URL}/api/platform-mail/u/…
 * through the web app's /api → /v1 proxy; kept apart from the customer
 * campaign unsubscribe (/t/u/…, /unsubscribe) on purpose.
 *
 *   GET  /platform-mail/u/:token              → 302 to the preferences page
 *   GET  /platform-mail/u/:token/details      who and what — never changes anything
 *   POST /platform-mail/u/:token              unsubscribe: RFC 8058 one-click and the page's button
 *   POST /platform-mail/u/:token/resubscribe  the page's "subscribe again"
 *
 * GET never unsubscribes: scanners and spam filters follow every link.
 */
@ApiTags("platform-mail")
@Public()
@Controller("platform-mail/u")
export class PlatformUnsubscribeController {
  constructor(private readonly subscribers: SubscribersService) {}

  @Raw()
  @Get(":token")
  page(@Param("token") token: string, @Res() res: Response) {
    res.setHeader("cache-control", "no-store");
    res.setHeader("referrer-policy", "no-referrer");
    res.redirect(302, `/email-preferences/${encodeURIComponent(token)}`);
  }

  @Get(":token/details")
  details(@Param("token") token: string) {
    return this.subscribers.details(token);
  }

  @HttpCode(200)
  @Post(":token")
  unsubscribe(@Param("token") token: string, @Body(PlatformUnsubscribeInput) body: z.infer<typeof PlatformUnsubscribeInput>) {
    return this.subscribers.unsubscribe(token, body?.via === "page" ? "page" : "one_click");
  }

  @HttpCode(200)
  @Post(":token/resubscribe")
  resubscribe(@Param("token") token: string) {
    return this.subscribers.resubscribe(token);
  }
}

/** GET/PUT /v1/auth/me/email-preferences — the account page's "Product emails" toggle. */
@ApiTags("auth")
@Controller("auth/me/email-preferences")
export class EmailPreferencesController {
  constructor(private readonly subscribers: SubscribersService) {}

  @Get()
  get(@Ctx() ctx: RequestContext) {
    return this.subscribers.myPreferences(ctx);
  }

  /** Opting out must work before the address is confirmed too. */
  @AllowUnverified()
  @Put()
  put(@Ctx() ctx: RequestContext, @Body(EmailPreferencesInput) body: z.infer<typeof EmailPreferencesInput>) {
    return this.subscribers.setMyPreferences(ctx, body.marketingConsent);
  }
}
