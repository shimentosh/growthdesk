import { Controller, Get, HttpCode, Param, Post, Req as R } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import type { z } from "zod";
import { QuoteAcceptInput, QuoteDeclineInput } from "@growthdesk/shared";
import { Body, Public, SameOrigin } from "../common/decorators.js";
import type { Req } from "../common/context.js";
import { QuotesPublicService } from "./quotes-public.service.js";

const VIEW_LIMIT = { default: { limit: 60, ttl: 60_000 } };
const ACT_LIMIT = { default: { limit: 10, ttl: 60_000 } };

/*
 * The buyer's quote page, reached as ${PUBLIC_APP_URL}/api/public/quotes/... from /q/<token>:
 *
 *   GET  /public/quotes/:token           the document (the first view marks it viewed)
 *   POST /public/quotes/:token/accept    accept and sign
 *   POST /public/quotes/:token/decline   decline, with an optional reason
 *
 * Writes must come from our own page (SameOrigin): a cross-site form cannot
 * accept a quote on a buyer's behalf.
 */
@ApiTags("quotes-public")
@Public()
@Controller("public/quotes")
export class QuotesPublicController {
  constructor(private readonly svc: QuotesPublicService) {}

  @Throttle(VIEW_LIMIT)
  @Get(":token")
  view(@Param("token") token: string, @R() req: Req) {
    return this.svc.view(token, req.ctx);
  }

  @Throttle(ACT_LIMIT)
  @SameOrigin()
  @HttpCode(200)
  @Post(":token/accept")
  accept(@Param("token") token: string, @Body(QuoteAcceptInput) body: z.infer<typeof QuoteAcceptInput>, @R() req: Req) {
    return this.svc.accept(token, body, req.ctx);
  }

  @Throttle(ACT_LIMIT)
  @SameOrigin()
  @HttpCode(200)
  @Post(":token/decline")
  decline(@Param("token") token: string, @Body(QuoteDeclineInput) body: z.infer<typeof QuoteDeclineInput>) {
    return this.svc.decline(token, body);
  }
}
