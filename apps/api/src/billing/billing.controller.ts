import { Controller, Get, HttpCode, Param, Patch, Post, Req as R } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { BillingDetailsInput, CheckoutInput } from "@growthdesk/shared";
import type { z } from "zod";
import { AllowSuspended, Body, Ctx, Permission, Public } from "../common/decorators.js";
import type { Req, RequestContext } from "../common/context.js";
import { badRequest } from "../common/errors.js";
import { BillingService } from "./billing.service.js";

@ApiTags("billing")
@Controller()
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  @Public()
  @Get("plans")
  plans() {
    return this.billing.publicPlans();
  }

  @AllowSuspended()
  @Permission("billing.read")
  @Get("workspaces/:workspaceId/billing")
  overview(@Ctx() ctx: RequestContext) {
    return this.billing.overview(ctx);
  }

  @AllowSuspended()
  @Permission("billing.manage")
  @Patch("workspaces/:workspaceId/billing/details")
  details(@Ctx() ctx: RequestContext, @Body(BillingDetailsInput) body: z.infer<typeof BillingDetailsInput>) {
    return this.billing.updateDetails(ctx, body);
  }

  @AllowSuspended()
  @Permission("billing.manage")
  @Post("workspaces/:workspaceId/billing/checkout")
  checkout(@Ctx() ctx: RequestContext, @Body(CheckoutInput) body: z.infer<typeof CheckoutInput>) {
    return this.billing.checkout(ctx, body.planKey, body.interval);
  }

  @AllowSuspended()
  @Permission("billing.manage")
  @Post("workspaces/:workspaceId/billing/portal")
  portal(@Ctx() ctx: RequestContext) {
    return this.billing.portal(ctx);
  }

  @AllowSuspended()
  @Permission("billing.manage")
  @Post("workspaces/:workspaceId/billing/cancel")
  cancel(@Ctx() ctx: RequestContext) {
    return this.billing.cancel(ctx, false);
  }

  @AllowSuspended()
  @Permission("billing.manage")
  @Post("workspaces/:workspaceId/billing/resume")
  resume(@Ctx() ctx: RequestContext) {
    return this.billing.cancel(ctx, true);
  }

  /** Payment provider webhooks. Verified by signature over the raw body; never by session. */
  @Public()
  @HttpCode(200)
  @Post("webhooks/billing/:provider")
  async webhook(@Param("provider") provider: string, @R() req: Req) {
    if (!req.rawBody) throw badRequest("Empty webhook body");
    return this.billing.handleWebhook(provider, req.rawBody, req.headers);
  }
}
