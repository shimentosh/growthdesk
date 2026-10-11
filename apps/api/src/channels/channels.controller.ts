import { Controller, Delete, Get, HttpCode, Param, Post, Req as R, Res } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import type { Response } from "express";
import { z } from "zod";
import { TelegramConnectInput, WhatsAppConnectInput } from "@growthdesk/shared";
import { Body, Ctx, Permission, Public, Query, Raw } from "../common/decorators.js";
import { ws, type Req, type RequestContext } from "../common/context.js";
import { ChannelsService } from "./channels.service.js";

const ReachabilityQuery = z.object({ channel: z.enum(["whatsapp", "telegram"]), contactId: z.string().uuid() });
const StartLinkQuery = z.object({ contactId: z.string().uuid() });

@ApiTags("channels")
@Controller("workspaces/:workspaceId/channels")
export class ChannelsController {
  constructor(private readonly channels: ChannelsService) {}

  /** Connected WhatsApp / Telegram / calling integrations — status, capabilities, the webhook URL to configure; never secrets. */
  @Permission("integrations.read")
  @Get()
  list(@Ctx() ctx: RequestContext) {
    return this.channels.list(ctx);
  }

  @Permission("integrations.manage")
  @Post("whatsapp")
  connectWhatsApp(@Ctx() ctx: RequestContext, @Body(WhatsAppConnectInput) body: z.infer<typeof WhatsAppConnectInput>) {
    return this.channels.connectWhatsApp(ctx, body);
  }

  @Permission("integrations.manage")
  @Post("telegram")
  connectTelegram(@Ctx() ctx: RequestContext, @Body(TelegramConnectInput) body: z.infer<typeof TelegramConnectInput>) {
    return this.channels.connectTelegram(ctx, body);
  }

  /** Whether a chat send to this contact could work now (composer hint). */
  @Permission("inbox.read")
  @Get("reachability")
  reachability(@Ctx() ctx: RequestContext, @Query(ReachabilityQuery) q: z.infer<typeof ReachabilityQuery>) {
    return this.channels.reachability(ws(ctx).id, q.channel, q.contactId);
  }

  @Permission("integrations.manage")
  @HttpCode(200)
  @Post(":id/verify")
  verify(@Ctx() ctx: RequestContext, @Param("id") id: string) {
    return this.channels.verify(ctx, id);
  }

  /** A t.me start link that links the contact's Telegram chat to this contact when they press Start. */
  @Permission("inbox.reply", "contacts.write")
  @Get(":id/start-link")
  startLink(@Ctx() ctx: RequestContext, @Param("id") id: string, @Query(StartLinkQuery) q: z.infer<typeof StartLinkQuery>) {
    return this.channels.telegramStartLink(ctx, id, q.contactId);
  }

  @Permission("integrations.manage")
  @Delete(":id")
  remove(@Ctx() ctx: RequestContext, @Param("id") id: string) {
    return this.channels.remove(ctx, id);
  }
}

/*
 * Provider webhooks. Public (no session): each is authenticated by its own
 * mechanism — Meta's X-Hub-Signature-256 HMAC over the raw body, Telegram's
 * X-Telegram-Bot-Api-Secret-Token — and routed by the integration's random
 * webhook key. Reached as ${PUBLIC_APP_URL}/api/webhooks/... through the web
 * app's /api → /v1 proxy.
 */
@ApiTags("webhooks")
@Controller("webhooks")
export class ChannelWebhooksController {
  constructor(private readonly channels: ChannelsService) {}

  /** Meta's subscription handshake: hub.mode=subscribe&hub.verify_token=…&hub.challenge=… → the challenge, as text. */
  @Public()
  @Raw()
  @Get("whatsapp/:webhookKey")
  async whatsappHandshake(@Param("webhookKey") key: string, @R() req: Req, @Res() res: Response) {
    const q = req.query as Record<string, unknown> & { hub?: Record<string, unknown> };
    const pick = (k: string) => q[`hub.${k}`] ?? q.hub?.[k];
    const challenge = await this.channels.whatsappHandshake(key, pick("mode"), pick("verify_token"), pick("challenge"));
    res.status(200).type("text/plain").send(challenge);
  }

  @Public()
  @HttpCode(200)
  @Post("whatsapp/:webhookKey")
  whatsapp(@Param("webhookKey") key: string, @R() req: Req) {
    const sig = req.headers["x-hub-signature-256"];
    return this.channels.whatsappWebhook(key, req.rawBody, Array.isArray(sig) ? sig[0] : sig);
  }

  @Public()
  @HttpCode(200)
  @Post("telegram/:webhookKey")
  telegram(@Param("webhookKey") key: string, @R() req: Req) {
    const secret = req.headers["x-telegram-bot-api-secret-token"];
    return this.channels.telegramWebhook(key, Array.isArray(secret) ? secret[0] : secret, req.body);
  }
}
