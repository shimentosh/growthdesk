import { Controller, Get, HttpCode, Logger, Param, Post, Req as R, Res } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import type { Response } from "express";
import { EspEventInput, PreferencesUpdate } from "@growthdesk/shared";
import type { z } from "zod";
import { Body, Public, Raw, parseWith } from "../common/decorators.js";
import type { Req } from "../common/context.js";
import { badRequest } from "../common/errors.js";
import { PIXEL_GIF } from "../tracking/tracking-rules.js";
import { MarketingPublicService } from "./public.service.js";

const PIXEL_LIMIT = { default: { limit: 5 * Number(process.env.RATE_LIMIT_PER_MINUTE ?? 600), ttl: 60_000 } };
const SNS_HOST = /^https:\/\/sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?\//;

type SnsEnvelope = { Type?: string; SubscribeURL?: string; Message?: string };
type SesNotification = {
  notificationType?: string;
  eventType?: string;
  bounce?: { bounceType?: string; bouncedRecipients?: { emailAddress?: string }[] };
  complaint?: { complainedRecipients?: { emailAddress?: string }[] };
  mail?: { messageId?: string; headers?: { name?: string; value?: string }[] };
};

/*
 * Public marketing endpoints, reached as ${PUBLIC_APP_URL}/api/m/... :
 *
 *   GET  /m/o/:token.gif          open pixel (always the GIF)
 *   GET  /m/c/:token              click: records, then 302 to the signed URL only
 *   GET  /m/u/:token              List-Unsubscribe link opened in a browser → preference page
 *   POST /m/u/:token              RFC 8058 one-click unsubscribe (from all marketing)
 *   GET  /m/p/:token              preference page details
 *   POST /m/p/:token              preference page changes
 *   POST /m/hooks/:webhookToken   bounces and complaints from the email service
 *
 * As with outreach, a GET never unsubscribes: link scanners follow GETs.
 */
@ApiTags("marketing-public")
@Public()
@Controller("m")
export class MarketingPublicController {
  private readonly log = new Logger("marketing-hooks");

  constructor(private readonly svc: MarketingPublicService) {}

  @Raw()
  @Throttle(PIXEL_LIMIT)
  @Get("o/:token")
  async open(@Param("token") token: string, @R() req: Req, @Res() res: Response) {
    await this.svc.open(token, { method: req.method, userAgent: String(req.headers["user-agent"] ?? "") });
    res.status(200).set({ "content-type": "image/gif", "cache-control": "no-store, no-cache, must-revalidate, private", pragma: "no-cache", expires: "0" }).send(PIXEL_GIF);
  }

  @Raw()
  @Get("c/:token")
  async click(@Param("token") token: string, @R() req: Req, @Res() res: Response) {
    const target = await this.svc.click(token, { method: req.method, userAgent: String(req.headers["user-agent"] ?? "") });
    res.setHeader("cache-control", "no-store");
    res.setHeader("referrer-policy", "no-referrer");
    res.redirect(302, target);
  }

  @Raw()
  @Get("u/:token")
  page(@Param("token") token: string, @Res() res: Response) {
    res.setHeader("cache-control", "no-store");
    res.setHeader("referrer-policy", "no-referrer");
    res.redirect(302, `/preferences/${encodeURIComponent(token)}`);
  }

  @HttpCode(200)
  @Post("u/:token")
  oneClick(@Param("token") token: string, @R() req: Req) {
    return this.svc.oneClick(token, req.ctx.ip, req.ctx.userAgent);
  }

  @Get("p/:token")
  details(@Param("token") token: string) {
    return this.svc.details(token);
  }

  @HttpCode(200)
  @Post("p/:token")
  update(@Param("token") token: string, @Body(PreferencesUpdate) body: z.infer<typeof PreferencesUpdate>, @R() req: Req) {
    return this.svc.update(token, body, req.ctx.ip, req.ctx.userAgent);
  }

  /**
   * Bounce and complaint notifications. Accepts Amazon SNS (SES notifications,
   * including the one-time subscription confirmation) and Growthdesk's own
   * JSON format (EspEventInput) for any other service. The secret path
   * segment authenticates the caller.
   */
  @HttpCode(200)
  @Post("hooks/:token")
  async hook(@Param("token") token: string, @R() req: Req) {
    const workspaceId = await this.svc.webhookWorkspace(token);
    const raw = req.rawBody?.toString("utf8") ?? (typeof req.body === "string" ? req.body : JSON.stringify(req.body ?? {}));
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      throw badRequest("The body must be JSON");
    }
    const sns = body as SnsEnvelope;
    if (sns.Type === "SubscriptionConfirmation") {
      if (!sns.SubscribeURL || !SNS_HOST.test(sns.SubscribeURL)) throw badRequest("Not an Amazon SNS subscription");
      const r = await fetch(sns.SubscribeURL, { redirect: "error", signal: AbortSignal.timeout(10_000) });
      this.log.log(`SNS subscription for workspace ${workspaceId}: ${r.status}`);
      return { confirmed: r.ok };
    }
    if (sns.Type === "Notification" && typeof sns.Message === "string") {
      const n = JSON.parse(sns.Message) as SesNotification;
      const kind = (n.notificationType ?? n.eventType ?? "").toLowerCase();
      const sendId = n.mail?.headers?.find((h) => h.name?.toLowerCase() === "x-growthdesk-send")?.value ?? null;
      const providerMessageId = n.mail?.messageId ?? null;
      let handled = 0;
      if (kind === "bounce") {
        const permanent = n.bounce?.bounceType === "Permanent";
        for (const r of n.bounce?.bouncedRecipients ?? []) {
          if (r.emailAddress) handled += Number((await this.svc.espEvent(workspaceId, { type: "bounce", permanent, email: r.emailAddress, providerMessageId, sendId })).matched);
        }
      } else if (kind === "complaint") {
        for (const r of n.complaint?.complainedRecipients ?? []) {
          if (r.emailAddress) handled += Number((await this.svc.espEvent(workspaceId, { type: "complaint", permanent: true, email: r.emailAddress, providerMessageId, sendId })).matched);
        }
      }
      return { handled };
    }
    const e = parseWith(EspEventInput, body);
    return this.svc.espEvent(workspaceId, { type: e.type, permanent: e.bounceType === "permanent", email: e.email, providerMessageId: e.providerMessageId, sendId: e.sendId });
  }
}
