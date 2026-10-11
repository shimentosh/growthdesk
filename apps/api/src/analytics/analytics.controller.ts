import { Controller, Get } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { AnalyticsPipelineQuery, AnalyticsRangeQuery, type AnalyticsPipelineQueryT, type AnalyticsRangeQueryT } from "@growthdesk/shared";
import { Ctx, Permission, Query } from "../common/decorators.js";
import type { RequestContext } from "../common/context.js";
import { AnalyticsService } from "./analytics.service.js";

/** Reports. Every range is `?from=YYYY-MM-DD&to=YYYY-MM-DD` in the workspace's time zone (default: the last 30 days). */
@ApiTags("analytics")
@Controller("workspaces/:workspaceId/analytics")
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  /** Outreach, pipeline and activity totals with a daily series. */
  @Permission("analytics.read")
  @Get("overview")
  overview(@Ctx() ctx: RequestContext, @Query(AnalyticsRangeQuery) q: AnalyticsRangeQueryT) {
    return this.analytics.overview(ctx, q);
  }

  /** Campaign comparison and results by sequence step. */
  @Permission("analytics.read")
  @Get("campaigns")
  campaigns(@Ctx() ctx: RequestContext, @Query(AnalyticsRangeQuery) q: AnalyticsRangeQueryT) {
    return this.analytics.campaigns(ctx, q);
  }

  /** Stage funnel for deals created in the range, in one pipeline. */
  @Permission("analytics.read")
  @Get("pipeline")
  pipeline(@Ctx() ctx: RequestContext, @Query(AnalyticsPipelineQuery) q: AnalyticsPipelineQueryT) {
    return this.analytics.pipeline(ctx, q);
  }

  /** Per-member leaderboard. Needs analytics.team and a plan with advanced reporting. */
  @Permission("analytics.team")
  @Get("team")
  team(@Ctx() ctx: RequestContext, @Query(AnalyticsRangeQuery) q: AnalyticsRangeQueryT) {
    return this.analytics.team(ctx, q);
  }
}
