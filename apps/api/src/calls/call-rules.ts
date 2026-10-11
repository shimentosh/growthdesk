import { isFinalCallStatus, labelOf, type CallOutcome, type CallStatus } from "@growthdesk/shared";
import { escapeXml, TWILIO_STATUS } from "./twilio.js";

/*
 * Pure rules of the calling area — how Twilio's reports move a call along,
 * the TwiML we answer with, and the words the timeline uses — kept free of
 * the database so they are unit-tested on their own (call-rules.spec.ts).
 */

/** How far along a call is. Twilio's callbacks can arrive out of order; a call never moves backwards. */
const RANK: Record<CallStatus, number> = { queued: 0, ringing: 1, in_progress: 2, completed: 3, busy: 3, no_answer: 3, failed: 3, canceled: 3 };

/** The status to store when Twilio reports `next`, or null when it would move the call backwards (or sideways from an end). */
export function advance(current: CallStatus, next: CallStatus): CallStatus | null {
  if (isFinalCallStatus(current)) return null;
  return RANK[next] > RANK[current] ? next : null;
}

/**
 * The contact's leg, from <Dial action>'s DialCallStatus. This is the
 * authoritative end of a click-to-call: it describes the person we called,
 * not the rep's own phone.
 */
export function dialResult(dialCallStatus: string | undefined): CallStatus {
  if (dialCallStatus === "answered") return "completed";
  const s = TWILIO_STATUS[dialCallStatus ?? ""];
  return s && isFinalCallStatus(s) ? s : "failed";
}

/**
 * The rep's own leg ended (parent StatusCallback) and no <Dial> result came
 * first. If our TwiML was never fetched (status still queued/ringing), the
 * rep did not pick up and the contact was never dialled: the call is
 * canceled. Otherwise the leg's own final status stands.
 */
export function parentEnded(current: CallStatus, parentStatus: CallStatus): CallStatus {
  if (current === "in_progress") return isFinalCallStatus(parentStatus) ? parentStatus : "completed";
  return "canceled";
}

/** Outcomes Twilio's own report establishes — the contact's line was busy or nobody answered. Everything else a person records. */
export function outcomeFromStatus(status: CallStatus): CallOutcome | null {
  if (status === "busy") return "busy";
  if (status === "no_answer") return "no_answer";
  return null;
}

/** TwiML that bridges the answering rep to the contact. answerOnBridge keeps the rep hearing the ring until the contact picks up. */
export function dialTwiml(input: { callerId: string; to: string; actionUrl: string; timeoutSec?: number }): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?><Response>` +
    `<Dial callerId="${escapeXml(input.callerId)}" action="${escapeXml(input.actionUrl)}" method="POST" answerOnBridge="true" timeout="${input.timeoutSec ?? 30}">` +
    `<Number>${escapeXml(input.to)}</Number></Dial></Response>`
  );
}

/** Spoken to the rep (never the contact) when a call cannot go ahead, then hang up. */
export function refusalTwiml(message: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Say>${escapeXml(message)}</Say><Hangup/></Response>`;
}

export const EMPTY_TWIML = `<?xml version="1.0" encoding="UTF-8"?><Response/>`;

/**
 * Why Twilio could not reach this deployment's webhooks, or null when it
 * can. Twilio fetches our TwiML over the public internet, so a loopback or
 * .local PUBLIC_APP_URL means the rep's phone would ring and then fail.
 * TWILIO_API_URL (a local fake, tests only) is on the same machine, so it can.
 */
export function webhookReachability(publicAppUrl: string, twilioApiOverridden: boolean): string | null {
  if (twilioApiOverridden) return null;
  let host: string;
  try {
    host = new URL(publicAppUrl).hostname.toLowerCase();
  } catch {
    return "PUBLIC_APP_URL is not a valid URL.";
  }
  const local = host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host === "::1" || host === "[::1]" || /^127\./.test(host) || host === "0.0.0.0";
  return local ? `Click-to-call needs a public address Twilio can reach. PUBLIC_APP_URL is ${publicAppUrl}, which only this machine can open.` : null;
}

/** "Connected · 3m 12s" — the timeline line for a finished call. */
export function callSummary(input: { contactName: string; outcome: string; status: CallStatus; durationSec: number | null; provider: string }): string {
  const who = input.contactName || "the contact";
  const parts = [input.outcome ? labelOf(input.outcome) : labelOf(input.status)];
  if (input.durationSec) parts.push(formatSeconds(input.durationSec));
  return `${input.provider === "twilio" ? "Called" : "Logged a call with"} ${who}: ${parts.join(" · ")}`;
}

export function formatSeconds(total: number): string {
  const s = Math.max(0, Math.round(total));
  const m = Math.floor(s / 60);
  return m ? `${m}m ${s % 60}s` : `${s}s`;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID.test(v);
