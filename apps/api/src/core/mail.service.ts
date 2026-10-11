import { Inject, Injectable, Logger } from "@nestjs/common";
import type { PlatformTemplateKey } from "@growthdesk/shared";
import { APP_CONFIG, type AppConfig } from "../config/config.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { PlatformMailService, type MailStream } from "../platform-mail/platform-mail.service.js";
import { PlatformTemplatesService } from "../platform-mail/templates.service.js";

/*
 * The platform's own mail: verification, password reset, invitations,
 * reminders, billing notices. Not customer outreach — that goes out through
 * the customer's own connected mailboxes (mailboxes/mailbox-sender.service.ts).
 *
 * Content comes from the system templates (platform-mail/catalog.ts, or the
 * version an admin published); delivery is the platform-mail pipeline:
 * EmailLog(queued) + a `platform-mail` job, sent by the worker through Resend
 * or SMTP with retries (platform-mail/platform-mail.service.ts).
 *
 * In tests (NODE_ENV=test) nothing is queued or sent: messages are kept in
 * `outbox` for assertions and logged as sent. A test can switch
 * `deliveryMode` to "queue" to exercise the real pipeline.
 */

export type PlatformMail = {
  to: string;
  subject: string;
  text: string;
  html?: string;
  template: string;
  userId?: string | null;
  stream?: MailStream;
  templateVersionId?: string | null;
};

const escape = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** A minimal HTML layout for ad-hoc mail that has no template. */
export function layout(title: string, paragraphs: string[], action?: { label: string; url: string }): string {
  const body = paragraphs.map((p) => `<p style="margin:0 0 14px;line-height:1.55">${escape(p)}</p>`).join("");
  const button = action
    ? `<p style="margin:22px 0"><a href="${escape(action.url)}" style="background:#18181b;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none;font-weight:600;display:inline-block">${escape(action.label)}</a></p><p style="font-size:12px;color:#71717a;word-break:break-all">${escape(action.url)}</p>`
    : "";
  return `<!doctype html><html><body style="margin:0;padding:24px;background:#fafafa;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#18181b"><div style="max-width:520px;margin:0 auto;background:#fff;border:1px solid #e4e4e7;border-radius:12px;padding:28px"><h1 style="font-size:18px;margin:0 0 16px">${escape(title)}</h1>${body}${button}</div></body></html>`;
}

@Injectable()
export class MailService {
  private readonly log = new Logger("mail");
  /** Test mode only: what would have been sent. */
  readonly outbox: PlatformMail[] = [];
  /** outbox = keep in memory (tests); queue = EmailLog + platform-mail job. */
  deliveryMode: "outbox" | "queue";

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly prisma: PrismaService,
    private readonly pipeline: PlatformMailService,
    private readonly templates: PlatformTemplatesService,
  ) {
    this.deliveryMode = config.NODE_ENV === "test" ? "outbox" : "queue";
  }

  /**
   * Logs and queues one message. Never throws: a failed notification must not
   * fail the request that caused it. true = queued (or kept, in tests).
   */
  async send(mail: PlatformMail): Promise<boolean> {
    if (this.deliveryMode === "outbox") {
      this.outbox.push(mail);
      await this.prisma.db.emailLog
        .create({
          data: {
            to: mail.to,
            template: mail.template,
            status: "sent",
            stream: mail.stream ?? "transactional",
            provider: "outbox",
            subject: mail.subject.slice(0, 998),
            userId: mail.userId ?? null,
            templateVersionId: mail.templateVersionId ?? null,
            sentAt: new Date(),
          },
        })
        .catch(() => undefined);
      return true;
    }
    const { queued } = await this.pipeline.submit({
      to: mail.to,
      subject: mail.subject,
      text: mail.text,
      html: mail.html ?? layout(mail.subject, mail.text.split(/\n{2,}/)),
      template: mail.template,
      stream: mail.stream,
      userId: mail.userId,
      templateVersionId: mail.templateVersionId,
    });
    return queued;
  }

  link(path: string) {
    return `${this.config.PUBLIC_APP_URL.replace(/\/$/, "")}${path}`;
  }

  /**
   * Sends one of the platform templates (packages/shared/src/platform-mail.ts)
   * by key: the admin-published version when there is one, else the code
   * default (platform-mail/catalog.ts). The entry point for system mail.
   */
  async sendTemplate(key: PlatformTemplateKey, to: string, vars: Record<string, string>, opts: { userId?: string | null } = {}): Promise<boolean> {
    let rendered: Awaited<ReturnType<PlatformTemplatesService["compose"]>>;
    try {
      rendered = await this.templates.compose(key, vars);
    } catch (e) {
      this.log.error(`could not render ${key} for ${to}: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
    return this.send({
      to,
      template: key,
      subject: rendered.subject,
      text: rendered.text,
      html: rendered.html,
      userId: opts.userId ?? null,
      templateVersionId: rendered.templateVersionId,
    });
  }

  verifyEmail(to: string, name: string, token: string) {
    return this.sendTemplate("verify_email", to, { name, action_url: this.link(`/verify-email?token=${encodeURIComponent(token)}`) });
  }

  resetPassword(to: string, token: string) {
    return this.sendTemplate("reset_password", to, { action_url: this.link(`/reset-password?token=${encodeURIComponent(token)}`) });
  }

  accountExists(to: string, name: string, userId: string) {
    return this.sendTemplate("account_exists", to, { name, action_url: this.link("/login") }, { userId });
  }

  invitation(to: string, inviter: string, workspace: string, token: string) {
    return this.sendTemplate("invitation", to, { inviter, workspace, action_url: this.link(`/invite/${encodeURIComponent(token)}`) });
  }

  notification(to: string, title: string, body: string, path: string) {
    return this.sendTemplate("notification", to, { title, body, action_url: this.link(path) });
  }
}
