import { Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Res } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import type { Response } from "express";
import { z } from "zod";
import {
  DiscordAppInput,
  DiscordConnectStartInput,
  DiscordCreateChannelInput,
  DiscordDeliveriesQuery,
  DiscordDestinationInput,
  DiscordDestinationPatch,
  DiscordDisconnectInput,
  DiscordRenameChannelInput,
  DiscordRuleInput,
  DiscordRuleTestInput,
  DiscordSettingsInput,
  DiscordTemplateInput,
  discordEventType,
} from "@growthdesk/shared";
import { Body, Ctx, Permission, Public, Query, Raw } from "../common/decorators.js";
import type { RequestContext } from "../common/context.js";
import { DiscordService } from "./discord.service.js";
import { DiscordRoutingService } from "./discord-routing.service.js";
import { DiscordDeliveryService } from "./discord-delivery.service.js";

const FieldsQuery = z.object({ types: z.string().max(2000).transform((s) => s.split(",").map((t) => t.trim()).filter((t) => discordEventType.safeParse(t).success).slice(0, 50)) });
const SampleQuery = z.object({ type: discordEventType, eventId: z.string().uuid().optional() });
const EnabledInput = z.object({ enabled: z.boolean() });

/*
 * Discord notifications for one workspace. Reading the setup needs
 * integrations.read; changing anything (connecting, channels, destinations,
 * rules, templates, settings, tests, retries) needs integrations.manage —
 * the same permissions as mailboxes and chat channels.
 */
@ApiTags("discord")
@Controller("workspaces/:workspaceId/discord")
export class DiscordController {
  constructor(
    private readonly discord: DiscordService,
    private readonly routing: DiscordRoutingService,
    private readonly deliveries: DiscordDeliveryService,
  ) {}

  @Permission("integrations.read")
  @Get()
  overview(@Ctx() ctx: RequestContext) {
    return this.discord.overview(ctx);
  }

  // ─── The workspace's own bot ──────────────────────────────────────────────

  @Permission("integrations.manage")
  @Put("app")
  saveApp(@Ctx() ctx: RequestContext, @Body(DiscordAppInput) body: z.infer<typeof DiscordAppInput>) {
    return this.discord.saveApp(ctx, body);
  }

  @Permission("integrations.manage")
  @Delete("app")
  removeApp(@Ctx() ctx: RequestContext) {
    return this.discord.removeApp(ctx);
  }

  // ─── Servers ──────────────────────────────────────────────────────────────

  @Permission("integrations.manage")
  @HttpCode(200)
  @Post("connect")
  connect(@Ctx() ctx: RequestContext, @Body(DiscordConnectStartInput) body: z.infer<typeof DiscordConnectStartInput>) {
    return this.discord.start(ctx, body.manageChannels);
  }

  @Permission("integrations.manage")
  @HttpCode(200)
  @Post("connections/:id/disconnect")
  disconnect(@Ctx() ctx: RequestContext, @Param("id") id: string, @Body(DiscordDisconnectInput) body: z.infer<typeof DiscordDisconnectInput>) {
    return this.discord.disconnect(ctx, id, body.leaveServer);
  }

  /** Reads the server live from Discord (and refreshes stored statuses). */
  @Permission("integrations.read")
  @Get("connections/:id/structure")
  structure(@Ctx() ctx: RequestContext, @Param("id") id: string) {
    return this.discord.structure(ctx, id);
  }

  @Permission("integrations.manage")
  @Post("connections/:id/channels")
  createChannel(@Ctx() ctx: RequestContext, @Param("id") id: string, @Body(DiscordCreateChannelInput) body: z.infer<typeof DiscordCreateChannelInput>) {
    return this.discord.createChannel(ctx, id, body);
  }

  @Permission("integrations.manage")
  @Patch("connections/:id/channels/:channelId")
  renameChannel(@Ctx() ctx: RequestContext, @Param("id") id: string, @Param("channelId") channelId: string, @Body(DiscordRenameChannelInput) body: z.infer<typeof DiscordRenameChannelInput>) {
    return this.discord.renameChannel(ctx, id, channelId, body.name);
  }

