import { classifyResendFailure, parseResendDomain, resendBase, type ResendDomain } from "../platform-mail/resend.provider.js";
import { ProviderError } from "../platform-mail/provider.js";
import type { SendFailure } from "../messaging/smtp.js";

/*
 * A workspace's own Resend account, as its marketing email service. Same API
 * facts as platform-mail/resend.provider.ts (which talks to the platform's
 * account); this one takes the workspace's key on every call.
 *
 *   POST /domains { name, region } → { id, name, status, region, records[] }
 *   GET /domains/:id → the domain with records[{ record, name, type, ttl, status, value, priority? }]
 *   POST /domains/:id/verify → verifies asynchronously; read the status back with GET.
 *   POST /emails → { id }; Idempotency-Key remembered for 24 hours.
 *   A "Sending access" key is refused on /domains with 401 restricted_api_key.
 */

const USER_AGENT = "growthdesk-marketing/1.0";
const TIMEOUT_MS = 15_000;

async function call<T>(key: string, method: "GET" | "POST", path: string, body?: unknown, idempotencyKey?: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${resendBase()}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${key}`,
        "user-agent": USER_AGENT,
        accept: "application/json",
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...(idempotencyKey ? { "idempotency-key": idempotencyKey.slice(0, 256) } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: "error",
    });
  } catch (e) {
    throw new ProviderError("unknown_outcome", `Resend did not answer: ${e instanceof Error ? e.message : String(e)}`);
  }
  const text = await res.text().catch(() => "");
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) throw classifyResendFailure(res.status, json ?? { message: text.slice(0, 300) }, res.headers);
  return json as T;
}

/** Checks the key can manage domains (a Full access key). Returns the account's domains. */
export async function resendCheckKey(key: string): Promise<{ id: string; name: string }[]> {
  try {
    const out = await call<{ data?: { id?: string; name?: string }[] }>(key, "GET", "/domains");
    return (out?.data ?? []).map((d) => ({ id: String(d.id ?? ""), name: String(d.name ?? "") }));
  } catch (e) {
    if (e instanceof ProviderError && e.code === "restricted_api_key") {
      throw new ProviderError("auth", "This key only has Sending access. Create one with Full access so domains can be added from here.", e.status, e.code);
    }
    throw e;
  }
}

/** Creates the domain at Resend, or adopts it when the account already has it. */
export async function resendEnsureDomain(key: string, name: string, region: string): Promise<ResendDomain> {
  const existing = (await resendCheckKey(key)).find((d) => d.name.toLowerCase() === name);
  if (existing) return resendDomain(key, existing.id);
  const created = await call<Record<string, unknown>>(key, "POST", "/domains", { name, region });
  return parseResendDomain(created ?? {});
}

export async function resendDomain(key: string, id: string): Promise<ResendDomain> {
  return parseResendDomain((await call<Record<string, unknown>>(key, "GET", `/domains/${encodeURIComponent(id)}`)) ?? {});
}

/** Asks Resend to check the records again, then reads the domain back (the check itself is asynchronous). */
export async function resendVerifyDomain(key: string, id: string): Promise<ResendDomain> {
  await call(key, "POST", `/domains/${encodeURIComponent(id)}/verify`);
  return resendDomain(key, id);
}

export type ResendMail = { from: string; to: string; replyTo?: string; subject: string; html: string; text: string; headers: Record<string, string> };

/** One email; the idempotency key (our send id) keeps a retried request from sending twice. */
export async function resendSend(key: string, mail: ResendMail, idempotencyKey: string): Promise<{ sent: true; providerMessageId: string } | { sent: false; failure: SendFailure }> {
  try {
    const out = await call<{ id?: string }>(
      key,
      "POST",
      "/emails",
      {
        from: mail.from,
        to: [mail.to],
        subject: mail.subject,
        html: mail.html,
        text: mail.text,
        ...(mail.replyTo ? { reply_to: mail.replyTo } : {}),
        headers: mail.headers,
      },
      idempotencyKey,
    );
    return { sent: true, providerMessageId: out?.id ?? idempotencyKey };
  } catch (e) {
    const err = e instanceof ProviderError ? e : new ProviderError("unknown_outcome", e instanceof Error ? e.message : String(e));
    return { sent: false, failure: resendFailure(err) };
  }
}

/** A Resend refusal in the terms the marketing sender acts on. */
export function resendFailure(e: ProviderError): SendFailure {
  switch (e.kind) {
    case "auth":
      // Bad or revoked key, unverified domain: nothing sends until someone fixes the service.
      return { error: e.message, outcome: "rejected", mailboxAtFault: true };
    case "quota":
      return { error: e.message, outcome: "deferred", mailboxAtFault: true };
    case "rate_limited":
    case "busy":
      return { error: e.message, outcome: "deferred", mailboxAtFault: false };
    case "unknown_outcome":
      return { error: e.message, outcome: "unknown", mailboxAtFault: false };
    default:
      return { error: e.message, outcome: "rejected", mailboxAtFault: false };
  }
}
