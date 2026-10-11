import { Global, Module } from "@nestjs/common";
import { PlatformMailService } from "./platform-mail.service.js";
import { PlatformTemplatesService } from "./templates.service.js";
import { PlatformMailAdminService } from "./platform-mail-admin.service.js";
import { PlatformMailWebhooksService } from "./webhooks.service.js";
import { ResendProvider } from "./resend.provider.js";
import { SmtpProvider } from "./smtp.provider.js";
import { PlatformMailRateLimiter } from "./rate-limiter.js";
import { PlatformMailAdminController, PlatformMailWebhookController } from "./platform-mail.controller.js";

/*
 * Platform (system) email: Resend with SMTP fallback, the send queue, delivery
 * webhooks and admin-editable templates. Global because core MailService — the
 * entry point every feature calls — renders and queues through it. The
 * `platform-mail` queue's processor lives in platform-mail.processors.ts
 * (worker only).
 */
@Global()
@Module({
  controllers: [PlatformMailWebhookController, PlatformMailAdminController],
  providers: [PlatformMailService, PlatformTemplatesService, PlatformMailAdminService, PlatformMailWebhooksService, ResendProvider, SmtpProvider, PlatformMailRateLimiter],
  exports: [PlatformMailService, PlatformTemplatesService, ResendProvider, PlatformMailRateLimiter],
})
export class PlatformMailModule {}
