import { Controller, Delete, Get, HttpCode, Param, Patch, Post, Req as R } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import type { z } from "zod";
import { AiAgentInput, AiAgentListQuery, AiCallContactInput, AiCallingSettingsPatch, AiTestCallInput, AiVoicesQuery, CartesiaConnectInput, patchOf } from "@growthdesk/shared";
import { Body, Ctx, Permission, Public, Query } from "../common/decorators.js";
import type { Req, RequestContext } from "../common/context.js";
import { AiAgentsService } from "./ai-agents.service.js";
import { AiCallsService } from "./ai-calls.service.js";

@ApiTags("ai-calling")
@Controller("workspaces/:workspaceId/ai-calling")
export class AiCallingController {
  constructor(private readonly calls: AiCallsService) {}

  /** The Cartesia connection (never its key), whether AI calls can be placed now, and why not. */
  @Permission("calls.read")
  @Get("setup")
  setup(@Ctx() ctx: RequestContext) {
    return this.calls.setup(ctx);
  }

  /** Connect (or reconnect) Cartesia: the key is checked, the webhook registered. Verify / disconnect: POST /channels/:id/verify, DELETE /channels/:id. */
  @Permission("integrations.manage")
  @Post("cartesia")
  connect(@Ctx() ctx: RequestContext, @Body(CartesiaConnectInput) body: z.infer<typeof CartesiaConnectInput>) {
    return this.calls.connect(ctx, body);
  }

  /** The caller number, calling hours and days, and the gap between calls to one person. */
  @Permission("integrations.manage")
  @Patch("settings")
  settings(@Ctx() ctx: RequestContext, @Body(AiCallingSettingsPatch) body: z.infer<typeof AiCallingSettingsPatch>) {
    return this.calls.updateSettings(ctx, body);
  }

  @Permission("calls.read")
  @Get("voices")
  voices(@Ctx() ctx: RequestContext, @Query(AiVoicesQuery) q: z.infer<typeof AiVoicesQuery>) {
    return this.calls.voices(ctx, q);
  }
}

@ApiTags("ai-calling")
@Controller("workspaces/:workspaceId/call-agents")
export class CallAgentsController {
  constructor(
    private readonly agents: AiAgentsService,
    private readonly calls: AiCallsService,
  ) {}

  @Permission("calls.read")
  @Get()
  list(@Ctx() ctx: RequestContext, @Query(AiAgentListQuery) q: z.infer<typeof AiAgentListQuery>) {
    return this.agents.list(ctx, q);
  }

  @Permission("calls.agents")
  @Post()
  create(@Ctx() ctx: RequestContext, @Body(AiAgentInput) body: z.infer<typeof AiAgentInput>) {
    return this.agents.create(ctx, body);
  }

  /** The agent, its call stats, where it is used, and the exact prompt the voice model runs on. */
  @Permission("calls.read")
  @Get(":id")
  get(@Ctx() ctx: RequestContext, @Param("id") id: string) {
    return this.agents.get(ctx, id);
  }

  @Permission("calls.agents")
  @Patch(":id")
  update(@Ctx() ctx: RequestContext, @Param("id") id: string, @Body(patchOf(AiAgentInput)) body: Partial<z.infer<typeof AiAgentInput>>) {
    return this.agents.update(ctx, id, body);
  }

  @Permission("calls.agents")
  @HttpCode(200)
  @Post(":id/sync")
  sync(@Ctx() ctx: RequestContext, @Param("id") id: string) {
    return this.agents.sync(ctx, id);
  }

  @Permission("calls.agents")
  @Post(":id/duplicate")
  duplicate(@Ctx() ctx: RequestContext, @Param("id") id: string) {
    return this.agents.duplicate(ctx, id);
  }

  /** Archive (calls keep their history). Refused while a live campaign step uses it. */
  @Permission("calls.agents")
  @Delete(":id")
  archive(@Ctx() ctx: RequestContext, @Param("id") id: string) {
    return this.agents.archive(ctx, id);
  }

  @Permission("calls.agents")
  @HttpCode(200)
  @Post(":id/restore")
  restore(@Ctx() ctx: RequestContext, @Param("id") id: string) {
    return this.agents.restore(ctx, id);
  }

  /** The agent rings a phone the person vouches for (their own), with sample values for the script. */
  @Permission("calls.make")
  @Post(":id/test-call")
  testCall(@Ctx() ctx: RequestContext, @Param("id") id: string, @Body(AiTestCallInput) body: z.infer<typeof AiTestCallInput>) {
    return this.calls.testCall(ctx, id, body);
  }

  /** One AI call to one contact now, under the same rules as a campaign step (consent, hours, do-not-contact). */
  @Permission("calls.make")
  @Post(":id/call")
  call(@Ctx() ctx: RequestContext, @Param("id") id: string, @Body(AiCallContactInput) body: z.infer<typeof AiCallContactInput>) {
    return this.calls.callContact(ctx, id, body.contactId);
  }
}

/*
 * Cartesia's call events. Public (no session): authenticated by the shared
 * secret in X-Webhook-Secret and routed by the connection's random key.
 * Reached as ${PUBLIC_APP_URL}/api/webhooks/cartesia/<key> through the web
 * app's /api → /v1 proxy.
 */
@ApiTags("webhooks")
@Controller("webhooks/cartesia/:webhookKey")
export class CartesiaWebhooksController {
  constructor(private readonly calls: AiCallsService) {}

  @Public()
  @HttpCode(200)
  @Post()
  receive(@Param("webhookKey") key: string, @R() req: Req) {
    const header = req.headers["x-webhook-secret"];
    return this.calls.webhook(key, Array.isArray(header) ? header[0] : header, req.body);
  }
}
