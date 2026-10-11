import { Module } from "@nestjs/common";
import { ConfigModule } from "../config/config.module.js";
import { PrismaModule } from "../prisma/prisma.service.js";
import { QueuesModule } from "../queues/queues.js";
import { CoreModule } from "../core/core.module.js";
import { FEATURE_MODULES } from "../feature-modules.js";
import { MailboxesProcessorsModule } from "../mailboxes/mailboxes.processors.js";
import { InboxProcessorsModule } from "../inbox/inbox.processors.js";
import { ChannelsProcessorsModule } from "../channels/channels.processors.js";
import { CampaignsProcessorsModule } from "../campaigns/campaigns.processors.js";
import { AutomationProcessorsModule } from "../automation/automation.processors.js";
import { AiProcessorsModule } from "../ai/ai.processors.js";
import { MaintenanceProcessorsModule } from "./maintenance.processors.js";
import { MarketingProcessorsModule } from "../marketing/marketing.processors.js";
import { PlatformMailProcessorsModule } from "../platform-mail/platform-mail.processors.js";
import { PlatformGrowthProcessorsModule } from "../platform-growth/platform-growth.processors.js";
import { WorkerOpsModule } from "./worker-ops.module.js";

/** The background worker: every feature's services plus the BullMQ processors and recurring schedules. */
@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    QueuesModule,
    CoreModule,
    ...FEATURE_MODULES,
    MailboxesProcessorsModule,
    InboxProcessorsModule,
    ChannelsProcessorsModule,
    CampaignsProcessorsModule,
    AutomationProcessorsModule,
    AiProcessorsModule,
    MaintenanceProcessorsModule,
    MarketingProcessorsModule,
    PlatformMailProcessorsModule,
    PlatformGrowthProcessorsModule,
    WorkerOpsModule,
  ],
})
export class WorkerModule {}

/** Processor modules, for tests that want to run jobs in-process. */
export const PROCESSOR_MODULES = [
  MailboxesProcessorsModule,
  InboxProcessorsModule,
  ChannelsProcessorsModule,
  CampaignsProcessorsModule,
  AutomationProcessorsModule,
  AiProcessorsModule,
  MaintenanceProcessorsModule,
  MarketingProcessorsModule,
  PlatformMailProcessorsModule,
  PlatformGrowthProcessorsModule,
];
