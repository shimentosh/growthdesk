import { TENANT_MODELS } from "../prisma/tenant-guard.js";

/*
 * The order the purge job empties a deleted workspace's tables in: children
 * before parents, so each batch deletes a bounded number of rows instead of
 * cascading through a whole workspace at once, and so the two Restrict
 * relations (Deal → Pipeline/PipelineStage, Campaign → Sequence) never block.
 * The workspace row itself goes last and cascades the few non-tenant rows
 * left (memberships, invitations, usage counters, API keys, MCP tokens and
 * OAuth codes, support grants).
 *
 * A unit test keeps this list equal to the tenant guard's TENANT_MODELS, so a
 * new tenant table cannot be forgotten by the purge.
 */
export const PURGE_ORDER = [
  "MessageEvent",
  "Message",
  "ConversationNote",
  "Conversation",
  "StepExecution",
  "Enrollment",
  "CampaignMailbox",
  "MarketingSend",
  "MarketingCampaign",
  "ListMembership",
  "MarketingList",
  "EmailDesign",
  "WorkspaceAsset",
  "SendingDomain",
  "EspConnection",
  "WorkflowRun",
  "Workflow",
  "DiscordDelivery",
  "DiscordRule",
  "DiscordTemplate",
  "DiscordUnroutedEvent",
  "DiscordSettings",
  "DiscordDestination",
  "DiscordConnection",
  "WebhookDelivery",
  "WebhookEndpoint",
  "DomainEvent",
  "Notification",
  "IdempotencyKey",
  "McpPendingAction",
  "McpCall",
  "AiUsage",
  "AiCache",
  "Call",
  "CallScript",
  "CallAgent",
  "QuoteLineItem",
  "Quote",
  "Order",
  "Product",
  "SalesTarget",
  "ScoringRule",
  "Attachment",
  "ConversationRead",
  "TeamMember",
  "Team",
  "CalendarConnection",
  "Task",
  "Meeting",
  "BookingPage",
  "DealStageChange",
  "Deal",
  "Campaign",
  "SequenceStep",
  "Sequence",
  "TemplateVersion",
  "Template",
  "MailboxDailyCount",
  "Mailbox",
  "ChannelIntegration",
  "Activity",
  "Note",
  "ConsentEvent",
  "DuplicateCandidate",
  "ContactTag",
  "CompanyTag",
  "ContactIdentifier",
  "ContactSource",
  "Contact",
  "Company",
  "Tag",
  "CustomFieldDefinition",
  "SavedView",
  "Import",
  "Suppression",
  "PipelineStage",
  "Pipeline",
  "WorkspaceExport",
  "LibrarySeed",
] as const;

/** Tenant tables the purge order misses, or lists that are not tenant tables. Empty when they agree. */
export function purgeOrderGaps(): { missing: string[]; extra: string[] } {
  const listed = new Set<string>(PURGE_ORDER);
  return {
    missing: [...TENANT_MODELS].filter((m) => !listed.has(m)),
    extra: [...listed].filter((m) => !TENANT_MODELS.has(m)),
  };
}

/** Rows deleted per statement. Small enough to keep each transaction and its locks short. */
export const PURGE_BATCH = 2000;
