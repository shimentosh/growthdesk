import { HealthModule } from "./health/health.controller.js";
import { AuthModule } from "./auth/auth.module.js";
import { WorkspacesModule } from "./workspaces/workspaces.module.js";
import { BillingModule } from "./billing/billing.module.js";
import { NotificationsModule } from "./notifications/notifications.service.js";
import { RealtimeModule } from "./realtime/realtime.service.js";
import { MessagingModule } from "./messaging/messaging.module.js";
import { CrmModule } from "./crm/crm.module.js";
import { PipelineModule } from "./pipeline/pipeline.controller.js";
import { MailboxesModule } from "./mailboxes/mailboxes.module.js";
import { TrackingModule } from "./tracking/tracking.module.js";
import { ChannelsModule } from "./channels/channels.module.js";
import { InboxModule } from "./inbox/inbox.module.js";
import { CallsModule } from "./calls/calls.module.js";
import { AiCallingModule } from "./ai-calling/ai-calling.module.js";
import { BookingModule } from "./booking/booking.module.js";
import { ForecastModule } from "./forecast/forecast.module.js";
import { QuotesModule } from "./quotes/quotes.module.js";
import { CatalogSyncModule } from "./catalog-sync/catalog-sync.module.js";
import { ScoringModule } from "./scoring/scoring.module.js";
import { AttachmentsModule } from "./attachments/attachments.module.js";
import { CampaignsModule } from "./campaigns/campaigns.module.js";
import { AutomationModule } from "./automation/automation.module.js";
import { IntegrationsModule } from "./integrations/integrations.module.js";
import { AiModule } from "./ai/ai.module.js";
import { AnalyticsModule } from "./analytics/analytics.module.js";
import { AdminModule } from "./admin/admin.module.js";
import { RevenueModule } from "./revenue/revenue.module.js";
import { MarketingModule } from "./marketing/marketing.module.js";
import { DesignLibraryModule } from "./design-library/design-library.controller.js";
import { SiteModule } from "./site/site.controller.js";
import { PlatformMailModule } from "./platform-mail/platform-mail.module.js";
import { PlatformGrowthModule } from "./platform-growth/platform-growth.module.js";
import { LifecycleModule } from "./lifecycle/lifecycle.module.js";
import { LiveChatModule } from "./livechat/livechat.module.js";
import { SearchModule } from "./search/search.controller.js";
import { TeamsModule } from "./teams/teams.module.js";
import { DigestModule } from "./digest/digest.module.js";
import { DiscordModule } from "./discord/discord.module.js";

/** Every feature module, shared by the HTTP app and the worker. Do not reorder casually: globals first. */
export const FEATURE_MODULES = [
  HealthModule,
  PlatformMailModule,
  NotificationsModule,
  RealtimeModule,
  MessagingModule,
  CrmModule,
  AuthModule,
  WorkspacesModule,
  TeamsModule,
  BillingModule,
  PipelineModule,
  MailboxesModule,
  TrackingModule,
  ChannelsModule,
  InboxModule,
  CallsModule,
  AiCallingModule,
  BookingModule,
  ForecastModule,
  QuotesModule,
  CatalogSyncModule,
  ScoringModule,
  AttachmentsModule,
  CampaignsModule,
  AutomationModule,
  IntegrationsModule,
  AiModule,
  AnalyticsModule,
  AdminModule,
  RevenueModule,
  MarketingModule,
  DesignLibraryModule,
  SiteModule,
  PlatformGrowthModule,
  LifecycleModule,
  LiveChatModule,
  SearchModule,
  DigestModule,
  DiscordModule,
];
