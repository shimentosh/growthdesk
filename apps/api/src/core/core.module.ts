import { Global, Module } from "@nestjs/common";
import { PlatformSettingsService } from "./platform-settings.service.js";
import { AuditService } from "./audit.service.js";
import { EventsService } from "./events.service.js";
import { MailService } from "./mail.service.js";
import { BrandingService } from "./branding.service.js";
import { CredentialReleaseService } from "./credential-release.service.js";
import { SessionService } from "../auth/session.service.js";
import { EntitlementsService } from "../billing/entitlements.service.js";
import { StatusController } from "./status.controller.js";

/** Services nearly every feature needs; global so feature modules stay small. */
@Global()
@Module({
  controllers: [StatusController],
  providers: [PlatformSettingsService, BrandingService, AuditService, EventsService, MailService, SessionService, EntitlementsService, CredentialReleaseService],
  exports: [PlatformSettingsService, BrandingService, AuditService, EventsService, MailService, SessionService, EntitlementsService, CredentialReleaseService],
})
export class CoreModule {}
