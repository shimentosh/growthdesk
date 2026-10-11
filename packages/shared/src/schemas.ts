import { z } from "zod";
import {
  BILLING_INTERVALS,
  CALL_OUTCOMES,
  CHANNELS,
  CONSENT_STATUSES,
  CONTACT_STATUSES,
  MAILBOX_PROVIDERS,
  MEETING_STATUSES,
  PRIORITIES,
  QUALIFICATIONS,
  STAGE_KINDS,
  STEP_TYPES,
  SUPPRESSION_KINDS,
  SUPPRESSION_SCOPES,
  TASK_STATUSES,
  TASK_TYPES,
  WORKSPACE_ROLES,
} from "./enums.js";
import { RULE_FIELDS, RULE_OPS } from "./flow.js";
import { isValidTimeZone } from "./schedule.js";

/*
 * Request bodies, validated by the API (ZodBody pipe) and reused by the web
 * app's forms so both sides agree on what is acceptable.
 * Building blocks adapted from LinkDesk's validation.ts.
 */

export const text = (max = 500) => z.string().trim().max(max);
export const requiredText = (max = 200) => z.string().trim().min(1, "Required").max(max);
export const email = z.string().trim().toLowerCase().email("Enter a valid email address").max(254);
export const uuid = z.string().uuid();
export const optionalUuid = z.string().uuid().nullable().optional();
export const isoDate = z.coerce.date();
export const timezone = z.string().refine(isValidTimeZone, "Unknown time zone");

/** 10+ characters, at least three of: lower, upper, digit, symbol. */
export const password = z
  .string()
  .min(10, "Use at least 10 characters")
  .max(200)
  .refine((v) => [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(v)).length >= 3, {
    message: "Mix at least three of: lower-case, upper-case, numbers, symbols",
  });

// ─── Auth ────────────────────────────────────────────────────────────────────

export const RegisterInput = z.object({
  name: requiredText(120),
  email,
  password,
  /** A platform sign-up invitation (invite-only / waitlist modes): `/register?invite=…`. */
  inviteToken: z.string().trim().min(10).max(200).optional(),
  /** Product/marketing email consent; unticked unless the person ticks it. */
  marketingConsent: z.boolean().optional(),
});
export const LoginInput = z.object({ email, password: z.string().min(1).max(200) });
export const ForgotPasswordInput = z.object({ email });
export const ResetPasswordInput = z.object({ token: z.string().min(10).max(200), password });
export const VerifyEmailInput = z.object({ token: z.string().min(10).max(200) });
/** `currentPassword` may be omitted only by an account that has none yet (Google sign-in); the API checks. */
export const ChangePasswordInput = z.object({ currentPassword: z.string().max(200).optional(), newPassword: password });
export const UpdateProfileInput = z.object({ name: requiredText(120).optional(), timezone: timezone.optional() });

// ─── Workspaces ──────────────────────────────────────────────────────────────

export const BUSINESS_TYPES = [
  "agency",
  "saas",
  "consulting",
  "freelancer",
  "ecommerce",
  "services",
  "recruiting",
  "other",
] as const;

export const CreateWorkspaceInput = z.object({
  name: requiredText(80),
  businessType: z.enum(BUSINESS_TYPES).default("other"),
  timezone: timezone.default("UTC"),
  currency: z.string().length(3).toUpperCase().default("USD"),
  /** Attach to an existing billing account the caller owns (agency plans). */
  billingAccountId: optionalUuid,
});
export const UpdateWorkspaceInput = z.object({
  name: requiredText(80).optional(),
  businessType: z.enum(BUSINESS_TYPES).optional(),
  timezone: timezone.optional(),
  currency: z.string().length(3).toUpperCase().optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
  onboarding: z.record(z.string(), z.unknown()).optional(),
  legalName: text(200).optional(),
  postalAddress: text(500).optional(),
  marketingFromName: text(120).optional(),
  marketingReplyTo: z.union([email, z.literal("")]).optional(),
});
export const InviteMemberInput = z.object({
  email,
  role: z.enum(WORKSPACE_ROLES).exclude(["owner"]),
});
export const UpdateMemberInput = z.object({ role: z.enum(WORKSPACE_ROLES) });
export const RolePermissionsInput = z.object({
  role: z.enum(WORKSPACE_ROLES).exclude(["owner"]),
  permissions: z.array(z.string()).max(100).nullable(),
});

