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
import { parseEspWebhook } from "./esp-webhooks.js";
import { MarketingPublicService } from "./public.service.js";
import { MarketingAssetsService } from "./assets.service.js";
import { DoubleOptInService } from "./double-opt-in.service.js";
import { extensionFor } from "../site/asset-rules.js";

const PIXEL_LIMIT = { default: { limit: 5 * Number(process.env.RATE_LIMIT_PER_MINUTE ?? 600), ttl: 60_000 } };
const SNS_HOST = /^https:\/\/sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?\//;

type ResendEvent = { type?: unknown; data?: { email_id?: string; to?: string[] | string; bounce?: { type?: string } } };

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
 *   GET  /m/s/:token              double opt-in confirmation page details
 *   POST /m/s/:token              double opt-in: the person pressed "Confirm"
 *   GET  /m/assets/:id.:ext       an image uploaded for marketing emails
 *   POST /m/hooks/:webhookToken   bounces, complaints and unsubscribes from the email service
 *
 * As with outreach, a GET never unsubscribes — nor confirms a subscription:
 * link scanners follow GETs.
 */
@ApiTags("marketing-public")
@Public()
@Controller("m")
export class MarketingPublicController {
  private readonly log = new Logger("marketing-hooks");

  constructor(
    private readonly svc: MarketingPublicService,
    private readonly assets: MarketingAssetsService,
    private readonly doubleOptIn: DoubleOptInService,
  ) {}

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

  @Get("s/:token")
  confirmDetails(@Param("token") token: string) {
    return this.doubleOptIn.details(token);
  }

  @HttpCode(200)
  @Post("s/:token")
  confirm(@Param("token") token: string, @R() req: Req) {
    return this.doubleOptIn.confirm(token, req.ctx.ip, req.ctx.userAgent);
  }

  /** Never SVG (refused at upload); served with the sniffed type, nosniff, and a CSP that runs nothing. */
  @Raw()
  @Throttle(PIXEL_LIMIT)
  @Get("assets/:file")
  async asset(@Param("file") file: string, @R() req: Req, @Res() res: Response) {
    const a = await this.assets.serve(file);
    const etag = `"${a.sha256}"`;
    res.set({
      "content-type": a.contentType,
      "content-length": String(a.size),
      // The id never points at different bytes: every upload is a new row.
      "cache-control": "public, max-age=31536000, immutable",
      etag,
      "x-content-type-options": "nosniff",
      "content-disposition": `inline; filename="image.${extensionFor(a.contentType)}"`,
      "content-security-policy": "default-src 'none'; sandbox",
      "cross-origin-resource-policy": "cross-origin",
    });
    if (req.headers["if-none-match"] === etag) {
      res.status(304).end();
      return;
    }
    res.status(200).end(Buffer.from(a.bytes));
  }

  /**
   * Bounce and complaint notifications. Accepts Amazon SNS (SES notifications,
   * including the one-time subscription confirmation), Resend webhooks
   * (email.bounced / email.complained), Postmark, SendGrid and Mailgun
   * bounce/complaint/unsubscribe webhooks (esp-webhooks.ts) and Growthdesk's
   * own JSON format (EspEventInput) for any other service. The secret path
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
    // Resend (Svix-delivered): { type: "email.bounced" | "email.complained" | …, data: { email_id, to: [...], bounce?: { type } } }.
    const resend = body as ResendEvent;
    if (typeof resend.type === "string" && resend.type.startsWith("email.") && resend.data && typeof resend.data === "object") {
      const kind = resend.type === "email.bounced" ? "bounce" : resend.type === "email.complained" ? "complaint" : null;
      if (!kind) return { handled: 0 };
      // Resend relays the underlying bounce type ("Permanent" / "Transient"); without one, a bounce counts as permanent.
      const permanent = kind === "complaint" || !/transient/i.test(String(resend.data.bounce?.type ?? ""));
      const to = Array.isArray(resend.data.to) ? resend.data.to : [resend.data.to];
      let handled = 0;
      for (const addr of to) {
        if (typeof addr === "string" && addr)
          handled += Number((await this.svc.espEvent(workspaceId, { type: kind, permanent, email: addr, providerMessageId: resend.data.email_id ?? null, sendId: null })).matched);
      }
      return { handled };
    }
    // Postmark, SendGrid and Mailgun, each in its own shape.
    const events = parseEspWebhook(body);
    if (events) {
      let handled = 0;
      for (const ev of events) handled += Number((await this.svc.espEvent(workspaceId, ev)).matched);
      return { handled };
    }
    const e = parseWith(EspEventInput, body);
    return this.svc.espEvent(workspaceId, { type: e.type, permanent: e.bounceType === "permanent", email: e.email, providerMessageId: e.providerMessageId, sendId: e.sendId });
  }
}
