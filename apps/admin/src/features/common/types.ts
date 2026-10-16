/*
 * Shapes of the platform super-admin endpoints (/admin/…). Keep these in
 * step with apps/api/src/admin/admin.service.ts and admin-support.service.ts.
 * (Copied from apps/web/src/lib/types/platform.ts.)
 */
import type { LimitKey, PlanFeatures, PlanLimits, PlatformRole, SubscriptionStatus, WorkspaceRole } from "@growthdesk/shared";

export type Person = { id: string; email: string; name: string };

/** GET /admin/overview */
export type AdminOverview = {
  users: { total: number; newThisWeek: number; disabled: number; staff: number };
  workspaces: { total: number; newThisWeek: number; suspended: number };
  billing: { accounts: number; subscriptions: Partial<Record<SubscriptionStatus | "none", number>> };
  support: { open: number; pending: number; activeGrants: number };
  platformMail: { sent24h: number; failed24h: number };
  outreach: { messagesSent24h: number };
  settings: { maintenanceMode: boolean; outreachEnabled: boolean; signupsOpen: boolean };
};

/** One row of GET /admin/users */
export type AdminUserRow = {
  id: string;
  email: string;
  name: string;
  platformRole: PlatformRole;
  emailVerified: boolean;
  disabledAt: string | null;
  disabledReason: string;
  lastLoginAt: string | null;
  createdAt: string;
  workspaceCount: number;
};

export type AdminAuditRow = {
  id: string;
  workspaceId: string | null;
  actorUserId: string | null;
  actorType: string;
  action: string;
  targetType: string;
  targetId: string;
  metadata: Record<string, unknown>;
  ip: string;
  createdAt: string;
  actor?: Person | null;
  workspace?: { id: string; name: string } | null;
};

/** GET /admin/users/:id */
export type AdminUserDetail = AdminUserRow & {
  hasPassword: boolean;
  googleLinked: boolean;
  /** When two-factor was turned on, or null when it is off. */
  twoFactorEnabledAt: string | null;
  memberships: { workspaceId: string; workspaceName: string; workspaceStatus: string; role: WorkspaceRole; joinedAt: string }[];
  billingAccounts: { id: string; name: string }[];
  sessions: { id: string; ip: string; userAgent: string; createdAt: string; lastSeenAt: string }[];
  recentAudit: AdminAuditRow[];
};

/** One row of GET /admin/workspaces */
export type AdminWorkspaceRow = {
  id: string;
  name: string;
  slug: string;
  status: "active" | "suspended";
  suspendedReason: string;
  /** Soft-deleted: unreachable for customers, purged after purgeAfter unless restored (docs/PRIVACY_OPS.md). */
  deletedAt: string | null;
  purgeAfter: string | null;
  createdAt: string;
  members: number;
  billingAccount: { id: string; name: string; owner: Person };
  subscription: { status: SubscriptionStatus; provider: string; plan: { key: string; name: string } } | null;
};

export type AdminSubscription = {
  status: SubscriptionStatus;
  interval: "month" | "year";
  provider: string;
  providerCustomerId: string | null;
  providerSubscriptionId: string | null;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  trialEndsAt: string | null;
  cancelAtPeriodEnd: boolean;
  canceledAt: string | null;
  graceUntil: string | null;
};

/** The entitlements summary the admin screens show (EntitlementsService.summary). */
export type AdminPlanSummary = {
  key: string;
  name: string;
  effectiveKey: string;
  effectiveName: string;
  state: SubscriptionStatus | "none";
  access: "full" | "restricted";
  reason: string;
  usage: Record<LimitKey, { used: number; limit: number; label: string }>;
  features: PlanFeatures;
  subscription: AdminSubscription | null;
};

export type AdminGrant = { id: string; reason: string; expiresAt: string; createdAt: string; grantedBy: Person | null };

/** GET /admin/workspaces/:id */
export type AdminWorkspaceDetail = {
  id: string;
  name: string;
  slug: string;
  businessType: string;
  timezone: string;
  currency: string;
  status: "active" | "suspended";
  suspendedReason: string;
  suspendedAt: string | null;
  deletedAt: string | null;
  purgeAfter: string | null;
  createdAt: string;
  billingAccount: { id: string; name: string; owner: Person; workspaces: number };
  plan: AdminPlanSummary;
  members: { userId: string; email: string; name: string; role: WorkspaceRole; disabled: boolean; lastLoginAt: string | null; joinedAt: string }[];
  pendingInvitations: number;
  supportGrant: AdminGrant | null;
  openSupportCases: number;
  recentAudit: AdminAuditRow[];
};

