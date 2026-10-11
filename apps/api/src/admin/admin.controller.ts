import { Controller, Get, HttpCode, Param, Patch, Post, Put } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import type { z } from "zod";
import {
  AdminAssignPlanInput,
  AdminAuditQuery,
  AdminBillingAccountsQuery,
  AdminDisableUserInput,
  AdminEmailLogQuery,
  AdminPlanUpdateInput,
  AdminSetPlatformRoleInput,
  AdminUsersListQuery,
  AdminWorkspacesQuery,
  PlanAdminInput,
  PlatformSettingsInput,
  SuspendInput,
} from "@growthdesk/shared";
import { Body, Ctx, Platform, Query } from "../common/decorators.js";
import type { RequestContext } from "../common/context.js";
import { AdminService } from "./admin.service.js";

/*
 * /v1/admin/… — platform administration. Every route names its minimum
 * platform rank: support reads, admin changes, and the service adds the
 * per-target rank rules (see AdminService.assertMayManage).
 */
@ApiTags("admin")
@Controller("admin")
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  @Platform("support")
  @Get("overview")
  overview(@Ctx() ctx: RequestContext) {
    return this.admin.overview(ctx);
  }

  // ─── Users ─────────────────────────────────────────────────────────────────

  @Platform("support")
  @Get("users")
  users(@Query(AdminUsersListQuery) q: z.infer<typeof AdminUsersListQuery>) {
    return this.admin.listUsers(q);
  }

  @Platform("support")
  @Get("users/:id")
  user(@Param("id") id: string) {
    return this.admin.userDetail(id);
  }

  @Platform("admin")
  @HttpCode(200)
  @Post("users/:id/disable")
  disable(@Ctx() ctx: RequestContext, @Param("id") id: string, @Body(AdminDisableUserInput) body: z.infer<typeof AdminDisableUserInput>) {
    return this.admin.disableUser(ctx, id, body.reason);
  }

  @Platform("admin")
  @HttpCode(200)
  @Post("users/:id/enable")
  enable(@Ctx() ctx: RequestContext, @Param("id") id: string) {
    return this.admin.enableUser(ctx, id);
  }

  @Platform("admin")
  @Put("users/:id/platform-role")
  role(@Ctx() ctx: RequestContext, @Param("id") id: string, @Body(AdminSetPlatformRoleInput) body: z.infer<typeof AdminSetPlatformRoleInput>) {
    return this.admin.setPlatformRole(ctx, id, body.role);
  }

  @Platform("admin")
  @HttpCode(200)
  @Post("users/:id/sign-out")
  signOut(@Ctx() ctx: RequestContext, @Param("id") id: string) {
    return this.admin.signOutUser(ctx, id);
  }

  // ─── Workspaces ────────────────────────────────────────────────────────────

  @Platform("support")
  @Get("workspaces")
  workspaces(@Query(AdminWorkspacesQuery) q: z.infer<typeof AdminWorkspacesQuery>) {
    return this.admin.listWorkspaces(q);
  }

  @Platform("support")
  @Get("workspaces/:id")
  workspace(@Param("id") id: string) {
    return this.admin.workspaceDetail(id);
  }

  @Platform("admin")
  @HttpCode(200)
  @Post("workspaces/:id/suspend")
  suspend(@Ctx() ctx: RequestContext, @Param("id") id: string, @Body(SuspendInput) body: z.infer<typeof SuspendInput>) {
    return this.admin.suspendWorkspace(ctx, id, body.reason);
  }

  @Platform("admin")
  @HttpCode(200)
  @Post("workspaces/:id/unsuspend")
  unsuspend(@Ctx() ctx: RequestContext, @Param("id") id: string) {
    return this.admin.unsuspendWorkspace(ctx, id);
  }

  // ─── Billing accounts & plans ──────────────────────────────────────────────

  @Platform("support")
  @Get("billing-accounts")
  accounts(@Query(AdminBillingAccountsQuery) q: z.infer<typeof AdminBillingAccountsQuery>) {
    return this.admin.listBillingAccounts(q);
  }

  @Platform("support")
  @Get("billing-accounts/:id")
  account(@Param("id") id: string) {
    return this.admin.billingAccountDetail(id);
  }

  /** docs/BILLING.md "Manual / invoiced customers": provider `manual`, refused over an active Stripe subscription. */
  @Platform("admin")
  @HttpCode(200)
  @Post("billing-accounts/:id/assign-plan")
  assignPlan(@Ctx() ctx: RequestContext, @Param("id") id: string, @Body(AdminAssignPlanInput) body: z.infer<typeof AdminAssignPlanInput>) {
    return this.admin.assignPlan(ctx, id, body);
  }

  @Platform("support")
  @Get("plans")
  plans() {
    return this.admin.listPlans();
  }

  @Platform("admin")
  @Post("plans")
  createPlan(@Ctx() ctx: RequestContext, @Body(PlanAdminInput) body: z.infer<typeof PlanAdminInput>) {
    return this.admin.createPlan(ctx, body);
  }

  @Platform("admin")
  @Put("plans/:key")
  updatePlan(@Ctx() ctx: RequestContext, @Param("key") key: string, @Body(AdminPlanUpdateInput) body: z.infer<typeof AdminPlanUpdateInput>) {
    return this.admin.updatePlan(ctx, key, body);
  }

  // ─── Settings, audit, platform mail ────────────────────────────────────────

  @Platform("support")
  @Get("settings")
  settings() {
    return this.admin.settings();
  }

  @Platform("admin")
  @Patch("settings")
  updateSettings(@Ctx() ctx: RequestContext, @Body(PlatformSettingsInput) body: z.infer<typeof PlatformSettingsInput>) {
    return this.admin.updateSettings(ctx, body);
  }

  @Platform("support")
  @Get("audit")
  audit(@Query(AdminAuditQuery) q: z.infer<typeof AdminAuditQuery>) {
    return this.admin.auditLog(q);
  }

  @Platform("support")
  @Get("email-log")
  emailLog(@Query(AdminEmailLogQuery) q: z.infer<typeof AdminEmailLogQuery>) {
    return this.admin.emailLog(q);
  }
}
