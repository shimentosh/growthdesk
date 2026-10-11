import { Controller, Get, HttpCode, Post, Put, Res } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import type { Response } from "express";
import { TwoFactorCodeInput, TwoFactorDisableInput, WorkspaceSecurityInput } from "@growthdesk/shared";
import { z } from "zod";
import { AllowUnverified, Body, Ctx, Permission, Public } from "../common/decorators.js";
import { me, ws, type RequestContext } from "../common/context.js";
import { conflict, forbidden } from "../common/errors.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { AuditService } from "../core/audit.service.js";
import { SessionService } from "./session.service.js";
import { CHALLENGE_COOKIE, TwoFactorService } from "./two-factor.service.js";

const STRICT = { default: { limit: Number(process.env.AUTH_RATE_LIMIT ?? 10), ttl: 60_000 } };

/** Two-factor: the sign-in step, the person's own setup, and a workspace's requirement. */
@ApiTags("auth")
@Controller()
export class TwoFactorController {
  constructor(
    private readonly twoFactor: TwoFactorService,
    private readonly sessions: SessionService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** The second step of signing in. The pending challenge rides in an HttpOnly cookie set by /auth/login or the Google callback. */
  @Public()
  @Throttle(STRICT)
  @HttpCode(200)
  @Post("auth/2fa/verify")
  async verify(@Body(TwoFactorCodeInput) body: z.infer<typeof TwoFactorCodeInput>, @Ctx() ctx: RequestContext, @Res({ passthrough: true }) res: Response) {
    const token = res.req.cookies?.[CHALLENGE_COOKIE] as string | undefined;
    const session = await this.twoFactor.completeChallenge(token, body.code, ctx);
    this.twoFactor.clearChallengeCookie(res);
    this.sessions.setCookie(res, session.token);
    return { signedIn: true };
  }

  @AllowUnverified()
  @Get("auth/2fa")
  status(@Ctx() ctx: RequestContext) {
    return this.twoFactor.status(me(ctx).userId);
  }

  @AllowUnverified()
  @HttpCode(200)
  @Post("auth/2fa/setup")
  setup(@Ctx() ctx: RequestContext) {
    return this.twoFactor.startEnrolment(me(ctx).userId);
  }

  @AllowUnverified()
  @Throttle(STRICT)
  @HttpCode(200)
  @Post("auth/2fa/enable")
  enable(@Ctx() ctx: RequestContext, @Body(TwoFactorCodeInput) body: z.infer<typeof TwoFactorCodeInput>) {
    return this.twoFactor.confirmEnrolment(ctx, me(ctx).userId, body.code);
  }

  @AllowUnverified()
  @Throttle(STRICT)
  @HttpCode(200)
  @Post("auth/2fa/disable")
  disable(@Ctx() ctx: RequestContext, @Body(TwoFactorDisableInput) body: z.infer<typeof TwoFactorDisableInput>) {
    return this.twoFactor.disable(ctx, me(ctx).userId, body);
  }

  @AllowUnverified()
  @Throttle(STRICT)
  @HttpCode(200)
  @Post("auth/2fa/recovery-codes")
  regenerate(@Ctx() ctx: RequestContext, @Body(TwoFactorCodeInput) body: z.infer<typeof TwoFactorCodeInput>) {
    return this.twoFactor.regenerateRecoveryCodes(ctx, me(ctx).userId, body.code);
  }

  // ─── Workspace requirement ────────────────────────────────────────────────

  /** Whether the workspace requires two-factor, and who has not turned it on yet. */
  @Permission("settings.manage")
  @Get("workspaces/:workspaceId/security")
  async security(@Ctx() ctx: RequestContext) {
    const w = ws(ctx);
    const [workspace, without] = await Promise.all([
      this.prisma.db.workspace.findUniqueOrThrow({ where: { id: w.id }, select: { requireTwoFactor: true } }),
      this.prisma.db.membership.findMany({
        where: { workspaceId: w.id, user: { totpEnabledAt: null } },
        select: { role: true, user: { select: { id: true, name: true, email: true } } },
        orderBy: { createdAt: "asc" },
      }),
    ]);
    return {
      requireTwoFactor: workspace.requireTwoFactor,
      canChange: w.role === "owner",
      membersWithoutTwoFactor: without.map((m) => ({ ...m.user, role: m.role })),
    };
  }

  /** Owners only. Turning the requirement on needs two-factor on the owner's own account first. */
  @Permission("settings.manage")
  @Put("workspaces/:workspaceId/security")
  async updateSecurity(@Ctx() ctx: RequestContext, @Body(WorkspaceSecurityInput) body: z.infer<typeof WorkspaceSecurityInput>) {
    const w = ws(ctx);
    if (w.role !== "owner") throw forbidden("Only a workspace owner can change the two-factor requirement");
    if (body.requireTwoFactor && !me(ctx).twoFactor) {
      throw conflict("Turn on two-factor authentication for your own account first, in your account settings.");
    }
    await this.prisma.db.workspace.update({ where: { id: w.id }, data: { requireTwoFactor: body.requireTwoFactor } });
    await this.audit.record(ctx, {
      action: body.requireTwoFactor ? "workspace.two_factor_required" : "workspace.two_factor_optional",
      targetType: "workspace",
      targetId: w.id,
    });
    return this.security(ctx);
  }
}
