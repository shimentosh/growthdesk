import nodemailer, { type Transporter } from "nodemailer";

/*
 * SMTP sending for connected mailboxes. Ported from LinkDesk
 * (mailbox.service.ts transportFor/sendFrom, send-outcome.ts
 * classifySmtpError) with two changes: the transport cache key includes a
 * fingerprint of the credentials, so a changed password or refreshed OAuth
 * token can never keep using a stale pooled connection; and XOAUTH2 is
 * supported for Gmail / Microsoft 365 mailboxes.
 */

export type SmtpAuth = { user: string; pass: string } | { user: string; accessToken: string };

export type SmtpSettings = {
  mailboxId: string;
  host: string;
  port: number;
  security: string;
  auth: SmtpAuth;
  allowSelfSigned: boolean;
};

export type OutgoingMail = {
  from: string;
  to: string;
  subject: string;
  text: string;
  html?: string;
  messageId: string;
  inReplyTo?: string | null;
  references?: string | null;
  headers?: Record<string, string>;
};

export type SendFailure = {
  error: string;
  /** deferred: try later. rejected: will not succeed as-is. unknown: may have been delivered — never resend automatically. */
  outcome: "deferred" | "rejected" | "unknown";
  mailboxAtFault: boolean;
};

export type SendResult = { sent: true; messageId: string; response: string } | { sent: false; failure: SendFailure };

type SmtpError = { message?: string; code?: string; responseCode?: number; command?: string };

const NEVER_CONNECTED = /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|Connection timeout|Greeting never received/i;

/** Ported verbatim in behaviour from LinkDesk send-outcome.ts. */
export function classifySmtpError(e: unknown): SendFailure {
  const err = (e && typeof e === "object" ? e : { message: String(e) }) as SmtpError;
  const error = err.message || String(e);
  const code = err.code ?? "";
  const status = typeof err.responseCode === "number" ? err.responseCode : 0;
  // The server answered, so the answer is authoritative.
  if (status >= 500) return { error, outcome: "rejected", mailboxAtFault: code === "EAUTH" || /^(AUTH|MAIL)/.test(err.command ?? "") };
  if (status >= 400) return { error, outcome: "deferred", mailboxAtFault: false };
  if (code === "EAUTH") return { error, outcome: "rejected", mailboxAtFault: true };
  if (["EENVELOPE", "EMESSAGE", "EREQUIRETLS", "ESTREAM"].includes(code)) return { error, outcome: "rejected", mailboxAtFault: false };
  if (code === "ECONNECTION" || code === "EDNS" || code === "ETLS" || NEVER_CONNECTED.test(error)) return { error, outcome: "deferred", mailboxAtFault: true };
  // A timeout or dropped socket mid-conversation: it may have been delivered.
  return { error, outcome: "unknown", mailboxAtFault: false };
}

const fingerprint = (s: SmtpSettings) =>
  [s.host, s.port, s.security, s.auth.user, "pass" in s.auth ? s.auth.pass : s.auth.accessToken].join("|");

const pool = new Map<string, { key: string; transport: Transporter }>();

function transportFor(s: SmtpSettings): Transporter {
  const key = fingerprint(s);
  const held = pool.get(s.mailboxId);
  if (held?.key === key) return held.transport;
  held?.transport.close();
  const transport = nodemailer.createTransport({
    host: s.host,
    port: s.port,
    // 465 is TLS from the first byte; 587/25 start plain and upgrade with STARTTLS.
    secure: s.security === "ssl" || s.port === 465,
    requireTLS: s.security === "starttls",
    ignoreTLS: s.security === "none",
    auth: "pass" in s.auth ? { user: s.auth.user, pass: s.auth.pass } : { type: "OAuth2", user: s.auth.user, accessToken: s.auth.accessToken },
    tls: { rejectUnauthorized: !s.allowSelfSigned },
    pool: true,
    // One connection per mailbox: pacing, not throughput, is what protects a sending domain.
    maxConnections: 1,
    maxMessages: 100,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 60_000,
  });
  pool.set(s.mailboxId, { key, transport });
  return transport;
}

export function dropTransport(mailboxId: string) {
  pool.get(mailboxId)?.transport.close();
  pool.delete(mailboxId);
}

export async function sendSmtp(s: SmtpSettings, mail: OutgoingMail): Promise<SendResult> {
  try {
    const info = await transportFor(s).sendMail({
      from: mail.from,
      to: mail.to,
      subject: mail.subject,
      text: mail.text,
      ...(mail.html ? { html: mail.html } : {}),
      messageId: mail.messageId,
      ...(mail.inReplyTo ? { inReplyTo: mail.inReplyTo, references: mail.references || mail.inReplyTo } : {}),
      ...(mail.headers ? { headers: mail.headers } : {}),
    });
    return { sent: true, messageId: info.messageId ?? mail.messageId, response: String(info.response ?? "") };
  } catch (e) {
    dropTransport(s.mailboxId);
    return { sent: false, failure: classifySmtpError(e) };
  }
}

/** Opens a connection and authenticates, without sending (used when connecting a mailbox). */
export async function verifySmtp(s: SmtpSettings): Promise<{ ok: true } | { ok: false; error: string }> {
  const t = nodemailer.createTransport({
    host: s.host,
    port: s.port,
    secure: s.security === "ssl" || s.port === 465,
    requireTLS: s.security === "starttls",
    ignoreTLS: s.security === "none",
    auth: "pass" in s.auth ? { user: s.auth.user, pass: s.auth.pass } : { type: "OAuth2", user: s.auth.user, accessToken: s.auth.accessToken },
    tls: { rejectUnauthorized: !s.allowSelfSigned },
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
  });
  try {
    await t.verify();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    t.close();
  }
}
