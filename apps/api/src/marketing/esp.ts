import nodemailer, { type Transporter } from "nodemailer";
import { classifySmtpError, type SendFailure } from "../messaging/smtp.js";

/*
 * Marketing sends through the workspace's email service (EspConnection),
 * over SMTP. Both providers are SMTP endpoints: Amazon SES (its SMTP
 * interface in the chosen region) and any other relay (Postmark, SendGrid,
 * Mailgun, or Mailpit locally). Never a connected Mailbox (R1).
 */

export type EspSmtp = {
  connectionId: string;
  host: string;
  port: number;
  security: "ssl" | "starttls" | "none";
  username: string;
  password: string;
  allowSelfSigned: boolean;
};

export type EspMail = {
  from: string;
  to: string;
  replyTo?: string;
  subject: string;
  html: string;
  text: string;
  messageId: string;
  headers: Record<string, string>;
};

export type EspResult = { sent: true; providerMessageId: string } | { sent: false; failure: SendFailure };

export const sesHost = (region: string) => `email-smtp.${region}.amazonaws.com`;

const fingerprint = (s: EspSmtp) => [s.host, s.port, s.security, s.username, s.password].join("|");
const pool = new Map<string, { key: string; transport: Transporter }>();

function options(s: EspSmtp) {
  return {
    host: s.host,
    port: s.port,
    secure: s.security === "ssl" || s.port === 465,
    requireTLS: s.security === "starttls",
    ignoreTLS: s.security === "none",
    ...(s.username ? { auth: { user: s.username, pass: s.password } } : {}),
    tls: { rejectUnauthorized: !s.allowSelfSigned },
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 60_000,
  };
}

function transportFor(s: EspSmtp): Transporter {
  const key = fingerprint(s);
  const held = pool.get(s.connectionId);
  if (held?.key === key) return held.transport;
  held?.transport.close();
  // ESPs are built for volume: a few pooled connections, unlike a mailbox's one.
  const transport = nodemailer.createTransport({ ...options(s), pool: true, maxConnections: 3, maxMessages: 500 });
  pool.set(s.connectionId, { key, transport });
  return transport;
}

export function dropEspTransport(connectionId: string) {
  pool.get(connectionId)?.transport.close();
  pool.delete(connectionId);
}

/** SES answers "250 Ok <ses-message-id>"; that id is what its bounce/complaint notifications carry. */
export function providerIdFrom(response: string, fallback: string): string {
  return response.match(/\bOk\s+([0-9a-zA-Z-]{20,})/)?.[1] ?? fallback;
}

export async function sendViaEsp(s: EspSmtp, mail: EspMail): Promise<EspResult> {
  try {
    const info = await transportFor(s).sendMail({
      from: mail.from,
      to: mail.to,
      ...(mail.replyTo ? { replyTo: mail.replyTo } : {}),
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
      messageId: mail.messageId,
      headers: mail.headers,
    });
    return { sent: true, providerMessageId: providerIdFrom(String(info.response ?? ""), mail.messageId.replace(/^<|>$/g, "")) };
  } catch (e) {
    dropEspTransport(s.connectionId);
    return { sent: false, failure: classifySmtpError(e) };
  }
}

/** Connects and authenticates without sending (used when the service is connected). */
export async function verifyEsp(s: EspSmtp): Promise<{ ok: true } | { ok: false; error: string }> {
  const t = nodemailer.createTransport(options(s));
  try {
    await t.verify();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    t.close();
  }
}
