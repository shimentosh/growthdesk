import type { EmailBlock, PlatformAudienceFilter, PlatformBroadcastStatus, PlatformDripTrigger, PlatformSubscriberTab } from "@growthdesk/shared";

/* Response shapes of /v1/admin/growth/… (apps/api/src/platform-growth). */

export type AudienceFilter = PlatformAudienceFilter;

export type Audience = { id: string; name: string; filter: AudienceFilter; count: number; broadcasts?: number; createdAt: string; updatedAt: string };

export type AudienceSample = { id: string; email: string; name: string; createdAt: string; lastLoginAt: string | null; consentAt: string | null; workspaces: number };
export type AudiencePreview = { count: number; samples: AudienceSample[] };

export type MarketingContent = { subject: string; preheader: string; blocks: EmailBlock[] };
export type MarketingPreview = { subject: string; html: string; text: string; problems: string[] };

export type RecipientProgress = { pending: number; sent: number; failed: number; skipped: number; canceled: number; total: number };
export type BroadcastTotals = { recipients?: number; snapshotAt?: string; sent?: number; failed?: number; skipped?: number; canceled?: number };

export type BroadcastRow = {
  id: string;
  name: string;
  subject: string;
  status: PlatformBroadcastStatus;
  audience: { id: string; name: string } | null;
  scheduledAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  totals: BroadcastTotals;
  progress: RecipientProgress;
  error: string;
  createdAt: string;
  updatedAt: string;
};

export type BroadcastDetail = Omit<BroadcastRow, "audience"> &
  MarketingContent & {
    audience: { id: string; name: string; count: number | null } | null;
    problems: string[];
  };

export type EmailFunnel = { total: number; queued: number; sent: number; delivered: number; opened: number; clicked: number; bounced: number; complained: number; failed: number };

export type BroadcastStats = {
  id: string;
  status: PlatformBroadcastStatus;
  startedAt: string | null;
  finishedAt: string | null;
  recipients: RecipientProgress;
  email: EmailFunnel;
  unsubscribes: number;
};

export type Enrollments = { active: number; completed: number; stopped: number };

export type SequenceRow = {
  id: string;
  name: string;
  trigger: PlatformDripTrigger;
  active: boolean;
  activatedAt: string | null;
  steps: number;
  enrollments: Enrollments;
  createdAt: string;
};

export type SequenceStep = MarketingContent & { id: string; position: number; delayHours: number; problems: string[]; updatedAt: string };

export type SequenceDetail = Omit<SequenceRow, "steps"> & { steps: SequenceStep[] };

export type SequenceStats = {
  id: string;
  steps: { stepId: string; position: number; subject: string; waiting: number; email: EmailFunnel; unsubscribes: number }[];
};

export type Subscriber = {
  userId: string;
  email: string;
  name: string;
  emailVerified: boolean;
  suspended: boolean;
  marketingConsent: boolean;
  consentAt: string | null;
  consentSource: string;
  unsubscribedAt: string | null;
  suppressedAt: string | null;
  suppressionReason: string;
};

export type SubscribersPage = {
  items: Subscriber[];
  total: number;
  page: number;
  pageSize: number;
  counts: Record<PlatformSubscriberTab, number>;
};

export type TestSendResult = {
  ok: boolean;
  emailLogId: string;
  provider: "smtp" | "resend";
  providerMessageId: string | null;
  fallbackReason: string | null;
  error: string | null;
  to: string;
};
