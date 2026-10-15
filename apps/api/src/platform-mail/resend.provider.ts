import { Injectable } from "@nestjs/common";
import { PlatformSettingsService } from "../core/platform-settings.service.js";
import { type OutgoingMail, type PlatformMailProvider, ProviderError, type SendResult } from "./provider.js";

/*
 * Resend over plain fetch (no SDK). Facts checked against resend.com/docs
 * (October 2026):
 *   - POST /emails → { id }. Body: from, to, subject, html, text, reply_to,
 *     headers, tags[{name,value}] (ASCII letters/digits/_/-, ≤256 chars).
 *   - POST /emails/batch → { data: [{ id }] } in request order; ≤100 emails;
 *     attachments are not supported there. The docs do not say whether `tags`
 *     are accepted in batch — UNVERIFIED; we send them, and the webhook falls
 *     back to matching by the email id alone if they are dropped.
 *   - Idempotency-Key header: ≤256 chars, remembered for 24 hours. Same key +
 *     different body within the window → 409 invalid_idempotent_request; a
 *     concurrent duplicate → 409 concurrent_idempotent_requests.
 *   - Default rate limit: 10 requests/second per team (all keys share it);
 *     429 rate_limit_exceeded with retry-after / ratelimit-reset headers.
 *     429 daily_quota_exceeded / monthly_quota_exceeded are quota, not rate.
 *   - 401 missing/restricted key; 403 invalid/suspended key, unverified
 *     domain, testing-mode recipient — and a request WITHOUT a User-Agent is
 *     refused with 403, so we always send one.
 *   - Error body: { statusCode, name, message } (the SDK's shape; the docs
 *     list names but not the body) — parsed defensively.
 *   - GET /domains → { object, has_more, data: [{ id, name, status, region,
 *     created_at, capabilities }] } without records; GET /domains/:id adds
 *     records [{ record, name, type, ttl, status, value, priority? }].
 *     POST /domains/:id/verify → { object: "domain", id } and verifies
 *     asynchronously. Status values beyond "not_started"/"pending"/"verified"/
 *     "failed"/"temporary_failure" are UNVERIFIED; we pass them through.
 *
 * RESEND_API_URL points the client at a local fake (tests only).
 */

export const resendBase = () => (process.env.RESEND_API_URL?.trim() || "https://api.resend.com").replace(/\/+$/, "");
const USER_AGENT = "growthdesk-platform-mail/1.0";
const TIMEOUT_MS = 15_000;

type HeaderBag = { get(name: string): string | null };

/** Seconds (or an HTTP date) from retry-after, else ratelimit-reset seconds; null when neither is usable. */
export function retryAfterMs(headers: HeaderBag, now = Date.now()): number | null {
  const raw = headers.get("retry-after")?.trim();
  if (raw) {
    if (/^\d+(\.\d+)?$/.test(raw)) return Math.ceil(Number(raw) * 1000);
    const at = Date.parse(raw);
    if (!Number.isNaN(at)) return Math.max(0, at - now);
  }
  const reset = headers.get("ratelimit-reset")?.trim();
  if (reset && /^\d+(\.\d+)?$/.test(reset)) return Math.ceil(Number(reset) * 1000);
  return null;
}

/** Turns a non-2xx Resend answer into a classified ProviderError (see provider.ts). */
export function classifyResendFailure(status: number, body: unknown, headers: HeaderBag): ProviderError {
  const b = (body && typeof body === "object" ? body : {}) as { name?: unknown; message?: unknown; error?: unknown };
  const name = typeof b.name === "string" ? b.name : "";
  const detail = typeof b.message === "string" ? b.message : typeof b.error === "string" ? b.error : "";
  const msg = (what: string) => `Resend ${status}${name ? ` ${name}` : ""}: ${detail || what}`;
  if (status === 401 || status === 403) return new ProviderError("auth", msg("the API key was refused"), status, name);
  if (status === 429) {
    if (/quota/i.test(name)) return new ProviderError("quota", msg("the sending quota is used up"), status, name, retryAfterMs(headers));
    return new ProviderError("rate_limited", msg("too many requests"), status, name, retryAfterMs(headers) ?? 1000);
  }
  if (status === 409 && name !== "invalid_idempotent_request") return new ProviderError("busy", msg("the same request is already in progress"), status, name, 1000);
  if (status >= 500) return new ProviderError("unknown_outcome", msg("server error"), status, name);
  // 400 validation / bad idempotency key, 404/405 wrong endpoint, 409 key reused with another body, 422 invalid fields.
  return new ProviderError("rejected", msg("the request was refused"), status, name);
}