  // ─── Destinations ─────────────────────────────────────────────────────────

  @Permission("integrations.read")
  @Get("destinations")
  destinations(@Ctx() ctx: RequestContext) {
    return this.discord.destinations(ctx);
  }

  @Permission("integrations.manage")
  @Post("destinations")
  addDestination(@Ctx() ctx: RequestContext, @Body(DiscordDestinationInput) body: z.infer<typeof DiscordDestinationInput>) {
    return this.discord.addDestination(ctx, body);
  }

  @Permission("integrations.manage")
  @Patch("destinations/:id")
  updateDestination(@Ctx() ctx: RequestContext, @Param("id") id: string, @Body(DiscordDestinationPatch) body: z.infer<typeof DiscordDestinationPatch>) {
    return this.discord.updateDestination(ctx, id, body.group);
  }

  @Permission("integrations.manage")
  @Delete("destinations/:id")
  async removeDestination(@Ctx() ctx: RequestContext, @Param("id") id: string) {
    await this.discord.removeDestination(ctx, id);
    return { deleted: true };
  }

  // ─── Events ───────────────────────────────────────────────────────────────

  @Permission("integrations.read")
  @Get("events")
  events(@Ctx() ctx: RequestContext) {
    return this.routing.events(ctx);
  }

  /** Template variables for these event types (?types=deal.won,deal.lost). */
  @Permission("integrations.read")
  @Get("fields")
  fields(@Ctx() ctx: RequestContext, @Query(FieldsQuery) q: z.infer<typeof FieldsQuery>) {
    return this.routing.fields(ctx, q.types);
  }

  /** A real recent event's render context, else a sample one. */
  @Permission("integrations.read")
  @Get("sample")
  sample(@Ctx() ctx: RequestContext, @Query(SampleQuery) q: z.infer<typeof SampleQuery>) {
    return this.routing.sampleContext(ctx, q.type, q.eventId);
  }

  @Permission("integrations.read")
  @Get("recent-events")
  recent(@Ctx() ctx: RequestContext, @Query(SampleQuery) q: z.infer<typeof SampleQuery>) {
    return this.routing.recentEvents(ctx, q.type);
  }

  // ─── Rules ────────────────────────────────────────────────────────────────

  @Permission("integrations.read")
  @Get("rules")
  rules(@Ctx() ctx: RequestContext) {
    return this.routing.rules(ctx);
  }

  @Permission("integrations.manage")
  @Post("rules")
  createRule(@Ctx() ctx: RequestContext, @Body(DiscordRuleInput) body: z.infer<typeof DiscordRuleInput>) {
    return this.routing.createRule(ctx, body);
  }

  /** Tries an unsaved rule. Declared before rules/:id. */
  @Permission("integrations.manage")
  @HttpCode(200)
  @Post("rules/test")
  testDraft(@Ctx() ctx: RequestContext, @Body(DiscordRuleTestInput) body: z.infer<typeof DiscordRuleTestInput>) {
    return this.routing.test(ctx, body);
  }

  @Permission("integrations.manage")
  @Put("rules/:id")
  updateRule(@Ctx() ctx: RequestContext, @Param("id") id: string, @Body(DiscordRuleInput) body: z.infer<typeof DiscordRuleInput>) {
    return this.routing.updateRule(ctx, id, body);
  }

  @Permission("integrations.manage")
  @Patch("rules/:id")
  toggleRule(@Ctx() ctx: RequestContext, @Param("id") id: string, @Body(EnabledInput) body: z.infer<typeof EnabledInput>) {
    return this.routing.setRuleEnabled(ctx, id, body.enabled);
  }

  @Permission("integrations.manage")
  @Delete("rules/:id")
  async deleteRule(@Ctx() ctx: RequestContext, @Param("id") id: string) {
    await this.routing.deleteRule(ctx, id);
    return { deleted: true };
  }

  @Permission("integrations.manage")
  @HttpCode(200)
  @Post("rules/:id/test")
  testRule(@Ctx() ctx: RequestContext, @Param("id") id: string, @Body(DiscordRuleTestInput) body: z.infer<typeof DiscordRuleTestInput>) {
    return this.routing.test(ctx, body, id);
  }