// ─── Contacts & companies ────────────────────────────────────────────────────

const customFields = z.record(z.string().max(60), z.union([z.string().max(2000), z.number(), z.boolean(), z.null()]));

export const ContactInput = z.object({
  firstName: text(100).optional(),
  lastName: text(100).optional(),
  fullName: text(200).optional(),
  email: z.union([email, z.literal("")]).optional().nullable(),
  emails: z.array(email).max(10).optional(),
  phone: text(40).optional().nullable(),
  phones: z.array(text(40)).max(10).optional(),
  jobTitle: text(200).optional(),
  website: text(500).optional(),
  linkedinUrl: text(500).optional(),
  city: text(100).optional(),
  country: text(100).optional(),
  timezone: text(60).optional(),
  leadSource: text(100).optional(),
  companyId: optionalUuid,
  companyName: text(200).optional(),
  ownerId: optionalUuid,
  priority: z.enum(PRIORITIES).optional(),
  qualification: z.enum(QUALIFICATIONS).optional(),
  status: z.enum(CONTACT_STATUSES).optional(),
  score: z.number().int().min(0).max(100).nullable().optional(),
  customFields: customFields.optional(),
  nextActionAt: isoDate.nullable().optional(),
  nextActionNote: text(500).optional(),
  doNotContact: z.boolean().optional(),
  consentStatus: z.enum(CONSENT_STATUSES).optional(),
  consentSource: text(200).optional(),
  tags: z.array(requiredText(50)).max(50).optional(),
});
export type ContactInputT = z.infer<typeof ContactInput>;

export const CompanyInput = z.object({
  name: requiredText(200),
  website: text(500).optional(),
  domain: text(200).optional().nullable(),
  industry: text(100).optional(),
  size: text(50).optional(),
  country: text(100).optional(),
  region: text(100).optional(),
  city: text(100).optional(),
  phone: text(40).optional(),
  description: text(5000).optional(),
  ownerId: optionalUuid,
  customFields: customFields.optional(),
  tags: z.array(requiredText(50)).max(50).optional(),
});

export const ContactFilter = z.object({
  q: text(200).optional(),
  status: z.array(z.enum(CONTACT_STATUSES)).optional(),
  qualification: z.array(z.enum(QUALIFICATIONS)).optional(),
  priority: z.array(z.enum(PRIORITIES)).optional(),
  ownerId: z.union([uuid, z.literal("me"), z.literal("none")]).optional(),
  companyId: uuid.optional(),
  tag: z.array(z.string().max(50)).optional(),
  leadSource: text(100).optional(),
  hasEmail: z.boolean().optional(),
  hasPhone: z.boolean().optional(),
  noNextAction: z.boolean().optional(),
  createdAfter: isoDate.optional(),
  createdBefore: isoDate.optional(),
  campaignId: uuid.optional(),
});
export type ContactFilterT = z.infer<typeof ContactFilter>;

export const SORTABLE_CONTACT_FIELDS = ["createdAt", "updatedAt", "fullName", "lastContactedAt", "nextActionAt", "priority", "score"] as const;

export const ListQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
  sort: z.string().max(40).optional(),
  dir: z.enum(["asc", "desc"]).default("desc"),
});

