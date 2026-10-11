/*
 * Pure rules for the maintenance and imports workers (maintenance.processors.ts),
 * kept apart from Nest so they can be unit-tested.
 */

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
