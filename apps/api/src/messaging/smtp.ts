import net from "node:net";
import nodemailer, { type Transporter } from "nodemailer";

/*
 * SMTP sending for connected mailboxes. Ported from LinkDesk
 * (mailbox.service.ts transportFor/sendFrom, send-outcome.ts
 * classifySmtpError) with two changes: the transport cache key includes a
 * fingerprint of the credentials, so a changed password or refreshed OAuth
 * token can never keep using a stale pooled connection; and XOAUTH2 is
 * supported for Gmail / Microsoft 365 mailboxes.
 *
 * DNS rebinding (GAP_PLAN 2.10): the caller may pass `address`, the IP that
 * net-guard's resolvePinnedTarget vetted. The socket then opens to exactly
 * that address, while `host` stays the name the TLS certificate (and SNI) is
 * checked against, so a name that answers differently a moment later cannot
 * steer the connection somewhere else.
 */

export type SmtpAuth = { user: string; pass: string } | { user: string; accessToken: string };

export type SmtpSettings = {
  mailboxId: string;
  host: string;
  /** The vetted IP to connect to instead of resolving `host` again (resolvePinnedTarget). */
  address?: string;
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
  /**
   * The server refused the address itself (enhanced status 5.1.x: no such
   * user, bad domain, bad syntax). A synchronous hard bounce: record it as
   * one so the address is suppressed.
   */
  badAddress?: boolean;
};

export type SendResult = { sent: true; messageId: string; response: string } | { sent: false; failure: SendFailure };

type SmtpError = { message?: string; code?: string; responseCode?: number; command?: string; response?: string };

/** nodemailer's pool refusing a queued message it never handed to the server (the pool was closed under it). */
const POOL_CLOSED = /Connection pool was closed/i;
const BAD_ADDRESS = /\b5\.1\.\d{1,3}\b/;

const NEVER_CONNECTED = /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|Connection timeout|Greeting never received/i;

/**
 * Ported in behaviour from LinkDesk send-outcome.ts, plus two cases: a
 * message the pool dropped before sending is deferred (nothing went out), and
 * a 5.1.x refusal of a recipient is flagged as a bad address.
 */
export function classifySmtpError(e: unknown): SendFailure {
  const err = (e && typeof e === "object" ? e : { message: String(e) }) as SmtpError;
  const error = err.message || String(e);
  const code = err.code ?? "";
  const status = typeof err.responseCode === "number" ? err.responseCode : 0;
  // The server answered, so the answer is authoritative.
  if (status >= 500) {
    const mailboxAtFault = code === "EAUTH" || /^(AUTH|MAIL)/.test(err.command ?? "");
    const badAddress = !mailboxAtFault && BAD_ADDRESS.test(`${err.response ?? ""} ${error}`);
    return { error, outcome: "rejected", mailboxAtFault, ...(badAddress ? { badAddress } : {}) };
  }
  if (status >= 400) return { error, outcome: "deferred", mailboxAtFault: false };
  if (POOL_CLOSED.test(error)) return { error, outcome: "deferred", mailboxAtFault: false };
  if (code === "EAUTH") return { error, outcome: "rejected", mailboxAtFault: true };
  if (["EENVELOPE", "EMESSAGE", "EREQUIRETLS", "ESTREAM"].includes(code)) return { error, outcome: "rejected", mailboxAtFault: false };
  if (code === "ECONNECTION" || code === "EDNS" || code === "ETLS" || NEVER_CONNECTED.test(error)) return { error, outcome: "deferred", mailboxAtFault: true };
  // A timeout or dropped socket mid-conversation: it may have been delivered.
  return { error, outcome: "unknown", mailboxAtFault: false };
}

// The address is part of it: when the name starts answering with another vetted IP, a fresh transport connects there.
const fingerprint = (s: SmtpSettings) =>
  [s.host, s.address ?? "", s.port, s.security, s.auth.user, "pass" in s.auth ? s.auth.pass : s.auth.accessToken].join("|");

/**
 * nodemailer options for one mailbox. With a pinned `address` the socket goes
 * to that IP and `servername` carries the name for SNI and the certificate
 * check (nodemailer hands it to tls.connect for both implicit TLS and
 * STARTTLS). An IP literal host has no name to check, so none is set.
 */
