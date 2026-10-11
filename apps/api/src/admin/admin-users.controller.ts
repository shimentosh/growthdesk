import { Controller, Delete, Get, HttpCode, Param, Post, Put, Res } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import type { Response } from "express";
import type { z } from "zod";
import {
  AdminChangeEmailInput,
  AdminSignupInviteInput,
  AdminSignupInvitesQuery,
  AdminUserNoteInput,
  AdminUserTagsInput,
  AdminUsersExportQuery,
  AdminWaitlistInviteInput,
  AdminWaitlistQuery,
} from "@growthdesk/shared";
import { Body, Ctx, Platform, Query, Raw } from "../common/decorators.js";
import type { RequestContext } from "../common/context.js";
import { AdminUsersService } from "./admin-users.service.js";

/*
 * /v1/admin/… — platform user management (super-admin Phase 3).
 * support: resend verification, notes, tags.
 * admin: verify email, password reset, change email, CSV export, waitlist, sign-up invitations.
 * owner: delete (anonymise).
 *
 * Registered before AdminController so `users/export.csv` is matched here
 * rather than as `users/:id`.
 */
@ApiTags("admin")
@Controller("admin")
export class AdminUsersController {
  constructor(private readonly users: AdminUsersService) {}

  // ─── Export ────────────────────────────────────────────────────────────────

  @Platform("admin")
  @Raw()
  @Get("users/export.csv")
  async exportCsv(@Ctx() ctx: RequestContext, @Query(AdminUsersExportQuery) q: z.infer<typeof AdminUsersExportQuery>, @Res() res: Response) {
    await this.users.exportCsv(ctx, q, res);
  }

  // ─── Support ───────────────────────────────────────────────────────────────

  @Platform("support")
  @HttpCode(200)
  @Post("users/:id/resend-verification")
  resendVerification(@Ctx() ctx: RequestContext, @Param("id") id: string) {
    return this.users.resendVerification(ctx, id);
  }

  @Platform("support")
  @Get("users/:id/notes")
  notes(@Param("id") id: string) {
    return this.users.listNotes(id);
  }

  @Platform("support")
  @Post("users/:id/notes")
  addNote(@Ctx() ctx: RequestContext, @Param("id") id: string, @Body(AdminUserNoteInput) body: z.infer<typeof AdminUserNoteInput>) {
    return this.users.addNote(ctx, id, body.body);
  }

  @Platform("support")
  @Put("users/:id/tags")
  tags(@Ctx() ctx: RequestContext, @Param("id") id: string, @Body(AdminUserTagsInput) body: z.infer<typeof AdminUserTagsInput>) {
    return this.users.setTags(ctx, id, body.tags);
  }

  // ─── Admin ─────────────────────────────────────────────────────────────────

  @Platform("admin")
  @HttpCode(200)
  @Post("users/:id/verify-email")
  verifyEmail(@Ctx() ctx: RequestContext, @Param("id") id: string) {
    return this.users.verifyEmail(ctx, id);
  }

  @Platform("admin")
  @HttpCode(200)
  @Post("users/:id/password-reset")
  passwordReset(@Ctx() ctx: RequestContext, @Param("id") id: string) {
    return this.users.sendPasswordReset(ctx, id);
  }

  @Platform("admin")
  @Put("users/:id/email")
  changeEmail(@Ctx() ctx: RequestContext, @Param("id") id: string, @Body(AdminChangeEmailInput) body: z.infer<typeof AdminChangeEmailInput>) {
    return this.users.changeEmail(ctx, id, body.email);
  }

  @Platform("admin")
  @Get("waitlist")
  waitlist(@Query(AdminWaitlistQuery) q: z.infer<typeof AdminWaitlistQuery>) {
    return this.users.listWaitlist(q);
  }

  @Platform("admin")
  @HttpCode(200)
  @Post("waitlist/:id/invite")
  inviteFromWaitlist(@Ctx() ctx: RequestContext, @Param("id") id: string, @Body(AdminWaitlistInviteInput) body: z.infer<typeof AdminWaitlistInviteInput>) {
    return this.users.inviteFromWaitlist(ctx, id, body.expiresDays);
  }

  @Platform("admin")
  @HttpCode(200)
  @Post("waitlist/:id/reject")
  rejectWaitlist(@Ctx() ctx: RequestContext, @Param("id") id: string) {
    return this.users.rejectWaitlist(ctx, id);
  }

  @Platform("admin")
  @Get("signup-invites")
  invites(@Query(AdminSignupInvitesQuery) q: z.infer<typeof AdminSignupInvitesQuery>) {
    return this.users.listInvites(q);
  }

  @Platform("admin")
  @Post("signup-invites")
  createInvite(@Ctx() ctx: RequestContext, @Body(AdminSignupInviteInput) body: z.infer<typeof AdminSignupInviteInput>) {
    return this.users.createInvite(ctx, body.email, body.expiresDays);
  }

  @Platform("admin")
  @Delete("signup-invites/:id")
  revokeInvite(@Ctx() ctx: RequestContext, @Param("id") id: string) {
    return this.users.revokeInvite(ctx, id);
  }

  // ─── Owner ─────────────────────────────────────────────────────────────────

  @Platform("owner")
  @Delete("users/:id")
  anonymise(@Ctx() ctx: RequestContext, @Param("id") id: string) {
    return this.users.anonymise(ctx, id);
  }
}
