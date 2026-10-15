import { Module } from "@nestjs/common";
import { MarketingController } from "./marketing.controller.js";
import { MarketingPublicController } from "./public.controller.js";
import { DnsResolver } from "./dns.js";
import { AudienceService } from "./audience.service.js";
import { ListsService } from "./lists.service.js";
import { MarketingSetupService } from "./setup.service.js";
import { DesignsService } from "./designs.service.js";
import { MarketingCampaignsService } from "./campaigns.service.js";
import { MarketingSenderService } from "./sender.service.js";
import { MarketingPublicService } from "./public.service.js";
import { MarketingAssetsService } from "./assets.service.js";
import { DoubleOptInService } from "./double-opt-in.service.js";

/**
 * Email marketing (docs/PRODUCT_PLAN.md §2.4): lists, sending setup, designs,
 * campaigns, the send loop and the public recipient endpoints. Contacts,
 * consent, suppression and activity come from the global CrmModule.
 */
@Module({
  controllers: [MarketingController, MarketingPublicController],
  providers: [DnsResolver, AudienceService, ListsService, MarketingSetupService, DesignsService, MarketingCampaignsService, MarketingSenderService, MarketingPublicService, MarketingAssetsService, DoubleOptInService],
  exports: [DnsResolver, ListsService, DesignsService, MarketingCampaignsService, MarketingSenderService, MarketingPublicService, DoubleOptInService],
})
export class MarketingModule {}
