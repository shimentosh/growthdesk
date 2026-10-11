/*
 * How platform mail leaves the building. Two providers implement the same
 * interface: Resend (HTTP API, idempotent, webhooks for delivery events) and
 * SMTP (nodemailer; Mailpit in development, any relay in production).
 *
 * Failures are classified, because the classification decides what is safe:
 *
 *   auth            the provider refused our credentials (401/403). Nothing was
 *                   sent → safe to fall back to SMTP.
 *   rejected        the provider refused this message (400/404/422, SMTP 5xx).
 *                   Retrying the same message will not help → failed.
 *   rate_limited    too many requests per second (429). Retry after `retryAfterMs`.
 *   quota           daily/monthly sending quota used up (429). Retry later.
 *   busy            the same idempotency key is in flight (409). Retry.
 *   unknown_outcome a timeout, dropped connection or 5xx: the message MAY have
 *                   gone out. Retry only through the same provider with the same
 *                   Idempotency-Key (Resend dedupes for 24 h) — never fall back
 *                   to SMTP, which would send it a second time.
 */

export type MailTag = { name: string; value: string };

export type OutgoingMail = {
  from: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
  headers?: Record<string, string>;
  tags?: MailTag[];
};

export type ProviderFailureKind = "auth" | "rejected" | "rate_limited" | "quota" | "busy" | "unknown_outcome";

export class ProviderError extends Error {
  constructor(
    readonly kind: ProviderFailureKind,
    message: string,
    readonly status: number | null = null,
    /** Provider error name (Resend `name`, SMTP response code). */
    readonly code: string = "",
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = "ProviderError";
  }

  /** Worth another attempt through the same provider. */
  get retryable() {
    return this.kind === "rate_limited" || this.kind === "quota" || this.kind === "busy" || this.kind === "unknown_outcome";
  }

  /** Nothing was sent and our credentials are the problem: SMTP may take over. */
  get allowsFallback() {
    return this.kind === "auth";
  }
}

export const isProviderError = (e: unknown): e is ProviderError => e instanceof ProviderError;

export type SendResult = { providerMessageId: string | null };

export interface PlatformMailProvider {
  readonly id: "smtp" | "resend";
  /** `idempotencyKey` is honoured by providers that support it (Resend); SMTP ignores it. */
  send(mail: OutgoingMail, idempotencyKey: string): Promise<SendResult>;
}

/** Tag names/values Resend accepts: ASCII letters, digits, _ and -, up to 256 characters. */
export const tagValue = (v: string) => v.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 256);

/** "Name <a@b.c>" → "a@b.c"; a bare address passes through. */
export const addressOf = (from: string) => (from.match(/<\s*([^<>\s]+)\s*>/)?.[1] ?? from).trim();
/** "Name <a@b.c>" → "Name"; "" for a bare address. */
export const displayNameOf = (from: string) => (from.includes("<") ? from.slice(0, from.indexOf("<")).trim().replace(/^"|"$/g, "") : "");