export const BulkContactAction = z.discriminatedUnion("action", [
  z.object({ action: z.literal("tag"), ids: z.array(uuid).min(1).max(5000), tags: z.array(requiredText(50)).min(1) }),
  z.object({ action: z.literal("untag"), ids: z.array(uuid).min(1).max(5000), tags: z.array(requiredText(50)).min(1) }),
  z.object({ action: z.literal("assign"), ids: z.array(uuid).min(1).max(5000), ownerId: uuid.nullable() }),
  z.object({ action: z.literal("status"), ids: z.array(uuid).min(1).max(5000), status: z.enum(CONTACT_STATUSES) }),
  z.object({ action: z.literal("qualification"), ids: z.array(uuid).min(1).max(5000), qualification: z.enum(QUALIFICATIONS) }),
  z.object({ action: z.literal("delete"), ids: z.array(uuid).min(1).max(5000) }),
  z.object({ action: z.literal("enroll"), ids: z.array(uuid).min(1).max(5000), campaignId: uuid }),
]);

export const MergeContactsInput = z.object({
  primaryId: uuid,
  duplicateIds: z.array(uuid).min(1).max(10),
});

export const SavedViewInput = z.object({
  entity: z.enum(["contact", "company", "deal", "task"]),
  name: requiredText(80),
  filters: z.record(z.string(), z.unknown()).default({}),
  sort: z.record(z.string(), z.unknown()).default({}),
  shared: z.boolean().default(false),
});

export const TagInput = z.object({ name: requiredText(50), color: text(20).optional() });

export const CustomFieldInput = z.object({
  entity: z.enum(["contact", "company", "deal"]),
  key: z.string().trim().toLowerCase().regex(/^[a-z][a-z0-9_]{0,39}$/, "Lower-case letters, digits and _ only"),
  label: requiredText(80),
  type: z.enum(["text", "number", "date", "boolean", "select", "url"]),
  options: z.array(requiredText(80)).max(100).default([]),
});

export const NoteInput = z.object({ body: requiredText(10000), pinned: z.boolean().optional() });

export const IMPORT_FIELDS = [
  "firstName",
  "lastName",
  "fullName",
  "email",
  "phone",
  "jobTitle",
  "company",
  "companyDomain",
  "website",
  "linkedinUrl",
  "city",
  "country",
  "leadSource",
  "tags",
  "externalId",
  "notes",
] as const;

export const ImportStartInput = z.object({
  fileName: text(200),
  csv: z.string().min(1).max(15_000_000),
  /** CSV header → contact field ("custom.<key>" for custom fields, "" to skip). */
  mapping: z.record(z.string(), z.string()),
  tags: z.array(requiredText(50)).max(20).default([]),
  /** update: fill blanks on existing contacts. skip: leave existing contacts alone. */
  onDuplicate: z.enum(["update", "skip"]).default("update"),
  leadSource: text(100).optional(),
  defaultCountry: z.string().length(2).toUpperCase().optional(),
});

export const SuppressionInput = z.object({
  kind: z.enum(SUPPRESSION_KINDS),
  value: requiredText(254),
  reason: z.enum(["manual", "do_not_contact", "unsubscribed", "bounced", "complained", "opted_out"]).default("manual"),
  scope: z.enum(SUPPRESSION_SCOPES).default("all"),
});

// ─── Business OS / external lead ingest ──────────────────────────────────────

export const ExternalLead = z.object({
  externalId: requiredText(200),
  contact: z.object({
    name: text(200).optional(),
    firstName: text(100).optional(),
    lastName: text(100).optional(),
    email: z.union([email, z.literal("")]).optional().nullable(),
    phone: text(40).optional().nullable(),
    role: text(200).optional(),
    linkedinUrl: text(500).optional().nullable(),
    doNotContact: z.boolean().optional(),
    doNotContactReason: text(500).optional(),
  }),
  company: z
    .object({
      name: text(200).optional(),
      domain: text(200).optional().nullable(),
      website: text(500).optional().nullable(),
      industry: text(100).optional(),
      country: text(100).optional(),
      city: text(100).optional(),
      description: text(5000).optional(),
    })
    .optional(),
  score: z.number().int().min(0).max(100).optional().nullable(),
  notes: text(5000).optional(),
  tags: z.array(requiredText(50)).max(20).optional(),
  source: text(100).optional(),
  customFields: customFields.optional(),
});
export const ExternalLeadBatch = z.object({ leads: z.array(ExternalLead).min(1).max(500) });
export type ExternalLeadT = z.infer<typeof ExternalLead>;

