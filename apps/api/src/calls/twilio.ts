import { createHmac } from "node:crypto";
import { safeEqual } from "../common/crypto.js";

/*
 * Twilio Programmable Voice over plain HTTP (no SDK). Used for click-to-call:
 * Twilio first rings the rep's own phone (agentNumber), and when the rep
 * answers, our TwiML bridges the call to the contact with <Dial>.
 *
 * Base URL overridable for tests: TWILIO_API_URL (default https://api.twilio.com),
 * read on every call. Never set it in production.
 *
 * Compliance (enforced or documented here because it cannot be by code alone):
 *  - No recording. Nothing in this integration asks Twilio to record, so no
 *    recording-consent announcement is needed; if recording is ever added,
 *    two-party-consent jurisdictions require announcing it before the bridge.
 *  - Every call is a person pressing "Call" for one contact — there is no
 *    auto-dialer / power dialer, and no prerecorded messages, which is what
 *    the US TCPA and UK PECR restrict most tightly.
 *  - The do-not-contact list (Suppression) and the contact's doNotContact
 *    flag are checked immediately before Twilio is asked to dial.
 *  - Calling hours, national do-not-call registries (e.g. US DNC, UK TPS)
 *    and caller-ID rules are the workspace's responsibility; the caller id
 *    must be a Twilio number or a verified caller id on the account.
 */

const TIMEOUT_MS = 15_000;
export const twilioBase = () => (process.env.TWILIO_API_URL?.trim() || "https://api.twilio.com").replace(/\/+$/, "");

export class TwilioError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "TwilioError";
  }
}

async function twilio<T>(accountSid: string, authToken: string, method: "GET" | "POST", path: string, form?: URLSearchParams): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${twilioBase()}/2010-04-01/Accounts/${encodeURIComponent(accountSid)}${path}`, {
      method,
      headers: {
        authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`,
        ...(form ? { "content-type": "application/x-www-form-urlencoded" } : {}),
      },
      body: form ? form.toString() : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    const err = e as { name?: string; cause?: { code?: string } };
    throw new TwilioError(err.name === "TimeoutError" ? "Twilio did not answer in time" : `Twilio could not be reached${err.cause?.code ? ` (${err.cause.code})` : ""}`, 0);
  }
  const payload = (await res.json().catch(() => ({}))) as T & { message?: string; code?: number };
  if (!res.ok) throw new TwilioError(payload.message || `Twilio answered HTTP ${res.status}`, res.status);
  return payload;
}

export const twilioApi = {
  /** Proves the SID + auth token pair. */
  async account(accountSid: string, authToken: string): Promise<{ friendlyName: string; status: string }> {
    const r = await twilio<{ friendly_name?: string; status?: string }>(accountSid, authToken, "GET", ".json");
    return { friendlyName: r.friendly_name ?? "", status: r.status ?? "" };
  },

  async createCall(
    accountSid: string,
    authToken: string,
    input: { to: string; from: string; twimlUrl: string; statusUrl: string },
  ): Promise<{ sid: string; status: string }> {
    const form = new URLSearchParams();
    form.set("To", input.to);
    form.set("From", input.from);
    form.set("Url", input.twimlUrl);
    form.set("Method", "POST");
    form.set("StatusCallback", input.statusUrl);
    form.set("StatusCallbackMethod", "POST");
    for (const ev of ["initiated", "ringing", "answered", "completed"]) form.append("StatusCallbackEvent", ev);
    const r = await twilio<{ sid?: string; status?: string }>(accountSid, authToken, "POST", "/Calls.json", form);
    return { sid: r.sid ?? "", status: r.status ?? "queued" };
  },
};

/**
 * Twilio's request signature: HMAC-SHA1, keyed with the auth token, over the
 * full URL Twilio requested followed by every POST parameter as key+value,
 * keys sorted; base64.
 */
export function twilioSignature(authToken: string, url: string, params: Record<string, unknown>): string {
  let data = url;
  for (const key of Object.keys(params).sort()) {
    const value = params[key];
    const values = Array.isArray(value) ? value : [value];
    for (const v of values) data += key + (v === undefined || v === null ? "" : String(v));
  }
  return createHmac("sha1", authToken).update(Buffer.from(data, "utf8")).digest("base64");
}

export function twilioSignatureOk(authToken: string, url: string, params: Record<string, unknown>, header: string | undefined | null): boolean {
  if (!authToken || !header) return false;
  return safeEqual(twilioSignature(authToken, url, params), header);
}

/** Twilio CallStatus → our CallStatus. */
export const TWILIO_STATUS: Record<string, "queued" | "ringing" | "in_progress" | "completed" | "busy" | "no_answer" | "failed" | "canceled"> = {
  queued: "queued",
  initiated: "queued",
  ringing: "ringing",
  "in-progress": "in_progress",
  answered: "in_progress",
  completed: "completed",
  busy: "busy",
  "no-answer": "no_answer",
  failed: "failed",
  canceled: "canceled",
};

export const escapeXml = (s: string) => s.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]!);
