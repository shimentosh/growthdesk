import { Inject, Injectable } from "@nestjs/common";
import nodemailer, { type Transporter } from "nodemailer";
import { APP_CONFIG, type AppConfig } from "../config/config.js";
import { type OutgoingMail, type PlatformMailProvider, ProviderError, type SendResult } from "./provider.js";

/*
 * Platform mail over SMTP_* (Mailpit in development; any relay in
 * production). The default provider, and the fallback when Resend is not
 * configured or refuses our key. SMTP has no idempotency: a retry after a
 * dropped connection can deliver twice, so only clear 4xx answers and
 * connection failures before the message was accepted are retried.
 */
@Injectable()
export class SmtpProvider implements PlatformMailProvider {
  readonly id = "smtp" as const;
  private transport: Transporter | null = null;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  private transporter(): Transporter {
    if (!this.transport) {
      this.transport = nodemailer.createTransport({
        host: this.config.SMTP_HOST,
        port: this.config.SMTP_PORT,
        secure: this.config.SMTP_SECURE,
        auth: this.config.SMTP_USER ? { user: this.config.SMTP_USER, pass: this.config.SMTP_PASSWORD ?? "" } : undefined,
        connectionTimeout: 10_000,
        greetingTimeout: 10_000,
        socketTimeout: 30_000,
      });
    }
    return this.transport;
  }

  describe() {
    return { host: this.config.SMTP_HOST, port: this.config.SMTP_PORT, secure: this.config.SMTP_SECURE, authenticated: Boolean(this.config.SMTP_USER) };
  }

  async send(mail: OutgoingMail): Promise<SendResult> {
    try {
      const info = await this.transporter().sendMail({
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
