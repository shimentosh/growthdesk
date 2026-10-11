import { z } from "zod";
import { CALL_OUTCOMES, CALL_STATUSES, type CallOutcome, type CallStatus } from "./enums.js";
import { ListQuery, StartCallInput, isoDate, optionalUuid, text, uuid } from "./schemas.js";

/*
 * Calling: the inputs the calls API takes beyond the ones in schemas.ts
 * (TwilioConnectInput, CallLogInput, StartCallInput, CallScriptInput), and
 * the pure rules both sides read.
 */

export const CALL_PROVIDERS = ["manual", "twilio"] as const;
export type CallProvider = (typeof CALL_PROVIDERS)[number];

/** Statuses after which nothing more happens on the line. */
export const FINAL_CALL_STATUSES: readonly CallStatus[] = ["completed", "busy", "no_answer", "failed", "canceled"];
export const isFinalCallStatus = (s: string): boolean => (FINAL_CALL_STATUSES as readonly string[]).includes(s);

/**
 * The line status a manually logged call is recorded with. "Busy" and "No
 * answer" describe the line itself; every other outcome means somebody (or a
 * voicemail box) picked up, so the call completed.
 */
export function statusForOutcome(outcome: CallOutcome): CallStatus {
  if (outcome === "busy") return "busy";
  if (outcome === "no_answer") return "no_answer";
  return "completed";
}

/** GET /calls — the call history filters. */
export const CallListQuery = ListQuery.extend({
  contactId: z.string().uuid().optional(),
  /** "me" or a member's user id. */
  userId: z.string().max(40).optional(),
  status: z.enum(CALL_STATUSES).optional(),
  /** An outcome, or "none" for calls nobody has recorded an outcome for yet. */
  outcome: z.enum([...CALL_OUTCOMES, "none"]).optional(),
  provider: z.enum(CALL_PROVIDERS).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
});

/** PATCH /calls/:id — what a person records about a call after (or during) it. */
export const CallUpdateInput = z.object({
  outcome: z.enum(CALL_OUTCOMES).optional(),
  notes: text(10000).optional(),
  /** Manually logged calls only; Twilio reports the length of its own calls. */
  durationSec: z.number().int().min(0).max(86400).nullable().optional(),
  callbackAt: isoDate.nullable().optional(),
  scriptId: optionalUuid,
});

/** POST /calls/dial — click-to-call through Twilio. */
export const ClickToCallInput = StartCallInput.extend({ scriptId: optionalUuid });

/** GET /calls/queue */
export const CallQueueQuery = z.object({
  /** mine: call tasks assigned to me. team: every call task the caller may see. */
  scope: z.enum(["mine", "team"]).default("mine"),
  /** today: overdue, due today, or undated. all: every open call task. */
  window: z.enum(["today", "all"]).default("today"),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

/** POST /calls/queue — puts contacts on the caller's own call list (as call tasks). */
export const CallQueueAddInput = z.object({
  contactIds: z.array(uuid).min(1).max(200),
  dueAt: isoDate.nullable().optional(),
  note: text(1000).optional(),
});

export type CallListQueryT = z.infer<typeof CallListQuery>;
export type CallUpdateInputT = z.infer<typeof CallUpdateInput>;
export type ClickToCallInputT = z.infer<typeof ClickToCallInput>;
export type CallQueueAddInputT = z.infer<typeof CallQueueAddInput>;