// ─── Pipeline ────────────────────────────────────────────────────────────────

export const PipelineInput = z.object({
  name: requiredText(80),
  isDefault: z.boolean().optional(),
  stages: z
    .array(
      z.object({
        id: uuid.optional(),
        name: requiredText(60),
        kind: z.enum(STAGE_KINDS).default("open"),
        probability: z.number().int().min(0).max(100).default(0),
        color: text(20).optional(),
      }),
    )
    .min(2)
    .max(30)
    .optional(),
});

export const DealInput = z.object({
  name: requiredText(200),
  pipelineId: uuid.optional(),
  stageId: uuid.optional(),
  contactId: optionalUuid,
  companyId: optionalUuid,
  ownerId: optionalUuid,
  value: z.number().min(0).max(1e12).optional(),
  currency: z.string().length(3).toUpperCase().optional(),
  expectedCloseDate: isoDate.nullable().optional(),
  sourceCampaignId: optionalUuid,
  description: text(5000).optional(),
  proposalUrl: text(1000).optional(),
});
export const MoveDealInput = z.object({
  stageId: uuid,
  reason: text(500).optional(),
});

export const MeetingInput = z.object({
  title: requiredText(200),
  startsAt: isoDate,
  endsAt: isoDate.nullable().optional(),
  location: text(500).optional(),
  contactId: optionalUuid,
  dealId: optionalUuid,
  ownerId: optionalUuid,
  status: z.enum(MEETING_STATUSES).optional(),
  notes: text(5000).optional(),
});

// ─── Tasks ───────────────────────────────────────────────────────────────────

export const TaskInput = z.object({
  type: z.enum(TASK_TYPES).default("custom"),
  title: requiredText(300),
  description: text(5000).optional(),
  priority: z.enum(PRIORITIES).optional(),
  dueAt: isoDate.nullable().optional(),
  remindAt: isoDate.nullable().optional(),
  assigneeId: optionalUuid,
  contactId: optionalUuid,
  dealId: optionalUuid,
  conversationId: optionalUuid,
  status: z.enum(TASK_STATUSES).optional(),
});

// ─── Mailboxes ───────────────────────────────────────────────────────────────

export const SmtpMailboxInput = z.object({
  email,
  displayName: text(120).optional(),
  smtpHost: requiredText(255),
  smtpPort: z.number().int().min(1).max(65535),
  smtpSecurity: z.enum(["ssl", "starttls", "none"]),
  smtpUser: requiredText(255),
  password: z.string().min(1).max(500),
  imapEnabled: z.boolean().default(true),
  imapHost: text(255).optional(),
  imapPort: z.number().int().min(1).max(65535).optional(),
  imapSecurity: z.enum(["ssl", "starttls", "none"]).optional(),
  imapUser: text(255).optional(),
  dailyLimit: z.number().int().min(1).max(2000).default(50),
  minDelaySeconds: z.number().int().min(0).max(3600).default(90),
  signature: text(5000).optional(),
});
export const UpdateMailboxInput = z.object({
  displayName: text(120).optional(),
  dailyLimit: z.number().int().min(1).max(2000).optional(),
  minDelaySeconds: z.number().int().min(0).max(3600).optional(),
  signature: text(5000).optional(),
  password: z.string().min(1).max(500).optional(),
});
export const MailboxProviderInput = z.object({ provider: z.enum(MAILBOX_PROVIDERS) });
export const TestSendInput = z.object({ to: email, subject: text(300).optional(), body: text(20000).optional() });

// ─── Templates, sequences, campaigns ─────────────────────────────────────────

