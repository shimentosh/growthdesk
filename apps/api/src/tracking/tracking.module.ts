import { Module } from "@nestjs/common";
import { TrackingController } from "./tracking.controller.js";
import { TrackingService } from "./tracking.service.js";

/**
 * Open/click tracking and unsubscribe links (public, token-authenticated).
 * SuppressionService and ActivityService (CrmModule) and EventsService
 * (CoreModule) are global; the tokens themselves are messaging/tracking.ts.
 */
@Module({
  controllers: [TrackingController],
  providers: [TrackingService],
  exports: [TrackingService],
})
export class TrackingModule {}
