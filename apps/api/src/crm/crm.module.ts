import { Global, Module } from "@nestjs/common";
import { CrmController } from "./crm.controller.js";
import { ContactsService } from "./contacts.service.js";
import { CompaniesService } from "./companies.service.js";
import { CrmExtrasService } from "./crm-extras.service.js";
import { ImportsService } from "./imports.service.js";
import { SuppressionService } from "./suppression.service.js";
import { ActivityService } from "./activity.service.js";
import { ConsentService } from "./consent.service.js";
import { ActivityFeedController } from "./activity-feed.controller.js";
import { ActivityFeedService } from "./activity-feed.service.js";

/** Global: contacts, activity, suppression and consent are used by nearly every other area. */
@Global()
@Module({
  controllers: [CrmController, ActivityFeedController],
  providers: [ContactsService, CompaniesService, CrmExtrasService, ImportsService, SuppressionService, ActivityService, ConsentService, ActivityFeedService],
  exports: [ContactsService, CompaniesService, CrmExtrasService, ImportsService, SuppressionService, ActivityService, ConsentService],
})
export class CrmModule {}
