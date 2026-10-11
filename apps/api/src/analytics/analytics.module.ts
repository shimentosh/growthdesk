import { Module } from "@nestjs/common";
import { AnalyticsController } from "./analytics.controller.js";
import { AnalyticsService } from "./analytics.service.js";

/** Workspace reports: outreach, campaigns, pipeline funnel, activity and team performance (read-only). */
@Module({ controllers: [AnalyticsController], providers: [AnalyticsService], exports: [AnalyticsService] })
export class AnalyticsModule {}
