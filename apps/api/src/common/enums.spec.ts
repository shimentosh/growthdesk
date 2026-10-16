import * as shared from "@growthdesk/shared";
import * as prisma from "../generated/prisma/enums.js";

/** The enum lists in packages/shared must stay identical to the Prisma schema's. */
const pairs: [string, readonly string[], Record<string, string>][] = [
  ["WorkspaceRole", shared.WORKSPACE_ROLES, prisma.WorkspaceRole],
  ["PlatformRole", shared.PLATFORM_ROLES, prisma.PlatformRole],
  ["Priority", shared.PRIORITIES, prisma.Priority],
  ["Qualification", shared.QUALIFICATIONS, prisma.Qualification],
  ["ContactStatus", shared.CONTACT_STATUSES, prisma.ContactStatus],
  ["ConsentStatus", shared.CONSENT_STATUSES, prisma.ConsentStatus],
  ["IdentifierKind", shared.IDENTIFIER_KINDS, prisma.IdentifierKind],
  ["SuppressionKind", shared.SUPPRESSION_KINDS, prisma.SuppressionKind],
  ["SuppressionScope", shared.SUPPRESSION_SCOPES, prisma.SuppressionScope],
  ["ListMembershipStatus", shared.LIST_MEMBERSHIP_STATUSES, prisma.ListMembershipStatus],
  ["EspProvider", shared.ESP_PROVIDERS, prisma.EspProvider],
  ["SendingDomainStatus", shared.SENDING_DOMAIN_STATUSES, prisma.SendingDomainStatus],
  ["MarketingCampaignStatus", shared.MARKETING_CAMPAIGN_STATUSES, prisma.MarketingCampaignStatus],
  ["MarketingSendStatus", shared.MARKETING_SEND_STATUSES, prisma.MarketingSendStatus],
  ["StageKind", shared.STAGE_KINDS, prisma.StageKind],
  ["DealStatus", shared.DEAL_STATUSES, prisma.DealStatus],
  ["MeetingStatus", shared.MEETING_STATUSES, prisma.MeetingStatus],
  ["TaskType", shared.TASK_TYPES, prisma.TaskType],
  ["TaskStatus", shared.TASK_STATUSES, prisma.TaskStatus],
  ["MailboxProvider", shared.MAILBOX_PROVIDERS, prisma.MailboxProvider],
  ["ConnectionStatus", shared.CONNECTION_STATUSES, prisma.ConnectionStatus],
  ["Channel", shared.CHANNELS, prisma.Channel],
  ["StepType", shared.STEP_TYPES, prisma.StepType],
  ["CampaignStatus", shared.CAMPAIGN_STATUSES, prisma.CampaignStatus],
  ["EnrollmentStatus", shared.ENROLLMENT_STATUSES, prisma.EnrollmentStatus],
  ["ExecutionStatus", shared.EXECUTION_STATUSES, prisma.ExecutionStatus],
  ["ConversationStatus", shared.CONVERSATION_STATUSES, prisma.ConversationStatus],
  ["MessageDirection", shared.MESSAGE_DIRECTIONS, prisma.MessageDirection],
  ["MessageStatus", shared.MESSAGE_STATUSES, prisma.MessageStatus],
  ["CallStatus", shared.CALL_STATUSES, prisma.CallStatus],
  ["SubscriptionStatus", shared.SUBSCRIPTION_STATUSES, prisma.SubscriptionStatus],
  ["BillingInterval", shared.BILLING_INTERVALS, prisma.BillingInterval],
  ["WorkflowRunStatus", shared.WORKFLOW_RUN_STATUSES, prisma.WorkflowRunStatus],
  ["ImportStatus", shared.IMPORT_STATUSES, prisma.ImportStatus],
  ["McpAccess", shared.MCP_ACCESS_LEVELS, prisma.McpAccess],
];

describe("shared enums mirror the Prisma schema", () => {
  it.each(pairs)("%s", (_name, mirror, source) => {
    expect([...mirror].sort()).toEqual(Object.values(source).sort());
  });
});