export const TemplateInput = z.object({
  channel: z.enum(CHANNELS).default("email"),
  name: requiredText(120),
  category: text(60).optional(),
  subject: text(300).optional(),
  body: requiredText(50000),
  waTemplate: text(200).optional(),
  waLanguage: text(20).optional(),
});

export const RuleSchema = z.object({
  field: z.union([z.enum(RULE_FIELDS), z.string().regex(/^custom\.[a-z0-9_]+$/)]),
  op: z.enum(RULE_OPS),
  value: text(200),
});

export const StepInput = z.object({
  type: z.enum(STEP_TYPES),
  config: z
    .object({
      delayMinutes: z.number().int().min(0).max(60 * 24 * 365).optional(),
      subject: text(300).optional(),
      body: text(50000).optional(),
      templateId: optionalUuid,
      logic: z.object({ match: z.enum(["all", "any"]), rules: z.array(RuleSchema).max(20) }).optional(),
      thenLength: z.number().int().min(0).max(50).optional(),
      elseLength: z.number().int().min(0).max(50).optional(),
      taskTitle: text(300).optional(),
      taskType: z.enum(TASK_TYPES).optional(),
      taskDueMinutes: z.number().int().min(0).max(60 * 24 * 90).optional(),
      field: text(60).optional(),
      value: text(500).optional(),
      userId: optionalUuid,
      strategy: z.enum(["user", "round_robin", "campaign_owner"]).optional(),
      message: text(2000).optional(),
      integrationId: optionalUuid,
    })
    .passthrough()
    .default({}),
});
export type StepInputT = z.infer<typeof StepInput>;

export const SequenceInput = z.object({
  name: requiredText(120),
  description: text(1000).optional(),
  steps: z.array(StepInput).max(50).optional(),
});

export const ScheduleInput = z.object({
  timezone: timezone.default("UTC"),
  days: z.array(z.number().int().min(0).max(6)).min(1).max(7).default([1, 2, 3, 4, 5]),
  from: z.string().regex(/^\d{2}:\d{2}$/).default("09:00"),
  to: z.string().regex(/^\d{2}:\d{2}$/).default("17:00"),
});

export const CampaignSettingsInput = z.object({
  dailyNewLimit: z.number().int().min(1).max(5000).default(50),
  stopOnReply: z.boolean().default(true),
  stopOnAutoReply: z.boolean().default(false),
  stopOnMeeting: z.boolean().default(true),
  stopOnDealWon: z.boolean().default(true),
  trackOpens: z.boolean().default(false),
  trackClicks: z.boolean().default(false),
  unsubscribeLink: z.boolean().default(true),
  gapSeconds: z.number().int().min(0).max(3600).default(120),
});

export const AudienceInput = z.discriminatedUnion("type", [
  z.object({ type: z.literal("contacts"), contactIds: z.array(uuid).max(50000) }),
  z.object({ type: z.literal("view"), viewId: uuid }),
  z.object({ type: z.literal("filter"), filter: ContactFilter }),
]);

export const CampaignInput = z.object({
  name: requiredText(120),
  description: text(1000).optional(),
  audience: AudienceInput.optional(),
  schedule: ScheduleInput.optional(),
  settings: CampaignSettingsInput.partial().optional(),
  mailboxIds: z.array(uuid).max(50).optional(),
  steps: z.array(StepInput).max(50).optional(),
  fromSequenceId: optionalUuid,
  ownerId: optionalUuid,
  startAt: isoDate.nullable().optional(),
});

export const EnrollInput = z.object({ contactIds: z.array(uuid).min(1).max(10000) });

// ─── Inbox ───────────────────────────────────────────────────────────────────

export const ReplyInput = z.object({
  body: requiredText(50000),
  subject: text(300).optional(),
  mailboxId: optionalUuid,
});
export const ComposeInput = z.object({
  channel: z.enum(["email", "whatsapp", "telegram"]),
  contactId: uuid,
  mailboxId: optionalUuid,
  integrationId: optionalUuid,
  subject: text(300).optional(),
  body: requiredText(50000),
  templateId: optionalUuid,
});
export const ConversationPatchInput = z.object({
  unread: z.boolean().optional(),
  status: z.enum(["open", "closed"]).optional(),
  assigneeId: optionalUuid,
  snoozedUntil: isoDate.nullable().optional(),
  dealId: optionalUuid,
});

