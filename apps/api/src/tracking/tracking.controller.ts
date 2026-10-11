import { Controller, Get, HttpCode, Param, Post, Req as R, Res } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import type { Response } from "express";
import { UnsubscribeInput } from "@growthdesk/shared";
import type { z } from "zod";
import { Body, Public, Raw } from "../common/decorators.js";
import type { Req } from "../common/context.js";
import { PIXEL_GIF, unsubscribeVia } from "./tracking-rules.js";
import { TrackingService, type Fetcher } from "./tracking.service.js";

/*
 * Rate limits. Pixels are fetched by image proxies (Gmail's, corporate
 * gateways) that load many recipients' images from a few shared addresses, so
 * the pixel gets five times the global per-IP allowance. Clicks come from
 * people's browsers and keep the global limit. Unsubscribe also keeps the
 * global limit rather than the strict auth one: RFC 8058 one-click POSTs come
 * from the mail provider's servers, and refusing a real opt-out is worse than
 * a little load. Every token is HMAC-signed, so none of this is guessable.
 */
const PIXEL_LIMIT = { default: { limit: 5 * Number(process.env.RATE_LIMIT_PER_MINUTE ?? 600), ttl: 60_000 } };

const fetcher = (req: Req): Fetcher => ({ method: req.method, userAgent: String(req.headers["user-agent"] ?? "") });

/*
 * Links inside sent emails, all public (the signed token is the credential).
 * Reached as ${PUBLIC_APP_URL}/api/t/... through the web app's /api → /v1
 * proxy; messaging/tracking.ts builds them:
 *
 *   GET  /t/o/:token.gif         open pixel — always the GIF, valid or not
 *   GET  /t/c/:token             click — records, then 302 to the signed URL only
 *   GET  /t/u/:token             the visible "Unsubscribe" link — 302 to the page
 *   GET  /t/u/:token/details     what the page shows before confirming
 *   POST /t/u/:token             unsubscribe: RFC 8058 one-click and the page's button
 *
 * Why GET never unsubscribes: the List-Unsubscribe URL is also fetched by
 * link scanners and anti-spam filters, which follow every link in a message.
 * RFC 8058 exists for exactly this reason — the opt-out happens on POST only
 * (sent by the mail app's own unsubscribe button, or by the page's confirm
 * button), so a scanner's GET can never remove someone who did not ask.
 */
@ApiTags("tracking")
@Public()
@Controller("t")
export class TrackingController {
  constructor(private readonly tracking: TrackingService) {}

  @Raw()
  @Throttle(PIXEL_LIMIT)
  @Get("o/:token")
  async open(@Param("token") token: string, @R() req: Req, @Res() res: Response) {
    await this.tracking.recordOpen(token, fetcher(req));
    res.status(200).set({ "content-type": "image/gif", "cache-control": "no-store, no-cache, must-revalidate, private", pragma: "no-cache", expires: "0" }).send(PIXEL_GIF);
  }

  @Raw()
  @Get("c/:token")
  async click(@Param("token") token: string, @R() req: Req, @Res() res: Response) {
    const target = await this.tracking.click(token, fetcher(req));
    res.setHeader("cache-control", "no-store");
    res.setHeader("referrer-policy", "no-referrer");
    res.redirect(302, target);
  }

  /** The link a person clicks in the email body: the confirmation page, which unsubscribes on its button. */
  @Raw()
  @Get("u/:token")
  page(@Param("token") token: string, @Res() res: Response) {
    res.setHeader("cache-control", "no-store");
    res.setHeader("referrer-policy", "no-referrer");
    res.redirect(302, `/unsubscribe/${encodeURIComponent(token)}`);
  }

  @Get("u/:token/details")
  details(@Param("token") token: string) {
    return this.tracking.details(token);
  }

  @HttpCode(200)
  @Post("u/:token")
  unsubscribe(@Param("token") token: string, @Body(UnsubscribeInput) body: z.infer<typeof UnsubscribeInput>) {
    return this.tracking.unsubscribe(token, unsubscribeVia(body));
  }
}
