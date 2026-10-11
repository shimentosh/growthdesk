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
