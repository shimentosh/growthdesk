import { Module } from "@nestjs/common";
import { ForecastController } from "./forecast.controller.js";
import { ForecastService } from "./forecast.service.js";
import { StaleDealsService } from "./stale-deals.service.js";

/** Sales targets, the forecast, and stale-deal alerts. */
@Module({
  imports: [],
  controllers: [ForecastController],
  providers: [ForecastService, StaleDealsService],
  exports: [ForecastService, StaleDealsService],
})
export class ForecastModule {}
