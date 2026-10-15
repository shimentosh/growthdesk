/*
 * Enum values mirrored from apps/api/prisma/schema.prisma so the web app can
 * validate and label them without importing the Prisma client. The API has a
 * unit test (src/common/enums.spec.ts) that fails if the two lists drift.
 */

export const WORKSPACE_ROLES = ["owner", "admin", "manager", "member", "viewer"] as const;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

export const PLATFORM_ROLES = ["none", "support", "admin", "owner"] as const;
export type PlatformRole = (typeof PLATFORM_ROLES)[number];

export const PRIORITIES = ["low", "medium", "high", "urgent"] as const;
export type Priority = (typeof PRIORITIES)[number];

/** lead → sales → contact. See the LifecycleStage enum in the Prisma schema. */
export const LIFECYCLE_STAGES = ["lead", "sales", "contact"] as const;
export type LifecycleStage = (typeof LIFECYCLE_STAGES)[number];

export const QUALIFICATIONS = ["unqualified", "qualifying", "qualified", "disqualified"] as const;
export type Qualification = (typeof QUALIFICATIONS)[number];

export const CONTACT_STATUSES = [
  "new",
  "contacted",
  "replied",
  "interested",
  "customer",
  "not_interested",
  "do_not_contact",
] as const;
export type ContactStatus = (typeof CONTACT_STATUSES)[number];

export const CONSENT_STATUSES = ["unknown", "granted", "denied"] as const;
export type ConsentStatus = (typeof CONSENT_STATUSES)[number];

export const IDENTIFIER_KINDS = ["email", "phone", "whatsapp", "telegram"] as const;
export type IdentifierKind = (typeof IDENTIFIER_KINDS)[number];

export const SUPPRESSION_KINDS = ["email", "domain", "phone"] as const;
export type SuppressionKind = (typeof SUPPRESSION_KINDS)[number];
/** Which sending engine a suppression stops (`all` = outreach and marketing). */
export const SUPPRESSION_SCOPES = ["all", "outreach", "marketing"] as const;
export type SuppressionScope = (typeof SUPPRESSION_SCOPES)[number];

export const STAGE_KINDS = ["open", "won", "lost"] as const;
export type StageKind = (typeof STAGE_KINDS)[number];

export const DEAL_STATUSES = ["open", "won", "lost"] as const;
export type DealStatus = (typeof DEAL_STATUSES)[number];

export const MEETING_STATUSES = ["scheduled", "completed", "canceled", "no_show"] as const;
export type MeetingStatus = (typeof MEETING_STATUSES)[number];

export const TASK_TYPES = [
  "email",
  "follow_up",
  "call",
  "meeting",
  "proposal",
  "review_reply",
  "qualify",
  "custom",
] as const;
export type TaskType = (typeof TASK_TYPES)[number];

export const TASK_STATUSES = ["open", "done", "canceled"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const MAILBOX_PROVIDERS = ["smtp", "gmail", "microsoft"] as const;
export type MailboxProvider = (typeof MAILBOX_PROVIDERS)[number];

export const CONNECTION_STATUSES = ["connected", "error", "disconnected"] as const;
export type ConnectionStatus = (typeof CONNECTION_STATUSES)[number];

export const CHANNELS = ["email", "whatsapp", "telegram", "call", "web"] as const;
export type Channel = (typeof CHANNELS)[number];

export const STEP_TYPES = [
  "email",
  "wait",
  "branch",
  "call_task",
  "whatsapp",
  "telegram",
  "update_field",
  "assign_owner",
  "create_task",
  "notify",
  "end",
] as const;
export type StepType = (typeof STEP_TYPES)[number];

export const CAMPAIGN_STATUSES = ["draft", "scheduled", "running", "paused", "completed", "canceled"] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

export const ENROLLMENT_STATUSES = ["active", "paused", "completed", "stopped", "failed"] as const;
export type EnrollmentStatus = (typeof ENROLLMENT_STATUSES)[number];

export const EXECUTION_STATUSES = ["running", "succeeded", "failed", "skipped", "uncertain"] as const;
export type ExecutionStatus = (typeof EXECUTION_STATUSES)[number];

export const CONVERSATION_STATUSES = ["open", "closed"] as const;
export type ConversationStatus = (typeof CONVERSATION_STATUSES)[number];

export const MESSAGE_DIRECTIONS = ["inbound", "outbound"] as const;
export type MessageDirection = (typeof MESSAGE_DIRECTIONS)[number];

export const MESSAGE_STATUSES = [
  "queued",
  "sending",
  "sent",
  "delivered",
  "read",
  "failed",
  "bounced",
  "received",
  "uncertain",
] as const;
export type MessageStatus = (typeof MESSAGE_STATUSES)[number];

export const CALL_STATUSES = [
  "queued",
  "ringing",
  "in_progress",
  "completed",
  "busy",
  "no_answer",
  "failed",
  "canceled",
] as const;
export type CallStatus = (typeof CALL_STATUSES)[number];

export const CALL_OUTCOMES = [
  "connected",
  "meeting_booked",
  "callback_requested",
  "left_voicemail",
  "no_answer",
  "busy",
  "not_interested",
  "wrong_number",
  "do_not_call",
  "other",
] as const;
export type CallOutcome = (typeof CALL_OUTCOMES)[number];

export const SUBSCRIPTION_STATUSES = ["trialing", "active", "past_due", "canceled", "incomplete", "expired"] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

export const BILLING_INTERVALS = ["month", "year"] as const;
export type BillingInterval = (typeof BILLING_INTERVALS)[number];

export const WORKFLOW_RUN_STATUSES = [
  "pending",
  "waiting_approval",
  "waiting",
  "running",
  "succeeded",
  "failed",
  "skipped",
  "canceled",
] as const;
export type WorkflowRunStatus = (typeof WORKFLOW_RUN_STATUSES)[number];

export const IMPORT_STATUSES = ["pending", "processing", "completed", "failed"] as const;
export type ImportStatus = (typeof IMPORT_STATUSES)[number];

/** Human labels for enum values that appear in the UI. */
export const LABELS: Record<string, string> = {
  new: "New",
  contacted: "Contacted",
  replied: "Replied",
  interested: "Interested",
  customer: "Customer",
  not_interested: "Not interested",
  do_not_contact: "Do not contact",
  unqualified: "Unqualified",
  qualifying: "Qualifying",
  qualified: "Qualified",
  disqualified: "Disqualified",
  follow_up: "Follow up",
  call: "Call",
  meeting: "Meeting",
  proposal: "Proposal",
  review_reply: "Review reply",
  qualify: "Qualify lead",
  custom: "Custom",
  email: "Email",
  whatsapp: "WhatsApp",
  telegram: "Telegram",
  web: "Live chat",
  call_task: "Call task",
  update_field: "Update field",
  assign_owner: "Assign owner",
  create_task: "Create task",
  notify: "Notify teammate",
  wait: "Wait",
  branch: "Branch",
  end: "End sequence",
  meeting_booked: "Meeting booked",
  callback_requested: "Callback requested",
  left_voicemail: "Left voicemail",
  no_answer: "No answer",
  busy: "Busy",
  wrong_number: "Wrong number",
  do_not_call: "Do not call",
  connected: "Connected",
  other: "Other",
  in_progress: "In progress",
  past_due: "Past due",
  trialing: "Trial",
};

export const labelOf = (value: string): string =>
  LABELS[value] ?? value.charAt(0).toUpperCase() + value.slice(1).replace(/_/g, " ");
