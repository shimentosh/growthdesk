/*
 * Pure scheduling rules for the `mail` queue (mailboxes.processors.ts), kept
 * apart from Nest so they can be unit-tested.
 */

/** How often the worker looks for mailboxes to read replies from. A sync already queued or running absorbs the next. */
export const SYNC_SWEEP_EVERY_MS = 60_000;
/** One sync job keeps reading while the server has more, up to this many passes (PER_PASS messages each). */
export const MAX_SYNC_PASSES = 10;
/** How often the worker looks for mailboxes whose health check is due. */
export const HEALTH_SWEEP_EVERY_MS = 15 * 60_000;
/** A working mailbox has its SMTP/IMAP sign-in re-proved this often, so a revoked password shows before a campaign hits it. */
export const HEALTHY_RECHECK_MS = 24 * 3600_000;
/** A mailbox in error is re-tried this often, so a fixed server (or a passing outage) brings it back without a click. */
export const ERROR_RECHECK_MS = 3600_000;

export type MailboxState = { status: string; lastError: string; lastCheckedAt: Date | null };

/**
 * A mailbox whose sign-in is known to be broken is not synced every minute:
 * repeated failed logins can get an account locked by its provider. The
 * hourly health check re-tries it and, once it passes, syncing resumes.
 * An SMTP-only failure does not stop reply tracking.
 */
export function syncBlockedBySignIn(box: Pick<MailboxState, "status" | "lastError">): boolean {
  if (box.status !== "error") return false;
  return box.lastError.startsWith("IMAP") || box.lastError.startsWith("Sign-in refresh failed");
}

/** Whether the periodic health check should re-prove this mailbox now. Disconnected mailboxes wait for a person. */
export function healthCheckDue(box: MailboxState, now: Date): boolean {
  if (box.status === "disconnected") return false;
  if (!box.lastCheckedAt) return true;
  const age = now.getTime() - box.lastCheckedAt.getTime();
  return age >= (box.status === "error" ? ERROR_RECHECK_MS : HEALTHY_RECHECK_MS);
}

/** Replies not read for this long (the sweep runs every minute) mean reply tracking has stalled. */
export const SYNC_STALE_MS = 30 * 60_000;

export type ReplyTrackingState = { email: string; imapEnabled: boolean; imapHost: string; lastSyncedAt: Date | null; syncError: string };

/**
 * Why replies to this mailbox's emails might not stop a sequence, or null
 * when reply tracking is working: IMAP off, the last sync failing, or no
 * successful sync recently. Shown as a campaign launch-readiness warning.
 */
export function replyTrackingProblem(box: ReplyTrackingState, now: Date): string | null {
  if (!box.imapEnabled || !box.imapHost) return `Reply tracking (IMAP) is off for ${box.email}, so replies to its emails will not stop the sequence.`;
  if (box.syncError) return `Reading replies for ${box.email} is failing (${box.syncError.slice(0, 200)}), so replies may not stop the sequence.`;
  if (!box.lastSyncedAt) return `Replies to ${box.email} have not been read yet, so stop-on-reply works only once its first sync succeeds.`;
  const age = now.getTime() - box.lastSyncedAt.getTime();
  if (age >= SYNC_STALE_MS) return `Replies to ${box.email} were last read ${Math.round(age / 60_000)} minutes ago, so stop-on-reply may act late.`;
  return null;
}

/**
 * Whether follow-ups sent from this mailbox should wait (EngineService, for
 * stop-on-reply campaigns): reply tracking is on, but no sync pass has
 * succeeded within SYNC_STALE_MS, or none ever has. A failing sync never moves
 * lastSyncedAt, so it goes stale too, after the same 30 minutes, so one
 * passing blip does not stall every thread. Notes about single unreadable
 * messages on a pass that succeeded hold nothing: replies are being read.
 * IMAP off returns false: that is a setting, not a stall, and waiting for it
 * would never end (launch readiness warns about it instead).
 */
export function replyTrackingStalled(box: Pick<ReplyTrackingState, "imapEnabled" | "imapHost" | "lastSyncedAt">, now: Date): boolean {
  if (!box.imapEnabled || !box.imapHost) return false;
  return !box.lastSyncedAt || now.getTime() - box.lastSyncedAt.getTime() >= SYNC_STALE_MS;
}
