import { Controller, Delete, Get, Param, Put } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { ForecastQuery, PeriodQuery, SalesTargetInput, type ForecastQueryT, type PeriodQueryT, type SalesTargetInputT } from "@growthdesk/shared";
import { Body, Ctx, Permission, Query } from "../common/decorators.js";
import type { RequestContext } from "../common/context.js";
import { ForecastService } from "./forecast.service.js";

/** The forecast and sales targets. Periods are `?periodType=month|quarter&periodStart=YYYY-MM-DD` in the workspace's time zone (default: this month). */
@ApiTags("forecast")
@Controller("workspaces/:workspaceId")
export class ForecastController {
  constructor(private readonly forecast: ForecastService) {}

  /** Won, commit, best case, pipeline and weighted pipeline against targets, per owner and for the team, plus the deals behind them. */
  @Permission("deals.read")
  @Get("forecast")
  get(@Ctx() ctx: RequestContext, @Query(ForecastQuery) q: ForecastQueryT) {
    return this.forecast.forecast(ctx, q);
  }

  @Permission("targets.manage")
  @Get("targets")
  targets(@Ctx() ctx: RequestContext, @Query(PeriodQuery) q: PeriodQueryT) {
    return this.forecast.targets(ctx, q);
  }

  /** Sets one person's (userId null: the team's) target for a metric in a period, replacing the one there. */
  @Permission("targets.manage")
  @Put("targets")
  setTarget(@Ctx() ctx: RequestContext, @Body(SalesTargetInput) body: SalesTargetInputT) {
    return this.forecast.setTarget(ctx, body);
  }

  @Permission("targets.manage")
  @Delete("targets/:id")
  async deleteTarget(@Ctx() ctx: RequestContext, @Param("id") id: string) {
    await this.forecast.deleteTarget(ctx, id);
    return { deleted: true };
  }
}
