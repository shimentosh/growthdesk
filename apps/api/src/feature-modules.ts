import { HealthModule } from "./health/health.controller.js";
import { AuthModule } from "./auth/auth.module.js";
import { WorkspacesModule } from "./workspaces/workspaces.module.js";
import { BillingModule } from "./billing/billing.module.js";
import { NotificationsModule } from "./notifications/notifications.service.js";
import { MessagingModule } from "./messaging/messaging.module.js";
import { CrmModule } from "./crm/crm.module.js";
import { PipelineModule } from "./pipeline/pipeline.controller.js";
import { MailboxesModule } from "./mailboxes/mailboxes.module.js";
import { TrackingModule } from "./tracking/tracking.module.js";
import { ChannelsModule } from "./channels/channels.module.js";
import { InboxModule } from "./inbox/inbox.module.js";
import { CallsModule } from "./calls/calls.module.js";
import { CampaignsModule } from "./campaigns/campaigns.module.js";
import { AutomationModule } from "./automation/automation.module.js";
import { IntegrationsModule } from "./integrations/integrations.module.js";
import { AiModule } from "./ai/ai.module.js";
import { AnalyticsModule } from "./analytics/analytics.module.js";
import { AdminModule } from "./admin/admin.module.js";
import { RevenueModule } from "./revenue/revenue.module.js";
import { MarketingModule } from "./marketing/marketing.module.js";
import { SiteModule } from "./site/site.controller.js";
import { PlatformMailModule } from "./platform-mail/platform-mail.module.js";
import { PlatformGrowthModule } from "./platform-growth/platform-growth.module.js";

/** Every feature module, shared by the HTTP app and the worker. Do not reorder casually: globals first. */
export const FEATURE_MODULES = [
  HealthModule,
  PlatformMailModule,
  NotificationsModule,
  MessagingModule,
  CrmModule,
  AuthModule,
  WorkspacesModule,
  BillingModule,
  PipelineModule,
  MailboxesModule,
  TrackingModule,
  ChannelsModule,
  InboxModule,
  CallsModule,
  CampaignsModule,
  AutomationModule,
  IntegrationsModule,
  AiModule,
  AnalyticsModule,
  AdminModule,
  RevenueModule,
  MarketingModule,
  SiteModule,
  PlatformGrowthModule,
];
