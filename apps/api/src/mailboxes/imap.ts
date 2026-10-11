import { ImapFlow } from "imapflow";

/*
 * IMAP connections for connected mailboxes. Adapted from LinkDesk
 * inbound.service.ts (probeImap / syncMailbox) with two changes: TLS follows
 * the mailbox's `imapSecurity` instead of being guessed from the port
 * (ssl → TLS from the first byte, starttls → upgrade required, none → plain),
 * and a self-signed certificate is only tolerated for a localhost server when
 * ALLOW_PRIVATE_MAIL_HOSTS is set (LinkDesk tolerated it for localhost always).
 * XOAUTH2 is used when the credentials are an OAuth access token.
 */

export type ImapTarget = {
  host: string;
  port: number;
  /** ssl | starttls | none */
  security: string;
  auth: { user: string; pass?: string; accessToken?: string };
  allowSelfSigned: boolean;
};

export function imapClient(t: ImapTarget): ImapFlow {
  const security = t.security === "ssl" || t.security === "starttls" || t.security === "none" ? t.security : "ssl";
  return new ImapFlow({
    host: t.host,
    port: t.port,
    secure: security === "ssl",
    doSTARTTLS: security === "starttls" ? true : security === "none" ? false : undefined,
    auth: t.auth.accessToken ? { user: t.auth.user, accessToken: t.auth.accessToken } : { user: t.auth.user, pass: t.auth.pass ?? "" },
    tls: { rejectUnauthorized: !t.allowSelfSigned },
    logger: false,
    disableAutoIdle: true,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 90_000,
  });
}

type ImapError = Error & { authenticationFailed?: boolean; serverResponseCode?: string; responseText?: string; code?: string };

/** True when the server refused the credentials (as opposed to the network failing). */
export function isImapAuthError(e: unknown): boolean {
  const err = e as ImapError;
  return Boolean(err && (err.authenticationFailed || err.serverResponseCode === "AUTHENTICATIONFAILED" || /authenticat|invalid credentials|login failed/i.test(err.responseText ?? "")));
}

/** A readable reason from an imapflow error (its `message` is often just "Command failed"). */
export function imapErrorText(e: unknown): string {
  const err = e as ImapError;
  if (!err || typeof err !== "object") return String(e);
  const detail = err.responseText || err.message || String(e);
  return (err.code && !detail.includes(err.code) ? `${detail} (${err.code})` : detail).slice(0, 500);
}

/**
 * Logs in and opens INBOX. Selecting is the point rather than logging in:
 * a server will authenticate an account that has no INBOX to read, and
 * "reply tracking works" is only true if there is somewhere replies arrive.
 */
export async function verifyImap(t: ImapTarget): Promise<{ ok: true; messages: number } | { ok: false; error: string; auth: boolean }> {
  const client = imapClient(t);
  // An idle socket error after the answer must not become an unhandled 'error' event.
  client.on("error", () => undefined);
  try {
    await client.connect();
    const box = await client.mailboxOpen("INBOX", { readOnly: true });
    return { ok: true, messages: box.exists };
  } catch (e) {
    return { ok: false, error: imapErrorText(e), auth: isImapAuthError(e) };
  } finally {
    await client.logout().catch(() => client.close());
  }
}
