import { Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Res } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import type { Response } from "express";
import { z } from "zod";
import {
  CreateWorkspaceInput,
  InviteMemberInput,
  ListQuery,
  RolePermissionsInput,
  UpdateMemberInput,
  UpdateWorkspaceInput,
  password,
  requiredText,
} from "@growthdesk/shared";
import { AllowSuspended, AllowUnverified, Body, Ctx, Permission, Public, Query } from "../common/decorators.js";
import { ws, type RequestContext } from "../common/context.js";
import { conflict } from "../common/errors.js";
import { createSignupProfile, parseAttributionCookie } from "../auth/signup-profile.js";
import { hashPassword, hashToken } from "../common/crypto.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { SessionService } from "../auth/session.service.js";
import { WorkspacesService } from "./workspaces.service.js";
import { currentTermsVersion } from "../lifecycle/terms.js";

const RegisterInvitee = z.object({
  name: requiredText(120),
  password,
  acceptTerms: z.literal(true, { error: "Accept the Terms of Service and Privacy Policy to create an account." }),
});
const SupportGrantInput = z.object({ hours: z.number().int().min(1).max(168), reason: requiredText(500) });

@ApiTags("workspaces")
@Controller()
export class WorkspacesController {
  constructor(
    private readonly workspaces: WorkspacesService,
    private readonly prisma: PrismaService,
    private readonly sessions: SessionService,
  ) {}

  @Post("workspaces")
  create(@Ctx() ctx: RequestContext, @Body(CreateWorkspaceInput) body: z.infer<typeof CreateWorkspaceInput>) {
    // The email-confirmation rule (platform setting requireEmailVerification) is checked in create().
    return this.workspaces.create(ctx, body);
  }

  @AllowSuspended()
  @Get("workspaces/:workspaceId")
  detail(@Ctx() ctx: RequestContext) {
    return this.workspaces.detail(ctx);
  }

  @Permission("settings.manage")
  @Patch("workspaces/:workspaceId")
  update(@Ctx() ctx: RequestContext, @Body(UpdateWorkspaceInput) body: z.infer<typeof UpdateWorkspaceInput>) {
    return this.workspaces.update(ctx, body);
  }

  /** Any member may dismiss their onboarding checklist. */
  @HttpCode(200)
  @Post("workspaces/:workspaceId/onboarding/dismiss")
  async dismissOnboarding(@Ctx() ctx: RequestContext) {
    const w = ws(ctx);
    const row = await this.prisma.db.workspace.findUniqueOrThrow({ where: { id: w.id } });
    await this.prisma.db.workspace.update({ where: { id: w.id }, data: { onboarding: { ...(row.onboarding as object), dismissed: true } } });
    return { ok: true };
  }

  @Permission("members.read")
  @Get("workspaces/:workspaceId/members")
  members(@Ctx() ctx: RequestContext) {
    return this.workspaces.members(ctx);
  }

  @Permission("members.manage")
  @Post("workspaces/:workspaceId/invitations")
  invite(@Ctx() ctx: RequestContext, @Body(InviteMemberInput) body: z.infer<typeof InviteMemberInput>) {
    return this.workspaces.invite(ctx, body.email, body.role);
  }

  @Permission("members.manage")
  @HttpCode(200)
  @Post("workspaces/:workspaceId/invitations/:id/resend")
  resend(@Ctx() ctx: RequestContext, @Param("id") id: string) {
    return this.workspaces.resendInvitation(ctx, id);
  }

  @Permission("members.manage")
  @Delete("workspaces/:workspaceId/invitations/:id")
  async revoke(@Ctx() ctx: RequestContext, @Param("id") id: string) {
    await this.workspaces.revokeInvitation(ctx, id);
    return { revoked: true };
  }

  @Permission("members.manage")
  @Patch("workspaces/:workspaceId/members/:id")
  changeRole(@Ctx() ctx: RequestContext, @Param("id") id: string, @Body(UpdateMemberInput) body: z.infer<typeof UpdateMemberInput>) {
    return this.workspaces.changeRole(ctx, id, body.role);
  }

