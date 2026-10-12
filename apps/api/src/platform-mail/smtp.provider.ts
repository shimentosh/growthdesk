import { Injectable } from "@nestjs/common";
import nodemailer, { type Transporter } from "nodemailer";
import { PlatformSettingsService, type SmtpConfig } from "../core/platform-settings.service.js";
import { type OutgoingMail, type PlatformMailProvider, ProviderError, type SendResult } from "./provider.js";

/*
 * Platform mail over SMTP: the server saved in admin → Email settings, else
 * SMTP_* (Mailpit in development). The default provider, and the fallback
 * when Resend is not configured or refuses our key. SMTP has no idempotency:
 * a retry after a dropped connection can deliver twice, so only clear 4xx
 * answers and connection failures before the message was accepted are retried.
 */
@Injectable()
export class SmtpProvider implements PlatformMailProvider {
  readonly id = "smtp" as const;
  /** The pooled transport and the settings it was built from; rebuilt when an admin changes them. */
  private transport: { key: string; transporter: Transporter } | null = null;

  constructor(private readonly settings: PlatformSettingsService) {}

  private async transporter(): Promise<Transporter> {
    const c: SmtpConfig = await this.settings.smtp();
    const key = JSON.stringify([c.host, c.port, c.secure, c.user, c.password]);
    if (this.transport?.key !== key) {
      this.transport?.transporter.close();
      this.transport = {
        key,
        transporter: nodemailer.createTransport({
          host: c.host,
          port: c.port,
          secure: c.secure,
          auth: c.user ? { user: c.user, pass: c.password } : undefined,
          connectionTimeout: 10_000,
          greetingTimeout: 10_000,
          socketTimeout: 30_000,
        }),
      };
    }
    return this.transport.transporter;
  }

  async describe() {
    const c = await this.settings.smtp();
    return { host: c.host, port: c.port, secure: c.secure, authenticated: Boolean(c.user), user: c.user, passwordSet: Boolean(c.password), fromEnv: c.fromEnv };
  }

  async send(mail: OutgoingMail): Promise<SendResult> {
    try {
      const info = await (await this.transporter()).sendMail({
        from: mail.from,
        to: mail.to,
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
        replyTo: mail.replyTo || undefined,
        headers: mail.headers,
      });
      return { providerMessageId: typeof info.messageId === "string" && info.messageId ? info.messageId : null };
    } catch (e) {
      const err = e as { responseCode?: number; code?: string; message?: string };
      const message = `SMTP: ${err.message ?? String(e)}`;
      if (typeof err.responseCode === "number" && err.responseCode >= 500) throw new ProviderError("rejected", message, err.responseCode, String(err.responseCode));
      if (err.code === "EAUTH") throw new ProviderError("rejected", message, err.responseCode ?? null, "EAUTH");
      throw new ProviderError("unknown_outcome", message, err.responseCode ?? null, err.code ?? "");
    }
  }
}
