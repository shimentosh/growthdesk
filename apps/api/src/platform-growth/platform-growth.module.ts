import { Module } from "@nestjs/common";
import { AudiencesService } from "./audiences.service.js";
import { BroadcastsService } from "./broadcasts.service.js";
import { BroadcastRunner } from "./broadcast-runner.service.js";
import { DripRunner } from "./drip-runner.service.js";
import { MarketingMailer } from "./marketing-mailer.js";
import { SequencesService } from "./sequences.service.js";
import { SubscribersService } from "./subscribers.service.js";
import { EmailPreferencesController, PlatformGrowthAdminController, PlatformUnsubscribeController } from "./platform-growth.controller.js";

/*
 * Platform growth (super-admin Phase 5): broadcasts and onboarding drips to
 * the SaaS's own users, audiences, subscribers, the product-email preference
 * page and the account toggle. Sending goes through PlatformMailModule (global).
 * The `platform-marketing` queue's processor is in platform-growth.processors.ts
 * (worker only).
 */
@Module({
  controllers: [PlatformGrowthAdminController, PlatformUnsubscribeController, EmailPreferencesController],
  providers: [AudiencesService, BroadcastsService, BroadcastRunner, DripRunner, MarketingMailer, SequencesService, SubscribersService],
  exports: [BroadcastRunner, DripRunner],
})
export class PlatformGrowthModule {}