  /** Removing someone needs members.manage; leaving (your own membership) does not. Checked in the service. */
  @Delete("workspaces/:workspaceId/members/:id")
  async remove(@Ctx() ctx: RequestContext, @Param("id") id: string) {
    await this.workspaces.remove(ctx, id);
    return { removed: true };
  }

  @Permission("settings.manage")
  @Put("workspaces/:workspaceId/role-permissions")
  rolePermissions(@Ctx() ctx: RequestContext, @Body(RolePermissionsInput) body: z.infer<typeof RolePermissionsInput>) {
    return this.workspaces.setRolePermissions(ctx, body.role, body.permissions);
  }

  @Permission("audit.read")
  @Get("workspaces/:workspaceId/audit")
  audit(@Ctx() ctx: RequestContext, @Query(ListQuery) q: z.infer<typeof ListQuery>) {
    return this.workspaces.auditLog(ctx, q.page, q.pageSize);
  }

  @AllowSuspended()
  @Permission("settings.manage")
  @Get("workspaces/:workspaceId/support-access")
  supportAccess(@Ctx() ctx: RequestContext) {
    return this.workspaces.supportAccess(ctx);
  }

  @AllowSuspended()
  @Permission("settings.manage")
  @Post("workspaces/:workspaceId/support-access")
  grant(@Ctx() ctx: RequestContext, @Body(SupportGrantInput) body: z.infer<typeof SupportGrantInput>) {
    return this.workspaces.grantSupportAccess(ctx, body.hours, body.reason);
  }

  @AllowSuspended()
  @Permission("settings.manage")
  @Delete("workspaces/:workspaceId/support-access")
  async revokeGrant(@Ctx() ctx: RequestContext) {
    await this.workspaces.revokeSupportAccess(ctx);
    return { revoked: true };
  }

  // ─── Invitations (public side) ─────────────────────────────────────────────

  @Public()
  @Get("invitations/:token")
  readInvitation(@Param("token") token: string) {
    return this.workspaces.readInvitation(token);
  }

  @AllowUnverified()
  @HttpCode(200)
  @Post("invitations/:token/accept")
  accept(@Ctx() ctx: RequestContext, @Param("token") token: string) {
    return this.workspaces.acceptInvitation(ctx, token);
  }

  /** Creates the invitee's account and joins in one step. The emailed link proves the address. */
  @Public()
  @Throttle({ default: { limit: Number(process.env.AUTH_RATE_LIMIT ?? 10), ttl: 60_000 } })
  @Post("invitations/:token/register")
  async registerInvitee(
    @Ctx() ctx: RequestContext,
    @Param("token") token: string,
    @Body(RegisterInvitee) body: z.infer<typeof RegisterInvitee>,
    @Res({ passthrough: true }) res: Response,
  ) {
    const inv = await this.prisma.db.invitation.findUnique({ where: { tokenHash: hashToken(token) } });
    if (!inv || inv.revokedAt || inv.acceptedAt || inv.expiresAt.getTime() < Date.now()) {
      throw conflict("That invitation has expired or was withdrawn.");
    }
    if (await this.prisma.db.user.findUnique({ where: { email: inv.email } })) {
      throw conflict("An account with this email already exists — sign in to accept.");
    }
    const user = await this.prisma.db.user.create({
      data: {
        email: inv.email,
        name: body.name,
        passwordHash: await hashPassword(body.password),
        emailVerifiedAt: new Date(),
        termsAcceptedAt: new Date(),
        termsVersion: await currentTermsVersion(this.prisma),
      },
    });
    await createSignupProfile(this.prisma.db, user.id, { source: "workspace_invite", attribution: parseAttributionCookie(res.req.cookies?.gd_attr) });
    const joined = await this.workspaces.join(inv.id, inv.workspaceId, user.id, inv.role);
    const session = await this.sessions.start(user.id, ctx.ip, ctx.userAgent);
    this.sessions.setCookie(res, session.token);
    return joined;
  }
}
