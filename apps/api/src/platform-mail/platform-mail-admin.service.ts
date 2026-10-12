import { Inject, Injectable } from "@nestjs/common";
import type { z } from "zod";
import type { PlatformEmailSettingsInput } from "@growthdesk/shared";
import { APP_CONFIG, type AppConfig } from "../config/config.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { PlatformSettingsService } from "../core/platform-settings.service.js";
import { AuditService } from "../core/audit.service.js";
import { me, type RequestContext } from "../common/context.js";
import { ApiError, conflict, notFound } from "../common/errors.js";
import { isProviderError } from "./provider.js";
import { PlatformMailService } from "./platform-mail.service.js";
import { PlatformTemplatesService } from "./templates.service.js";
import { renderPlatformTemplate } from "./render.js";

/*
 * Admin → Email settings and the delivery log detail. Secrets are write-only:
 * reads say whether each is set (and whether it comes from the environment).
 */

const SECRET_KEYS = ["resendApiKey", "resendWebhookSecret", "smtpPassword"] as const;

@Injectable()
export class PlatformMailAdminService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly prisma: PrismaService,
    private readonly settings: PlatformSettingsService,
    private readonly audit: AuditService,
    private readonly mail: PlatformMailService,
    private readonly templates: PlatformTemplatesService,
  ) {}

  webhookUrl() {
    return `${this.config.PUBLIC_APP_URL.replace(/\/+$/, "")}/api/platform-mail/webhooks/resend`;
  }

  async getSettings() {
    const s = await this.settings.get();
    const [route, env, apiKey, webhookSecret] = await Promise.all([
      this.mail.route(),
      this.mail.envelope("transactional"),
      this.settings.resendApiKey(),
      this.settings.resendWebhookSecret(),
    ]);
    const marketing = await this.mail.envelope("marketing");
    return {
      mailProvider: s.mailProvider,
      transactionalFrom: s.transactionalFrom,
      marketingFrom: s.marketingFrom,
      replyTo: s.replyTo,
      resendRateLimitPerSec: s.resendRateLimitPerSec,
      resendApiKeySet: Boolean(apiKey),
      /** true = the key comes from RESEND_API_KEY, not from a saved setting. */
      resendApiKeyFromEnv: !s.resendApiKeySealed && Boolean(this.config.RESEND_API_KEY),
      resendWebhookSecretSet: Boolean(webhookSecret),
      resendWebhookSecretFromEnv: !s.resendWebhookSecretSealed && Boolean(this.config.RESEND_WEBHOOK_SECRET),
      /** Paste into Resend → Webhooks. */
      webhookUrl: this.webhookUrl(),
      /** What a send would do right now. */
      effective: {
        provider: route.provider,
        reason: route.reason,
        transactionalFrom: env.from,
        marketingFrom: marketing.from,
        replyTo: env.replyTo ?? null,
      },
      defaults: { mailFrom: this.config.MAIL_FROM, replyTo: this.config.MAIL_REPLY_TO ?? null },
      smtp: await this.mail.smtp.describe(),
    };
  }

  async updateSettings(ctx: RequestContext, patch: z.infer<typeof PlatformEmailSettingsInput>) {
    const before = await this.settings.get();
    await this.settings.update(patch, me(ctx).userId);
    const changes: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      // Secrets never reach the audit trail, only that they changed.
      if ((SECRET_KEYS as readonly string[]).includes(k)) changes[k] = v ? "replaced" : "cleared";
      else if (JSON.stringify(v) !== JSON.stringify(before[k as keyof typeof before])) changes[k] = v;
    }
    if (Object.keys(changes).length) {
      await this.audit.record(ctx, { workspaceId: null, action: "platform.email_settings_updated", targetType: "platform_settings", metadata: { changes } }, "platform_admin");
    }
    return this.getSettings();
  }

  /** A short email to the signed-in admin through whatever provider is configured now. */
  async sendTest(ctx: RequestContext) {
    const who = me(ctx);
    await this.templates.assertTestAllowance(who.userId);
    const brand = await this.templates.brand();
    const rendered = renderPlatformTemplate(
      {
        subject: "[Test] {{product_name}} email settings",
        preheader: "",
        blocks: [
          { type: "heading", id: "h", text: "Your email settings work", level: 1, align: "left" },
          { type: "text", id: "t", text: "Hi {{name|there}},\n\nThis test was sent from the {{product_name}} admin. If you are reading it, system email is being delivered.", align: "left" },
        ],
      },
      { name: who.name },
      brand,
    );
    const result = await this.mail.sendNow({ to: who.email, subject: rendered.subject, html: rendered.html, text: rendered.text, template: "test:settings", userId: who.userId });
    return { ...result, to: who.email };
  }

  private async resendCall<T>(fn: () => Promise<T>): Promise<T> {
    if (!(await this.mail.resend.isConfigured())) throw conflict("Add a Resend API key first.");
    try {
      return await fn();
    } catch (e) {
      if (isProviderError(e)) {
        const status = e.kind === "auth" ? 409 : e.status === 404 ? 404 : 502;
        throw new ApiError(status, status === 404 ? "not_found" : status === 409 ? "conflict" : "provider_error", e.message);
      }
      throw e;
    }
  }

  async domains() {
    return { items: await this.resendCall(() => this.mail.resend.domains()) };
  }

  async verifyDomain(ctx: RequestContext, id: string) {
    const out = await this.resendCall(() => this.mail.resend.verifyDomain(id));
    await this.audit.record(ctx, { workspaceId: null, action: "platform.email_domain_verify_requested", targetType: "resend_domain", targetId: id }, "platform_admin");
    return { ok: true, id: out.id };
  }

  async emailLogDetail(id: string) {
    const row = await this.prisma.db.emailLog.findUnique({ where: { id } }).catch(() => null);
    if (!row) throw notFound("That email");
    const [events, user, version] = await Promise.all([
      this.prisma.db.platformEmailEvent.findMany({ where: { emailLogId: id }, orderBy: [{ occurredAt: "asc" }, { createdAt: "asc" }, { id: "asc" }] }),
      row.userId ? this.prisma.db.user.findUnique({ where: { id: row.userId }, select: { id: true, name: true, email: true } }) : null,
      row.templateVersionId ? this.prisma.db.platformEmailTemplateVersion.findUnique({ where: { id: row.templateVersionId }, select: { id: true, version: true, templateKey: true } }) : null,
    ]);
    return {
      ...row,
      user,
      templateVersion: version,
      events: events.map((e) => ({ id: e.id, type: e.type, occurredAt: e.occurredAt, createdAt: e.createdAt, payload: e.payload })),
    };
  }
}
