import { Controller, Delete, Get, HttpCode, Param, Patch, Post, Res } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import type { Response } from "express";
import { z } from "zod";
import { SmtpMailboxInput, TestSendInput, UpdateMailboxInput } from "@growthdesk/shared";
import { Body, Ctx, Permission, Public, Query, Raw } from "../common/decorators.js";
import type { RequestContext } from "../common/context.js";
import { MailboxesService } from "./mailboxes.service.js";
import { MailboxOAuthService } from "./mailbox-oauth.service.js";

const DetectQuery = z.object({ email: z.string().trim().toLowerCase().email().max(320) });

@ApiTags("mailboxes")
@Controller("workspaces/:workspaceId/mailboxes")
export class MailboxesController {
  constructor(
    private readonly mailboxes: MailboxesService,
    private readonly oauth: MailboxOAuthService,
  ) {}

  @Permission("integrations.read")
  @Get()
  list(@Ctx() ctx: RequestContext) {
    return this.mailboxes.list(ctx);
  }

  @Permission("integrations.manage")
  @Post("smtp")
  connectSmtp(@Ctx() ctx: RequestContext, @Body(SmtpMailboxInput) body: z.infer<typeof SmtpMailboxInput>) {
    return this.mailboxes.connectSmtp(ctx, body);
  }

  /** The provider behind an address and its servers, for the connect dialog. Declared before :id. */
  @Permission("integrations.manage")
  @Get("detect")
  async detect(@Query(DetectQuery) q: z.infer<typeof DetectQuery>) {
    const [found, oauth] = await Promise.all([this.mailboxes.detect(q.email), this.oauth.available()]);
    return { ...found, oauth };
  }

  @Permission("integrations.manage")
  @Get("oauth/:provider/start")
  oauthStart(@Ctx() ctx: RequestContext, @Param("provider") provider: string) {
    return this.oauth.start(ctx, provider);
  }

  @Permission("integrations.read")
  @Get(":id")
  get(@Ctx() ctx: RequestContext, @Param("id") id: string) {
    return this.mailboxes.get(ctx, id);
  }

  @Permission("integrations.manage")
  @Patch(":id")
  update(@Ctx() ctx: RequestContext, @Param("id") id: string, @Body(UpdateMailboxInput) body: z.infer<typeof UpdateMailboxInput>) {
    return this.mailboxes.update(ctx, id, body);
  }

  @Permission("integrations.manage")
  @Delete(":id")
  async remove(@Ctx() ctx: RequestContext, @Param("id") id: string) {
    await this.mailboxes.remove(ctx, id);
    return { deleted: true };
  }

  @Permission("integrations.manage")
  @HttpCode(200)
  @Post(":id/verify")
  verify(@Ctx() ctx: RequestContext, @Param("id") id: string) {
    return this.mailboxes.verify(ctx, id);
  }

  @Permission("integrations.manage")
  @HttpCode(200)
  @Post(":id/test")
  test(@Ctx() ctx: RequestContext, @Param("id") id: string, @Body(TestSendInput) body: z.infer<typeof TestSendInput>) {
    return this.mailboxes.testSend(ctx, id, body);
  }

  /** "Check for new mail now". Harmless, so anyone who reads the inbox may ask. */
  @Permission("integrations.manage", "inbox.read")
  @HttpCode(202)
  @Post(":id/sync")
  sync(@Ctx() ctx: RequestContext, @Param("id") id: string) {
    return this.mailboxes.syncNow(ctx, id);
  }

  @Permission("integrations.read")
  @Get(":id/dns")
  dns(@Ctx() ctx: RequestContext, @Param("id") id: string) {
    return this.mailboxes.dns(ctx, id);
  }
}

const CallbackQuery = z.object({
  code: z.string().max(4096).optional(),
  state: z.string().max(4096).optional(),
  error: z.string().max(500).optional(),
  error_description: z.string().max(2000).optional(),
});

/**
 * Where Google / Microsoft send the browser back to:
 * `${PUBLIC_APP_URL}/api/mailboxes/oauth/<provider>/callback` (the web app proxies /api to /v1).
 * Public because it is reached by a redirect; the signed state plus the
 * browser's own session decide who and which workspace.
 */
@ApiTags("mailboxes")
@Public()
@Raw()
@Controller("mailboxes/oauth")
export class MailboxOAuthCallbackController {
  constructor(private readonly oauth: MailboxOAuthService) {}

  @Get(":provider/callback")
  async callback(@Ctx() ctx: RequestContext, @Param("provider") provider: string, @Query(CallbackQuery) query: z.infer<typeof CallbackQuery>, @Res() res: Response) {
    const next = await this.oauth.callback(provider, query, ctx);
    res.setHeader("cache-control", "no-store");
    res.redirect(302, next);
  }
}