/** One row of GET /admin/billing-accounts */
export type AdminBillingAccountRow = {
  id: string;
  name: string;
  billingEmail: string;
  owner: Person;
  workspaces: number;
  createdAt: string;
  subscription: {
    status: SubscriptionStatus;
    provider: string;
    interval: "month" | "year";
    plan: { key: string; name: string };
    trialEndsAt: string | null;
    currentPeriodEnd: string | null;
  } | null;
};

/** GET /admin/billing-accounts/:id */
export type AdminBillingAccountDetail = {
  id: string;
  name: string;
  billingEmail: string;
  country: string;
  taxId: string;
  address: string;
  createdAt: string;
  owner: Person;
  workspaces: { id: string; name: string; status: string; createdAt: string }[];
  plan: AdminPlanSummary;
  invoices: {
    id: string;
    provider: string;
    number: string;
    status: string;
    currency: string;
    amountDueCents: number;
    amountPaidCents: number;
    hostedUrl: string;
    pdfUrl: string;
    issuedAt: string;
    paidAt: string | null;
  }[];
  billingEvents: { id: string; provider: string; type: string; receivedAt: string; processedAt: string | null; error: string; attempts: number }[];
  manualAssign: { allowed: boolean; reason: string };
  plans: { key: string; name: string; isActive: boolean; isPublic: boolean }[];
};

/** One row of GET /admin/plans */
export type AdminPlan = {
  id: string;
  key: string;
  name: string;
  description: string;
  isActive: boolean;
  isPublic: boolean;
  sortOrder: number;
  currency: string;
  monthlyPriceCents: number;
  annualPriceCents: number;
  trialDays: number;
  limits: PlanLimits;
  features: PlanFeatures;
  providerPrices: Record<string, Record<string, string>>;
  subscriptions: number;
  isDefault: boolean;
  isExpiredFallback: boolean;
  updatedAt: string;
};

/** GET /admin/settings — PlatformSettingsService.publicView() plus the plan list. */
export type AdminSettings = {
  signupsOpen: boolean;
  signupDomains: string[];
  defaultPlanKey: string;
  expiredPlanKey: string;
  graceDays: number;
  maintenanceMode: boolean;
  maintenanceMessage: string;
  outreachEnabled: boolean;
  aiProvider: "none" | "anthropic" | "openai";
  aiModel: string;
  aiApiKeySet: boolean;
  aiApiKeyFromEnv: boolean;
  aiBaseUrl: string;
  googleClientId: string;
  googleClientSecretSet: boolean;
  googleClientSecretFromEnv: boolean;
  microsoftClientId: string;
  microsoftClientSecretSet: boolean;
  microsoftClientSecretFromEnv: boolean;
  microsoftTenant: string;
  stripeSecretKeySet: boolean;
  stripeSecretKeyFromEnv: boolean;
  stripeWebhookSecretSet: boolean;
  stripeWebhookSecretFromEnv: boolean;
  trialsPerIpPerDay: number | null;
  retentionDays: Partial<Record<RetentionKey, number>>;
  /** Checks on every email a contact gets by hand, CSV, the leads API or MCP. */
  contactEmailValidation: ContactEmailValidation;
  /** The server environment's values: what applies while a setting above is empty. */
  env: {
    googleClientId: string;
    microsoftClientId: string;
    microsoftTenant: string;
    aiBaseUrl: string;
    trialsPerIpPerDay: number;
    retentionDays: Record<RetentionKey, number>;
  };
  /** What to paste into Google Cloud, Microsoft Entra and Stripe. */
  urls: { googleRedirectUris: string[]; microsoftRedirectUri: string; stripeWebhookUrl: string };
  plans: { key: string; name: string; isActive: boolean }[];
};

/** History tables pruned by the worker's daily retention job (apps/api/src/worker/maintenance-policy.ts). */
export type RetentionKey = "domainEvents" | "messageEvents" | "workflowRuns" | "stepExecutions" | "activityNoise" | "aiUsage" | "billingEvents" | "marketingSends";

