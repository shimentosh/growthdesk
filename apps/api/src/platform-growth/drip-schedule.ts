import type { PlatformDripTrigger } from "@growthdesk/shared";

/*
 * Drip timing (pure, unit-tested).
 *
 * A step's delay counts from the trigger (step 1) or from the moment the
 * previous step was sent (later steps), so a late sweep never bunches two
 * steps together. Enrollment only considers triggers that happened AFTER the
 * sequence was activated and within ENROLL_WINDOW_MS of now: history is never
 * backfilled, and someone who only becomes eligible weeks later (consent given
 * long after signing up) does not suddenly get a "welcome" email.
 */

export const HOUR_MS = 3_600_000;
/** trial_ending fires this long before trialEndsAt. */
export const TRIAL_ENDING_LEAD_MS = 3 * 24 * HOUR_MS;
/** trial_ended waits this long after trialEndsAt, so a trial the provider is converting right now is not told it ended. */
export const TRIAL_ENDED_GRACE_MS = HOUR_MS;
/** How far back a trigger may lie and still enroll. */
export const ENROLL_WINDOW_MS = 7 * 24 * HOUR_MS;

export const addHours = (at: Date, hours: number) => new Date(at.getTime() + Math.max(0, hours) * HOUR_MS);

/** When step 1 is due for a trigger at `triggeredAt`. */
export const firstRunAt = (triggeredAt: Date, firstDelayHours: number) => addHours(triggeredAt, firstDelayHours);

/** When the step after the one just sent is due. */
export const nextRunAfter = (sentAt: Date, nextDelayHours: number) => addHours(sentAt, nextDelayHours);

/** The earliest moment a trigger may have happened and still enroll. */
export function enrollFloor(activatedAt: Date, now: Date): Date {
  return new Date(Math.max(activatedAt.getTime(), now.getTime() - ENROLL_WINDOW_MS));
}

/** Whether a trigger at `at` enrolls into a sequence activated at `activatedAt` (strictly after it, not in the future, within the window). */
export function triggerEnrolls(at: Date, activatedAt: Date, now: Date): boolean {
  return at.getTime() > activatedAt.getTime() && at.getTime() <= now.getTime() && at.getTime() > now.getTime() - ENROLL_WINDOW_MS;
}

/** The moment a trial trigger fires, from the subscription's trial end. */
export function trialTriggerAt(trigger: Extract<PlatformDripTrigger, "trial_ending" | "trial_ended">, trialEndsAt: Date): Date {
  return trigger === "trial_ending" ? new Date(trialEndsAt.getTime() - TRIAL_ENDING_LEAD_MS) : new Date(trialEndsAt.getTime() + TRIAL_ENDED_GRACE_MS);
}

export type StepLike = { id: string; position: number; delayHours: number };

/** The step to send for an enrollment at `position` (the first at or after it), and the one after that. */
export function stepAt<T extends StepLike>(steps: T[], position: number): { step: T | null; next: T | null } {
  const sorted = [...steps].sort((a, b) => a.position - b.position);
  const i = sorted.findIndex((s) => s.position >= position);
  if (i < 0) return { step: null, next: null };
  return { step: sorted[i]!, next: sorted[i + 1] ?? null };
}

/** After sending `step` at `sentAt`: where the enrollment goes next. */
export function advance<T extends StepLike>(steps: T[], sent: T, sentAt: Date): { nextStepPosition: number; nextRunAt: Date | null; status: "active" | "completed" } {
  const { step: next } = stepAt(steps, sent.position + 1);
  if (!next) return { nextStepPosition: sent.position + 1, nextRunAt: null, status: "completed" };
  return { nextStepPosition: next.position, nextRunAt: nextRunAfter(sentAt, next.delayHours), status: "active" };
}