export type ResendDomainRecord = { record: string; name: string; type: string; ttl: string; status: string; value: string; priority: number | null };
export type ResendDomain = {
  id: string;
  name: string;
  status: string;
  region: string;
  createdAt: string | null;
  records: ResendDomainRecord[];
};

@Injectable()
export class ResendProvider implements PlatformMailProvider {
  readonly id = "resend" as const;

  constructor(private readonly settings: PlatformSettingsService) {}

  async isConfigured(): Promise<boolean> {
    return Boolean(await this.settings.resendApiKey());
  }

  private async request<T>(method: "GET" | "POST", path: string, body?: unknown, idempotencyKey?: string): Promise<T> {
    const key = await this.settings.resendApiKey();
    if (!key) throw new ProviderError("auth", "No Resend API key is configured");
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
      // Timeout, reset, DNS: the request may or may not have reached Resend.
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

  private payload(mail: OutgoingMail) {
    return {
      from: mail.from,
      to: [mail.to],
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
      ...(mail.replyTo ? { reply_to: mail.replyTo } : {}),
      ...(mail.headers && Object.keys(mail.headers).length ? { headers: mail.headers } : {}),
      ...(mail.tags?.length ? { tags: mail.tags } : {}),
    };
  }

  async send(mail: OutgoingMail, idempotencyKey: string): Promise<SendResult> {
    const out = await this.request<{ id?: string }>("POST", "/emails", this.payload(mail), idempotencyKey);
    return { providerMessageId: out?.id ?? null };
  }

  /**
   * Up to 100 emails in one request (platform marketing). Idempotency key:
   * `${broadcastId}:${batchNo}`. Ids come back in request order.
   */
  async sendBatch(mails: OutgoingMail[], idempotencyKey: string): Promise<SendResult[]> {
    if (mails.length === 0) return [];
    if (mails.length > 100) throw new ProviderError("rejected", "A Resend batch holds at most 100 emails");
    const out = await this.request<{ data?: { id?: string }[] }>("POST", "/emails/batch", mails.map((m) => this.payload(m)), idempotencyKey);
    return mails.map((_, i) => ({ providerMessageId: out?.data?.[i]?.id ?? null }));
  }

  /** Sending domains with their DNS records (one detail call per domain; accounts have few). */
  async domains(): Promise<ResendDomain[]> {
    const list = await this.request<{ data?: Record<string, unknown>[] }>("GET", "/domains");
    const rows = (list?.data ?? []).slice(0, 20);
    return Promise.all(
      rows.map(async (d) => {
        const detail = await this.request<Record<string, unknown>>("GET", `/domains/${encodeURIComponent(String(d.id))}`).catch(() => d);
        return parseResendDomain({ ...d, ...detail });
      }),
    );
  }

  async verifyDomain(id: string): Promise<{ id: string }> {
    const out = await this.request<{ id?: string }>("POST", `/domains/${encodeURIComponent(id)}/verify`);
    return { id: out?.id ?? id };
  }
}

const s = (v: unknown) => (typeof v === "string" ? v : v === undefined || v === null ? "" : String(v));

export function parseResendDomain(d: Record<string, unknown>): ResendDomain {
  const records = Array.isArray(d.records) ? (d.records as Record<string, unknown>[]) : [];
  return {
    id: s(d.id),
    name: s(d.name),
    status: s(d.status),
    region: s(d.region),
    createdAt: typeof d.created_at === "string" ? d.created_at : null,
    records: records.map((r) => ({
      record: s(r.record),
      name: s(r.name),
      type: s(r.type),
      ttl: s(r.ttl),
      status: s(r.status),
      value: s(r.value),
      priority: typeof r.priority === "number" ? r.priority : null,
    })),
  };
}
