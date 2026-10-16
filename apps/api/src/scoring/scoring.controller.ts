import { Controller, Delete, Get, HttpCode, Param, Patch, Post, Put } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import type { z } from "zod";
import { LeadScoringSettings, ScoringRecommendedInput, ScoringReorderInput, ScoringRuleFields, ScoringRuleInput, patchOf } from "@growthdesk/shared";
import { Body, Ctx, Permission } from "../common/decorators.js";
import type { RequestContext } from "../common/context.js";
import { ScoringService } from "./scoring.service.js";

/** Lead scoring: settings and rules (reading needs contacts.read; changing them, settings.manage), and one contact's score. */
@ApiTags("scoring")
@Controller("workspaces/:workspaceId/scoring")
export class ScoringController {
  constructor(private readonly scoring: ScoringService) {}

  /** Settings, rules in order, and how many contacts are hot / warm / scored. */
  @Permission("contacts.read")
  @Get()
  overview(@Ctx() ctx: RequestContext) {
    return this.scoring.overview(ctx);
  }

  /** On / off and the hot / warm thresholds. Turning it on scores every contact shortly after. */
  @Permission("settings.manage")
  @Put("settings")
  settings(@Ctx() ctx: RequestContext, @Body(LeadScoringSettings) body: z.infer<typeof LeadScoringSettings>) {
    return this.scoring.saveSettings(ctx, body);
  }

  @Permission("settings.manage")
  @Post("rules")
  create(@Ctx() ctx: RequestContext, @Body(ScoringRuleInput) body: z.infer<typeof ScoringRuleInput>) {
    return this.scoring.createRule(ctx, body);
  }

  @Permission("settings.manage")
  @Patch("rules/:id")
  update(@Ctx() ctx: RequestContext, @Param("id") id: string, @Body(patchOf(ScoringRuleFields)) body: Partial<z.infer<typeof ScoringRuleFields>>) {
    return this.scoring.updateRule(ctx, id, body);
  }

  @Permission("settings.manage")
  @Delete("rules/:id")
  remove(@Ctx() ctx: RequestContext, @Param("id") id: string) {
    return this.scoring.removeRule(ctx, id);
  }

  @Permission("settings.manage")
  @HttpCode(200)
  @Post("rules/reorder")
  reorder(@Ctx() ctx: RequestContext, @Body(ScoringReorderInput) body: z.infer<typeof ScoringReorderInput>) {
    return this.scoring.reorder(ctx, body.ids);
  }

  /** Adds the recommended rules that are missing (by name), or replaces every rule with them. */
  @Permission("settings.manage")
  @HttpCode(200)
  @Post("recommended")
  recommended(@Ctx() ctx: RequestContext, @Body(ScoringRecommendedInput) body: z.infer<typeof ScoringRecommendedInput>) {
    return this.scoring.useRecommended(ctx, body.replace);
  }

  /** Rescore every contact now (in the background). Once per workspace every ten minutes. */
  @Permission("settings.manage")
  @HttpCode(200)
  @Post("recalculate")
  recalculate(@Ctx() ctx: RequestContext) {
    return this.scoring.recalculate(ctx);
  }

  /** One contact's score, its fit and engagement parts, and the rules behind it. */
  @Permission("contacts.read")
  @Get("contacts/:contactId")
  contact(@Ctx() ctx: RequestContext, @Param("contactId") contactId: string) {
    return this.scoring.contactScore(ctx, contactId);
  }
}