  // ─── Templates ────────────────────────────────────────────────────────────

  @Permission("integrations.read")
  @Get("templates")
  templates(@Ctx() ctx: RequestContext) {
    return this.routing.templates(ctx);
  }

  @Permission("integrations.manage")
  @Post("templates")
  createTemplate(@Ctx() ctx: RequestContext, @Body(DiscordTemplateInput) body: z.infer<typeof DiscordTemplateInput>) {
    return this.routing.createTemplate(ctx, body);
  }

  @Permission("integrations.manage")
  @Put("templates/:id")
  updateTemplate(@Ctx() ctx: RequestContext, @Param("id") id: string, @Body(DiscordTemplateInput) body: z.infer<typeof DiscordTemplateInput>) {
    return this.routing.updateTemplate(ctx, id, body);
  }

  @Permission("integrations.manage")
  @Delete("templates/:id")
  async deleteTemplate(@Ctx() ctx: RequestContext, @Param("id") id: string) {
    await this.routing.deleteTemplate(ctx, id);
    return { deleted: true };
  }

  // ─── Settings ─────────────────────────────────────────────────────────────

  @Permission("integrations.manage")
  @Put("settings")
  settings(@Ctx() ctx: RequestContext, @Body(DiscordSettingsInput) body: z.infer<typeof DiscordSettingsInput>) {
    return this.routing.updateSettings(ctx, body);
  }

  @Permission("integrations.read")
  @Get("unrouted")
  unrouted(@Ctx() ctx: RequestContext) {
    return this.routing.unrouted(ctx);
  }

  @Permission("integrations.manage")
  @Delete("unrouted")
  async clearUnrouted(@Ctx() ctx: RequestContext) {
    await this.routing.clearUnrouted(ctx);
    return { cleared: true };
  }

  // ─── Deliveries ───────────────────────────────────────────────────────────

  @Permission("integrations.read")
  @Get("deliveries")
  listDeliveries(@Ctx() ctx: RequestContext, @Query(DiscordDeliveriesQuery) q: z.infer<typeof DiscordDeliveriesQuery>) {
    return this.deliveries.list(ctx, q);
  }

  /** Declared before deliveries/:id. */
  @Permission("integrations.manage")
  @HttpCode(200)
  @Post("deliveries/retry-failed")
  retryFailed(@Ctx() ctx: RequestContext) {
    return this.deliveries.retryFailed(ctx);
  }

  @Permission("integrations.read")
  @Get("deliveries/:id")
  delivery(@Ctx() ctx: RequestContext, @Param("id") id: string) {
    return this.deliveries.get(ctx, id);
  }

  @Permission("integrations.manage")
  @HttpCode(200)
  @Post("deliveries/:id/retry")
  retry(@Ctx() ctx: RequestContext, @Param("id") id: string) {
    return this.deliveries.retry(ctx, id);
  }
}

const CallbackQuery = z.object({
  code: z.string().max(4096).optional(),
  state: z.string().max(4096).optional(),
  guild_id: z.string().max(30).optional(),
  permissions: z.string().max(30).optional(),
  error: z.string().max(500).optional(),
  error_description: z.string().max(2000).optional(),
});

/**
 * Where Discord sends the browser back after adding the bot:
 * `${PUBLIC_APP_URL}/api/discord/oauth/callback` (the web app proxies /api to /v1),
 * registered as a redirect in the Discord application. Public because it is
 * reached by a redirect; the signed state plus the browser's own session
 * decide who and which workspace.
 */
@ApiTags("discord")
@Public()
@Raw()
@Controller("discord/oauth")
export class DiscordOAuthCallbackController {
  constructor(private readonly discord: DiscordService) {}

  @Get("callback")
  async callback(@Ctx() ctx: RequestContext, @Query(CallbackQuery) query: z.infer<typeof CallbackQuery>, @Res() res: Response) {
    const next = await this.discord.callback(query, ctx);
    res.setHeader("cache-control", "no-store");
    res.redirect(302, next);
  }
}