export function transportOptions(s: SmtpSettings) {
  const address = s.address && s.address !== s.host ? s.address : null;
  const servername = address && !net.isIP(s.host) ? s.host : undefined;
  return {
    host: address ?? s.host,
    port: s.port,
    ...(servername ? { servername } : {}),
    // 465 is TLS from the first byte; 587/25 start plain and upgrade with STARTTLS.
    secure: s.security === "ssl" || s.port === 465,
    requireTLS: s.security === "starttls",
    ignoreTLS: s.security === "none",
    auth: "pass" in s.auth ? { user: s.auth.user, pass: s.auth.pass } : { type: "OAuth2" as const, user: s.auth.user, accessToken: s.auth.accessToken },
    tls: { rejectUnauthorized: !s.allowSelfSigned, ...(servername ? { servername } : {}) },
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
  };
}

/*
 * Pooled transports, one per mailbox. A transport is never closed while it
 * has messages in flight or queued: nodemailer's close() fails every queued
 * message with "Connection pool was closed", and the engine would then have
 * to treat those as unconfirmed. Instead a stale transport is retired — new
 * sends get a fresh one at once — and the retired one is closed when its last
 * message settles.
 */
type MinimalTransport = Pick<Transporter, "sendMail" | "close">;
type Held = { key: string; transport: MinimalTransport; inflight: number; retired: boolean };

export class TransportPool {
  private readonly held = new Map<string, Held>();

  constructor(private readonly create: (s: SmtpSettings) => MinimalTransport) {}

  /** Takes the mailbox's transport for one send; call the returned release when the send settles. */
  acquire(s: SmtpSettings): { transport: MinimalTransport; release: () => void } {
    const key = fingerprint(s);
    let h = this.held.get(s.mailboxId);
    if (h && h.key !== key) {
      this.retire(s.mailboxId);
      h = undefined;
    }
    if (!h) {
      h = { key, transport: this.create(s), inflight: 0, retired: false };
      this.held.set(s.mailboxId, h);
    }
    const taken = h;
    taken.inflight += 1;
    let done = false;
    return {
      transport: taken.transport,
      release: () => {
        if (done) return;
        done = true;
        taken.inflight -= 1;
        if (taken.retired && taken.inflight === 0) taken.transport.close();
      },
    };
  }

  /** New sends get a fresh transport; this one closes once its in-flight messages settle. */
  retire(mailboxId: string) {
    const h = this.held.get(mailboxId);
    if (!h) return;
    this.held.delete(mailboxId);
    h.retired = true;
    if (h.inflight === 0) h.transport.close();
  }
}

const pool = new TransportPool((s) =>
  nodemailer.createTransport({
    ...transportOptions(s),
    pool: true,
    // One connection per mailbox: pacing, not throughput, is what protects a sending domain.
    maxConnections: 1,
    maxMessages: 100,
    socketTimeout: 60_000,
  }),
);

/** Stops new sends using the mailbox's pooled transport (credentials changed, mailbox removed); queued sends still finish. */
export function dropTransport(mailboxId: string) {
  pool.retire(mailboxId);
}

/** Whether a failure says nothing about the connection itself, so the pooled transport can keep serving. */
const recipientOnly = (f: SendFailure) => f.outcome === "rejected" && !f.mailboxAtFault;

export async function sendSmtp(s: SmtpSettings, mail: OutgoingMail): Promise<SendResult> {
  const { transport, release } = pool.acquire(s);
  try {
    const info = await transport.sendMail({
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
    const failure = classifySmtpError(e);
    // A broken connection or sign-in: later sends start over on a fresh transport. A refused recipient is not a reason to.
    if (!recipientOnly(failure)) pool.retire(s.mailboxId);
    return { sent: false, failure };
  } finally {
    release();
  }
}

/** Opens a connection and authenticates, without sending (used when connecting a mailbox). */
export async function verifySmtp(s: SmtpSettings): Promise<{ ok: true } | { ok: false; error: string }> {
  const t = nodemailer.createTransport({ ...transportOptions(s), socketTimeout: 30_000 });
  try {
    await t.verify();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    t.close();
  }
}
