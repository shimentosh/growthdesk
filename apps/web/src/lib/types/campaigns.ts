/*
 * Campaigns. Kept in step with apps/api/src/campaigns/campaigns.service.ts
 * (`dtos()`, `get()`, `readiness()`, `launch()`, `enroll()`, `enrollmentDto()`,
 * `stepStats()`, `CampaignCreateBody`, `CampaignPatchBody`) and the shared
 * schemas `AudienceInput`, `ScheduleInput`, `CampaignSettingsInput`.
 */
import type { CampaignStatus, ContactFilterT, EnrollmentStatus, StepType } from "@growthdesk/shared";
import type { SequenceStep, StepRow } from "./sequences";

export type CampaignAudience =
  | { type: "contacts"; contactIds: string[] }
  | { type: "view"; viewId: string }
  | { type: "filter"; filter: ContactFilterT }
  | { type: "lists"; listIds: string[] };

/** The send window (shared `ScheduleInput`): days are 0 = Sunday … 6 = Saturday, times are HH:MM in `timezone`. */
export type CampaignSchedule = { timezone: string; days: number[]; from: string; to: string };

/** Shared `CampaignSettingsInput`. */
export type CampaignSettings = {
  dailyNewLimit: number;
  stopOnReply: boolean;
  stopOnAutoReply: boolean;
  stopOnMeeting: boolean;
  stopOnDealWon: boolean;
  trackOpens: boolean;
  trackClicks: boolean;
  unsubscribeLink: boolean;
  gapSeconds: number;
  /** Always on: stays running for people enrolled later (workflows); may launch empty. */
  keepOpen: boolean;
};

export type CampaignUser = { id: string; name: string; email: string };
export type CampaignMailbox = { id: string; email: string; displayName: string; status: string };

/** Counters recounted from the rows by the engine (`stats.updatedAt` says when). */
export type CampaignStats = {
  enrolled: number;
  sent: number;
  opened: number;
  clicked: number;
  replied: number;
  bounced: number;
  unsubscribed: number;
  failed: number;
  updatedAt: string | null;
};

/** GET /campaigns rows. */
export type Campaign = {
  id: string;
  name: string;
  description: string;
  status: CampaignStatus;
  sequenceId: string;
  audience: CampaignAudience | null;
  audienceDescription: string;
  schedule: CampaignSchedule;
  settings: CampaignSettings;
  owner: CampaignUser | null;
  ownerId: string | null;
  createdBy: CampaignUser | null;
  mailboxes: CampaignMailbox[];
  stepCount: number;
  /**
   * The kinds of the campaign's steps, in order of first use, when the list
   * answer includes them (older APIs send only stepCount).
   */
  stepTypes?: StepType[];
  startAt: string | null;
  startedAt: string | null;
  pausedAt: string | null;
  completedAt: string | null;
  canceledAt: string | null;
  stats: CampaignStats;
  /** Live counts by enrollment status. */
  enrollments: Record<EnrollmentStatus, number>;
  createdAt: string;
  updatedAt: string;
};

/** GET /campaigns/:id, PATCH, POST, POST /:id/pause|resume|stop|duplicate. */
export type CampaignDetail = Campaign & { steps: StepRow[] };

/** POST /campaigns body (CampaignCreateBody) — schedule/settings are merged over the workspace defaults. */
export type CampaignCreateBody = {
  name: string;
  description?: string;
  fromSequenceId?: string | null;
  steps?: SequenceStep[];
  audience?: CampaignAudience;
  schedule?: Partial<CampaignSchedule>;
  settings?: Partial<CampaignSettings>;
  mailboxIds?: string[];
  ownerId?: string | null;
  startAt?: string | null;
};

/** PATCH /campaigns/:id body (CampaignPatchBody). Steps, audience, schedule, settings, mailboxes and startAt only while draft or paused. */
export type CampaignPatchBody = {
  name?: string;
  description?: string;
  audience?: CampaignAudience | null;
  schedule?: Partial<CampaignSchedule>;
  settings?: Partial<CampaignSettings>;
  mailboxIds?: string[];
  steps?: SequenceStep[];
  ownerId?: string | null;
  startAt?: string | null;
};

export type SkipItem = { reason: string; label: string; count: number };
/** `fix.href` is a link inside the workspace (pass it through ws.href). */
export type CampaignProblem = { field: string; message: string; fix?: { label: string; href: string } };

/** GET /campaigns/:id/readiness */
export type CampaignReadiness = {
  ready: boolean;
  problems: CampaignProblem[];
  warnings: string[];
  audience: { description: string; candidates: number; eligible: number; skipped: SkipItem[] };
  mailboxes: { selected: number; connected: number };
  personalization: { sampled: number; affected: number; variables: string[] } | null;
};

/** GET /campaigns/:id/health — what holds a launched (scheduled, running or paused) campaign back; empty when nothing does. */
export type CampaignHealth = { issues: CampaignProblem[] };

/** POST /campaigns/:id/enrollments/retry-failed */
export type RetryFailedResult = { retried: number; skipped: number };

/** GET /campaigns/lead-counts?listIds= — leads (who a lead-list audience enrolls) per list id. */
export type LeadCounts = Record<string, number>;

/** POST /campaigns/:id/steps/:position/test */
export type StepTestBody = { to: string; contactId?: string | null; mailboxId?: string | null };
export type StepTestResult = { sent: boolean; status: string; to: string; from: string; reason: string; missing: string[] };

/** POST /campaigns/:id/launch */
export type LaunchResult = { campaign: CampaignDetail; enrolled: number; skipped: SkipItem[]; warnings: string[] };

/** POST /campaigns/:id/enroll */
export type EnrollResult = { enrolled: number; skipped: SkipItem[] };

/** GET /campaigns/:id/enrollments rows (filters: status, replied=true, q), POST /campaigns/:id/enrollments/:eid/stop|retry|pause|resume. */
export type Enrollment = {
  id: string;
  status: EnrollmentStatus;
  contact: { id: string; fullName: string; email: string | null; company: string | null; deleted: boolean };
  position: number;
  step: { position: number; type: StepType } | null;
  nextRunAt: string | null;
  lastError: string;
  stopReason: string;
  errorCount: number;
  repliedAt: string | null;
  enrolledAt: string;
  completedAt: string | null;
  source: string;
  mailbox: { id: string; email: string | null } | null;
  updatedAt: string;
};

/** GET /campaigns/:id/step-stats */
export type StepStats = {
  position: number;
  type: StepType;
  executions: { succeeded: number; failed: number; skipped: number; uncertain: number; running: number };
  /** Active enrollments whose next step is this one. */
  waiting: number;
  messages: { sent: number; opened: number; clicked: number; bounced: number } | null;
};

/** The 422 `not_ready` launch refusal carries these in `details`. */
export type NotReadyDetails = { problems?: CampaignProblem[]; skipped?: SkipItem[]; eligible?: number };

/** Steps, audience, schedule, settings and mailboxes can change only in these states. */
export const EDITABLE_STATUSES: readonly CampaignStatus[] = ["draft", "paused"];
