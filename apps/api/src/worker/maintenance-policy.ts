/*
 * Pure rules for the maintenance and imports workers (maintenance.processors.ts),
 * kept apart from Nest so they can be unit-tested.
 */

import type { AppConfig } from "../config/config.js";

const DAY = 86_400_000;

/**
 * How long (ms) housekeeping keeps rows that have stopped mattering. Customer
 * records (contacts, messages, deals, activity, audit, billing) are never
 * touched here — see docs/BILLING.md "Data retention".
 */
export const RETENTION = {
  /** Expired or signed-out sessions: kept a day past the end for support questions, then useless. */
  sessions: 1 * DAY,
  /** Email-verification and password-reset tokens past their expiry (used or not). */
  authTokens: 1 * DAY,
  /** Sign-in failure counters; the lockout window is 15 minutes. */
  signInFailures: 1 * DAY,
  /** Public-API idempotency keys: a retry with the same key within this window replays the stored response. */
  idempotencyKeys: 1 * DAY,
  /** Finished outgoing-webhook deliveries (succeeded or failed) shown in the deliveries log. */
  webhookDeliveries: 30 * DAY,
  /** Notifications that have been read. Unread ones are kept until read. */
  readNotifications: 90 * DAY,
  /** Per-mailbox daily send counters (only today's matters for the cap). */
  mailboxDailyCounts: 90 * DAY,
  /** The platform's own transactional mail log. */
  emailLog: 90 * DAY,
  /** Parsed CSV rows of finished imports (the counts and errors stay); see the Import.rows schema comment. */
  importRows: 30 * DAY,
  /** The MCP call log (Settings → MCP / Claude → Recent activity). */
  mcpCalls: 90 * DAY,
  /** MCP confirmations, counted from their expiry: confirmed, canceled or lapsed, they are only history. */
  mcpPendingActions: 30 * DAY,
  /** Files removed from a contact, company, deal or quote: kept for undo questions, then their bytes go. */
  deletedAttachments: 30 * DAY,
} as const;

/** For each RETENTION entry, the moment before which rows go. */
export type RetentionCutoffs = { -readonly [K in keyof typeof RETENTION]: Date } & { mailboxDay: string };

export function retentionCutoffs(now: Date): RetentionCutoffs {
  const out = {} as RetentionCutoffs;
  for (const [k, ms] of Object.entries(RETENTION) as [keyof typeof RETENTION, number][]) out[k] = new Date(now.getTime() - ms);
  // MailboxDailyCount.day is a UTC "YYYY-MM-DD" string; ISO dates compare correctly as strings.
  out.mailboxDay = out.mailboxDailyCounts.toISOString().slice(0, 10);
  return out;
}

/**
 * History tables pruned by the daily `retention` job (worker/retention.service.ts),
 * each with the env setting that holds its retention in days (config.ts; 0 = keep).
 * Unlike RETENTION above these rows still mean something to a customer, so the
 * periods are long, configurable, and each rule only takes rows nothing reads any more.
 */
export const DATA_RETENTION = {
  domainEvents: "RETENTION_DOMAIN_EVENT_DAYS",
  messageEvents: "RETENTION_MESSAGE_EVENT_DAYS",
  workflowRuns: "RETENTION_WORKFLOW_RUN_DAYS",
  stepExecutions: "RETENTION_STEP_EXECUTION_DAYS",
  activityNoise: "RETENTION_ACTIVITY_NOISE_DAYS",
  aiUsage: "RETENTION_AI_USAGE_DAYS",
  billingEvents: "RETENTION_BILLING_EVENT_DAYS",
  marketingSends: "RETENTION_MARKETING_SEND_DAYS",
} as const satisfies Record<string, keyof AppConfig>;

export type DataRetentionKey = keyof typeof DATA_RETENTION;
type DataRetentionSetting = (typeof DATA_RETENTION)[DataRetentionKey];
/** For each history table, the moment before which rows may go; null = kept forever. */
export type DataRetentionCutoffs = Record<DataRetentionKey, Date | null>;

export function dataRetentionCutoffs(config: Pick<AppConfig, DataRetentionSetting>, now: Date): DataRetentionCutoffs {
  const out = {} as DataRetentionCutoffs;
  for (const [k, setting] of Object.entries(DATA_RETENTION) as [DataRetentionKey, DataRetentionSetting][]) {
    const days = config[setting];
    out[k] = days > 0 ? new Date(now.getTime() - days * DAY) : null;
  }
  return out;
}

/**
 * Domain events that double as "already happened" markers and so are never
 * pruned: CallsService.settle checks for call.completed before writing the
 * timeline entry and the event, and a call's outcome can be edited much later.
 */
export const KEPT_EVENT_TYPES = ["call.completed"] as const;

/** Timeline entries written automatically (no actor) that the activity rule may prune. Everything else is kept. */
export const NOISE_ACTIVITY_TYPES = ["email.clicked"] as const;

/** BullMQ: true when this run is the job's last attempt (no retry follows a throw). */
export function isFinalAttempt(job: { attemptsMade: number; opts: { attempts?: number } }): boolean {
  return job.attemptsMade + 1 >= Math.max(1, job.opts.attempts ?? 1);
}

/** A running import that has not saved progress for this long has lost its job (worker restart, evicted job). */
export const IMPORT_STALL_MS = 10 * 60_000;

/**
 * Which pending/processing imports the sweep should queue again: idle past
 * IMPORT_STALL_MS and no job for them waiting or running (a second job for
 * the same import would race the first and double-count rows).
 */
export function stalledImports<T extends { id: string; updatedAt: Date }>(imports: T[], liveImportIds: Set<string>, now: Date): T[] {
  return imports.filter((i) => !liveImportIds.has(i.id) && now.getTime() - i.updatedAt.getTime() >= IMPORT_STALL_MS);
}
