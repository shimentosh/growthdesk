import { Controller, Get, HttpCode, Param, Patch, Post, Req as R } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import type { z } from "zod";
import {
  PlatformEmailSettingsInput,
  PlatformEmailTemplatePreviewInput,
  PlatformEmailTemplatePublishInput,
  PlatformEmailTemplateTestInput,
} from "@growthdesk/shared";
import { Body, Ctx, Platform, Public } from "../common/decorators.js";
import type { Req, RequestContext } from "../common/context.js";
import { PlatformMailAdminService } from "./platform-mail-admin.service.js";
import { PlatformTemplatesService } from "./templates.service.js";
import { PlatformMailWebhooksService } from "./webhooks.service.js";

/*
 * Resend delivery webhooks. Public: the Svix signature over the raw body is
 * the credential. Reached as ${PUBLIC_APP_URL}/api/platform-mail/webhooks/resend
 * through the web app's /api → /v1 proxy.
 */
@ApiTags("platform-mail")
@Public()
@Controller("platform-mail/webhooks")
export class PlatformMailWebhookController {
  constructor(private readonly webhooks: PlatformMailWebhooksService) {}

  @HttpCode(200)
  @Post("resend")
  resend(@R() req: Req) {
    return this.webhooks.handleResend(req.rawBody, req.headers);
  }
}

/*
 * /v1/admin/email/… — platform email settings and system templates.
 * Support reads; admin changes. (The delivery log list stays at
 * GET /admin/email-log in AdminController; its detail is here.)
 */
@ApiTags("admin")
@Controller("admin")
export class PlatformMailAdminController {
  constructor(
    private readonly admin: PlatformMailAdminService,
    private readonly templates: PlatformTemplatesService,
  ) {}

  // ─── Settings ───────────────────────────────────────────────────────────────

  @Platform("support")
  @Get("email/settings")
  settings() {
    return this.admin.getSettings();
  }

  @Platform("admin")
  @Patch("email/settings")
  updateSettings(@Ctx() ctx: RequestContext, @Body(PlatformEmailSettingsInput) body: z.infer<typeof PlatformEmailSettingsInput>) {
    return this.admin.updateSettings(ctx, body);
  }

  @Platform("admin")
  @HttpCode(200)
  @Post("email/test")
  test(@Ctx() ctx: RequestContext) {
    return this.admin.sendTest(ctx);
  }

  @Platform("support")
  @Get("email/domains")
  domains() {
    return this.admin.domains();
  }

  @Platform("admin")
  @HttpCode(200)
  @Post("email/domains/:id/verify")
  verifyDomain(@Ctx() ctx: RequestContext, @Param("id") id: string) {
    return this.admin.verifyDomain(ctx, id);
  }

  // ─── Delivery log detail ──────────────────────────────────────────────────

  @Platform("support")
  @Get("email-log/:id")
  emailLog(@Param("id") id: string) {
    return this.admin.emailLogDetail(id);
  }

  // ─── System templates ─────────────────────────────────────────────────────

  @Platform("support")
  @Get("email/templates")
  listTemplates() {
    return this.templates.list();
  }

  @Platform("support")
  @Get("email/templates/:key")
  template(@Param("key") key: string) {
    return this.templates.detail(key);
  }

  /** Rendering only — no state changes, so support may preview too. */
  @Platform("support")
  @HttpCode(200)
  @Post("email/templates/:key/preview")
  preview(@Param("key") key: string, @Body(PlatformEmailTemplatePreviewInput) body: z.infer<typeof PlatformEmailTemplatePreviewInput>) {
    return this.templates.preview(key, body);
  }

  @Platform("admin")
  @Post("email/templates/:key/versions")
  publish(@Ctx() ctx: RequestContext, @Param("key") key: string, @Body(PlatformEmailTemplatePublishInput) body: z.infer<typeof PlatformEmailTemplatePublishInput>) {
    return this.templates.publish(ctx, key, body);
  }

  @Platform("admin")
  @HttpCode(200)
  @Post("email/templates/:key/versions/:versionId/activate")
  activate(@Ctx() ctx: RequestContext, @Param("key") key: string, @Param("versionId") versionId: string) {
    return this.templates.activate(ctx, key, versionId);
  }

  @Platform("admin")
  @HttpCode(200)
  @Post("email/templates/:key/reset")
  reset(@Ctx() ctx: RequestContext, @Param("key") key: string) {
    return this.templates.reset(ctx, key);
  }

  @Platform("admin")
  @HttpCode(200)
  @Post("email/templates/:key/test")
  testTemplate(@Ctx() ctx: RequestContext, @Param("key") key: string, @Body(PlatformEmailTemplateTestInput) body: z.infer<typeof PlatformEmailTemplateTestInput>) {
    return this.templates.test(ctx, key, body);
  }
}