/** One row of GET /admin/support/cases */
export type AdminCaseRow = {
  id: string;
  subject: string;
  status: "open" | "pending" | "closed";
  priority: "low" | "normal" | "high";
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  notes: number;
  workspace: { id: string; name: string; status: string } | null;
  user: Person | null;
  assignee: Person | null;
};

/** GET /admin/support/cases/:id */
export type AdminCaseDetail = Omit<AdminCaseRow, "notes"> & {
  body: string;
  notes: { id: string; body: string; createdAt: string; author: Person | null }[];
  supportGrant: { id: string; expiresAt: string; reason: string } | null;
  staff: (Person & { platformRole: PlatformRole })[];
};

/** One row of GET /admin/support/grants */
export type AdminActiveGrant = {
  id: string;
  reason: string;
  createdAt: string;
  expiresAt: string;
  workspace: { id: string; name: string; status: string };
  grantedBy: Person | null;
};

/** GET /admin/support/workspaces/:id — the support view summary. */
export type SupportViewSummary = {
  workspace: { id: string; name: string; status: string; timezone: string };
  grant: AdminGrant;
  counts: { contacts: number; deals: number; conversations: number };
  mailboxes: {
    id: string;
    provider: string;
    email: string;
    displayName: string;
    status: string;
    lastError: string;
    lastCheckedAt: string | null;
    smtpHost: string;
    smtpPort: number;
    imapEnabled: boolean;
    imapHost: string;
    imapPort: number;
    dailyLimit: number;
    lastSyncedAt: string | null;
    syncError: string;
    createdAt: string;
  }[];
  integrations: { id: string; channel: string; provider: string; name: string; status: string; lastError: string; lastEventAt: string | null; createdAt: string }[];
  campaigns: {
    id: string;
    name: string;
    status: string;
    startedAt: string | null;
    enrolledCount: number;
    sentCount: number;
    replyCount: number;
    bounceCount: number;
    failedCount: number;
    updatedAt: string;
  }[];
  imports: {
    id: string;
    source: string;
    status: string;
    fileName: string;
    totalRows: number;
    processedRows: number;
    createdCount: number;
    updatedCount: number;
    skippedCount: number;
    failedCount: number;
    errors: unknown[];
    createdAt: string;
    finishedAt: string | null;
  }[];
};

export type SupportContactRow = {
  id: string;
  fullName: string;
  email: string | null;
  phone: string | null;
  status: string;
  doNotContact: boolean;
  unsubscribedAt: string | null;
  bouncedAt: string | null;
  lastContactedAt: string | null;
  lastRepliedAt: string | null;
  createdAt: string;
  company: { name: string } | null;
};

export type SupportConversationRow = {
  id: string;
  channel: string;
  subject: string;
  handle: string;
  displayName: string;
  status: string;
  lastMessageAt: string | null;
  mailbox: { email: string } | null;
  messages: number;
};

export type SupportConversation = Omit<SupportConversationRow, "messages"> & {
  messages: {
    id: string;
    direction: "inbound" | "outbound";
    status: string;
    fromAddress: string;
    toAddress: string;
    subject: string;
    bodyText: string;
    error: string;
    isAutoReply: boolean;
    sentAt: string | null;
    receivedAt: string | null;
    createdAt: string;
  }[];
};

/** GET /admin/email-log */
export type EmailLogRow = { id: string; to: string; template: string; status: string; error: string; createdAt: string };
export type EmailLogPage = { items: EmailLogRow[]; total: number; page: number; pageSize: number; templates: string[] };

export type ContactEmailValidation = {
  enabled: boolean;
  blockDisposable: boolean;
  checkMailServer: boolean;
  blockRoleAccounts: boolean;
  blockedDomains: string[];
};

export type EmailCheck = "syntax" | "blocked" | "disposable" | "role" | "mail_server";

/** POST /admin/settings/email-validation/test */
export type EmailValidationResult = {
  enabled: boolean;
  email: string;
  ok: boolean;
  reason?: EmailCheck;
  message?: string;
  checks: { check: EmailCheck; ok: boolean; detail?: string }[];
};
