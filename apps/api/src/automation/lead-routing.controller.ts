import { Controller, Get, HttpCode, Post, Put } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { z } from "zod";
import { LeadRoutingInput } from "@growthdesk/shared";
import { Body, Ctx, Permission } from "../common/decorators.js";
import type { RequestContext } from "../common/context.js";
import { LeadRoutingService } from "./lead-routing.service.js";

const TestInput = z.object({ contactId: z.string().uuid() });

/** Lead routing rules (who owns a new lead). Reading needs members.read; changing them, settings.manage. */
@ApiTags("lead-routing")
@Controller("workspaces/:workspaceId/lead-routing")
export class LeadRoutingController {
  constructor(private readonly routing: LeadRoutingService) {}

  @Permission("members.read")
  @Get()
  get(@Ctx() ctx: RequestContext) {
    return this.routing.get(ctx);
  }

  @Permission("settings.manage")
  @Put()
  save(@Ctx() ctx: RequestContext, @Body(LeadRoutingInput) body: z.infer<typeof LeadRoutingInput>) {
    return this.routing.save(ctx, body);
  }

  /** Which rule a contact would hit and whom it would go to now. Changes nothing. */
  @Permission("members.read")
  @HttpCode(200)
  @Post("test")
  test(@Ctx() ctx: RequestContext, @Body(TestInput) body: z.infer<typeof TestInput>) {
    return this.routing.test(ctx, body.contactId);
  }
}