// ─── Channels & calling ─────────────────────────────────────────────────────

export const WhatsAppConnectInput = z.object({
  name: text(80).optional(),
  phoneNumberId: requiredText(64),
  businessAccountId: text(64).optional(),
  accessToken: z.string().min(20).max(1000),
  appSecret: z.string().min(8).max(200),
});
export const TelegramConnectInput = z.object({
  name: text(80).optional(),
  botToken: z.string().regex(/^\d{5,}:[A-Za-z0-9_-]{30,}$/, "That does not look like a bot token from @BotFather"),
});
export const TwilioConnectInput = z.object({
  name: text(80).optional(),
  accountSid: z.string().regex(/^AC[0-9a-f]{32}$/i, "Account SID starts with AC"),
  authToken: z.string().min(16).max(200),
  callerId: requiredText(20),
});

export const CallLogInput = z.object({
  contactId: optionalUuid,
  dealId: optionalUuid,
  taskId: optionalUuid,
  toNumber: text(40).optional(),
  outcome: z.enum(CALL_OUTCOMES),
  notes: text(10000).optional(),
  durationSec: z.number().int().min(0).max(86400).optional(),
  callbackAt: isoDate.nullable().optional(),
  scriptId: optionalUuid,
});
export const StartCallInput = z.object({
  contactId: uuid,
  taskId: optionalUuid,
  dealId: optionalUuid,
  integrationId: uuid,
  agentNumber: requiredText(40),
});
export const CallScriptInput = z.object({ name: requiredText(120), body: requiredText(20000) });

// ─── Automation ─────────────────────────────────────────────────────────────

export const WORKFLOW_TRIGGERS = [
  "contact.created",
  "lead.imported",
  "contact.qualified",
  "reply.received",
  "call.completed",
  "meeting.booked",
  "deal.stage_changed",
  "task.overdue",
] as const;
export type WorkflowTrigger = (typeof WORKFLOW_TRIGGERS)[number];

export const WORKFLOW_ACTIONS = [
  "assign_contact",
  "update_contact",
  "create_task",
  "notify",
  "enroll_campaign",
  "stop_campaigns",
  "add_tag",
] as const;

export const WorkflowActionInput = z.object({
  type: z.enum(WORKFLOW_ACTIONS),
  delayMinutes: z.number().int().min(0).max(60 * 24 * 30).default(0),
  config: z.record(z.string(), z.unknown()).default({}),
});
export const WorkflowConditionInput = z.object({
  field: requiredText(80),
  op: z.enum(["is", "is_not", "contains", "gt", "lt", "exists"]),
  value: text(200).default(""),
});
export const WorkflowInput = z.object({
  name: requiredText(120),
  description: text(1000).optional(),
  trigger: z.enum(WORKFLOW_TRIGGERS),
  conditions: z.array(WorkflowConditionInput).max(20).default([]),
  actions: z.array(WorkflowActionInput).min(1).max(20),
  requiresApproval: z.boolean().default(false),
  enabled: z.boolean().default(false),
});

// ─── Integrations: API keys, webhooks ───────────────────────────────────────

