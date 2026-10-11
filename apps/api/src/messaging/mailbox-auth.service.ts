import { Inject, Injectable } from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../config/config.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { open, seal } from "../common/crypto.js";
import { ApiError } from "../common/errors.js";
import type { Mailbox } from "../generated/prisma/client.js";
import type { SmtpAuth, SmtpSettings } from "./smtp.js";
import { MailboxFaultService } from "./mailbox-faults.service.js";

/*
 * Credentials for a connected mailbox: the sealed app password for SMTP/IMAP
 * mailboxes, or a short-lived OAuth access token (refreshed from the sealed
 * refresh token when it is within a minute of expiry) for Gmail and
 * Microsoft 365. Tokens are never returned to a client.
 */

export const OAUTH_PROVIDERS = {
  gmail: {
    tokenUrl: () => "https://oauth2.googleapis.com/token",
    smtp: { host: "smtp.gmail.com", port: 465, security: "ssl" },
    imap: { host: "imap.gmail.com", port: 993, security: "ssl" },
    scope: "https://mail.google.com/ openid email",
  },
  microsoft: {
    tokenUrl: (tenant: string) => `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
    smtp: { host: "smtp.office365.com", port: 587, security: "starttls" },
    imap: { host: "outlook.office365.com", port: 993, security: "ssl" },
    scope: "https://outlook.office.com/SMTP.Send https://outlook.office.com/IMAP.AccessAsUser.All offline_access openid email",
  },
} as const;

export class MailboxAuthError extends ApiError {
  constructor(message: string) {
    super(409, "mailbox_auth", message);
  }
}

/** The provider could not refresh the sign-in right now (5xx / rate limited). Already recorded on the mailbox as a transient fault. */
export class MailboxAuthUnavailable extends Error {}

@Injectable()
export class MailboxAuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly faults: MailboxFaultService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  private clientFor(provider: "gmail" | "microsoft") {
    const id = provider === "gmail" ? this.config.GOOGLE_CLIENT_ID : this.config.MICROSOFT_CLIENT_ID;
    const secret = provider === "gmail" ? this.config.GOOGLE_CLIENT_SECRET : this.config.MICROSOFT_CLIENT_SECRET;
    if (!id || !secret) throw new MailboxAuthError(`${provider === "gmail" ? "Google" : "Microsoft"} sign-in is not configured on this installation.`);
    return { id, secret };
  }

  /** A valid access token, refreshing and persisting it when it has expired. */
  async accessToken(mailbox: Mailbox): Promise<string> {
    if (mailbox.provider === "smtp") throw new MailboxAuthError("This mailbox uses a password, not OAuth");
    const provider = mailbox.provider;
    const current = open(mailbox.oauthAccessSealed);
    if (current && mailbox.oauthExpiresAt && mailbox.oauthExpiresAt.getTime() - Date.now() > 60_000) return current;
    const refresh = open(mailbox.secretSealed);
    if (!refresh) throw new MailboxAuthError("The mailbox's sign-in has expired — reconnect it.");
    const client = this.clientFor(provider);
    const res = await fetch(OAUTH_PROVIDERS[provider].tokenUrl(this.config.MICROSOFT_TENANT), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: client.id, client_secret: client.secret, refresh_token: refresh, grant_type: "refresh_token" }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; refresh_token?: string; error?: string; error_description?: string };
    if (!res.ok || !body.access_token) {
      const why = body.error_description ?? body.error ?? `HTTP ${res.status}`;
      // A refused grant is final; the provider being down or rate limiting us is not.
      const transient = res.status >= 500 || res.status === 429;
      await this.faults.failed(mailbox, `Sign-in refresh failed: ${why}`, transient);
      if (transient) throw new MailboxAuthUnavailable(`The mailbox's sign-in could not be refreshed right now (${why}).`);
      throw new MailboxAuthError(`The mailbox's sign-in could not be refreshed (${why}) — reconnect it.`);
    }
    await this.prisma.db.mailbox.update({
      where: { id: mailbox.id, workspaceId: mailbox.workspaceId },
      data: {
        oauthAccessSealed: seal(body.access_token),
        oauthExpiresAt: new Date(Date.now() + (body.expires_in ?? 3600) * 1000),
        // Microsoft rotates refresh tokens; keep the newest.
        ...(body.refresh_token ? { secretSealed: seal(body.refresh_token) } : {}),
      },
    });
    return body.access_token;
  }

  async smtpAuth(mailbox: Mailbox): Promise<SmtpAuth> {
    if (mailbox.provider === "smtp") {
      const pass = open(mailbox.secretSealed);
      if (pass === null) throw new MailboxAuthError("The mailbox password could not be read — enter it again.");
      return { user: mailbox.smtpUser || mailbox.email, pass };
    }
    return { user: mailbox.email, accessToken: await this.accessToken(mailbox) };
  }

  async imapAuth(mailbox: Mailbox): Promise<{ user: string; pass?: string; accessToken?: string }> {
    if (mailbox.provider === "smtp") {
      const pass = open(mailbox.secretSealed);
      if (pass === null) throw new MailboxAuthError("The mailbox password could not be read — enter it again.");
      return { user: mailbox.imapUser || mailbox.smtpUser || mailbox.email, pass };
    }
    return { user: mailbox.email, accessToken: await this.accessToken(mailbox) };
  }

  async smtpSettings(mailbox: Mailbox): Promise<SmtpSettings> {
    const local = ["localhost", "127.0.0.1"].includes(mailbox.smtpHost);
    return {
      mailboxId: mailbox.id,
      host: mailbox.smtpHost,
      port: mailbox.smtpPort,
      security: mailbox.smtpSecurity,
      auth: await this.smtpAuth(mailbox),
      allowSelfSigned: local && this.config.ALLOW_PRIVATE_MAIL_HOSTS,
    };
  }
}