export const API_SCOPES = ["leads:write", "contacts:read", "contacts:write", "campaigns:read"] as const;
export const ApiKeyInput = z.object({
  name: requiredText(80),
  scopes: z.array(z.enum(API_SCOPES)).min(1),
  expiresAt: isoDate.nullable().optional(),
});
export const WEBHOOK_EVENTS = [
  "contact.created",
  "contact.updated",
  "lead.imported",
  "reply.received",
  "message.bounced",
  "contact.unsubscribed",
  "deal.created",
  "deal.stage_changed",
  "deal.won",
  "deal.lost",
  "meeting.booked",
  "call.completed",
  "campaign.completed",
] as const;
export const WebhookInput = z.object({
  url: z.string().url().max(1000).refine((u) => /^https?:\/\//.test(u), "http(s) only"),
  description: text(200).optional(),
  events: z.array(z.enum(WEBHOOK_EVENTS)).min(1),
  enabled: z.boolean().default(true),
});

// ─── AI ─────────────────────────────────────────────────────────────────────

export const AiDraftInput = z.object({
  contactId: uuid,
  goal: text(1000).optional(),
  tone: z.enum(["friendly", "professional", "direct", "casual"]).default("professional"),
  channel: z.enum(["email", "whatsapp", "telegram"]).default("email"),
});

// ─── Billing ─────────────────────────────────────────────────────────────────

export const CheckoutInput = z.object({ planKey: requiredText(40), interval: z.enum(BILLING_INTERVALS) });
export const BillingDetailsInput = z.object({
  name: text(200).optional(),
  billingEmail: z.union([email, z.literal("")]).optional(),
  country: text(2).optional(),
  taxId: text(60).optional(),
  address: text(1000).optional(),
});

// ─── Platform admin ─────────────────────────────────────────────────────────

export const PlanAdminInput = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_-]{1,39}$/),
  name: requiredText(60),
  description: text(500).optional(),
  isActive: z.boolean().default(true),
  isPublic: z.boolean().default(true),
  sortOrder: z.number().int().default(0),
  currency: z.string().length(3).toUpperCase().default("USD"),
  monthlyPriceCents: z.number().int().min(0),
  annualPriceCents: z.number().int().min(0),
  trialDays: z.number().int().min(0).max(365).default(0),
  limits: z.record(z.string(), z.number().int().min(-1)),
  features: z.record(z.string(), z.boolean()),
  providerPrices: z.record(z.string(), z.record(z.string(), z.string())).default({}),
});
export const AdminAssignPlanInput = z.object({
  planKey: requiredText(40),
  interval: z.enum(BILLING_INTERVALS).default("month"),
  status: z.enum(["active", "trialing"]).default("active"),
  periodEnd: isoDate.nullable().optional(),
  reason: requiredText(500),
});
export const SuspendInput = z.object({ reason: requiredText(500) });
export const SupportCaseInput = z.object({
  subject: requiredText(200),
  body: requiredText(10000),
  priority: z.enum(["low", "normal", "high"]).default("normal"),
});
export const PlatformSettingsInput = z.object({
  signupsOpen: z.boolean().optional(),
  signupDomains: z.array(z.string()).optional(),
  defaultPlanKey: z.string().optional(),
  expiredPlanKey: z.string().optional(),
  graceDays: z.number().int().min(0).max(60).optional(),
  maintenanceMode: z.boolean().optional(),
  maintenanceMessage: text(500).optional(),
  outreachEnabled: z.boolean().optional(),
  aiProvider: z.enum(["none", "anthropic", "openai"]).optional(),
  aiModel: text(100).optional(),
  aiApiKey: z.string().max(500).optional(),
  // Platform email.
  mailProvider: z.enum(["smtp", "resend"]).optional(),
  resendApiKey: z.string().max(500).optional(),
  resendWebhookSecret: z.string().max(500).optional(),
  transactionalFrom: text(200).optional(),
  marketingFrom: text(200).optional(),
  replyTo: text(200).optional(),
  resendRateLimitPerSec: z.number().int().min(1).max(100).optional(),
  // Registration.
  signupMode: z.enum(["open", "invite_only", "waitlist", "closed"]).optional(),
  blockDisposableDomains: z.boolean().optional(),
  extraBlockedDomains: z.array(z.string().max(253)).max(1000).optional(),
  requireEmailVerification: z.boolean().optional(),
  defaultTrialDays: z.number().int().min(0).max(365).nullable().optional(),
  // Public site.
  landingEnabled: z.boolean().optional(),
});
