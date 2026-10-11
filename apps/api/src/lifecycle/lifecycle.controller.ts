import { Controller, Get, HttpCode, Param, Post, Res } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import type { Response } from "express";
import type { z } from "zod";
import {
  AcceptTermsInput,
  AdminDeleteWorkspaceInput,
  CloseAccountInput,
  DeleteWorkspaceInput,
  EraseContactInput,
  TransferOwnershipInput,
} from "@growthdesk/shared";
import { AllowSuspended, AllowUnverified, Body, Ctx, Permission, Platform, Raw } from "../common/decorators.js";
import type { RequestContext } from "../common/context.js";
import { SessionService } from "../auth/session.service.js";
import { WorkspaceLifecycleService } from "./workspace-lifecycle.service.js";
import { WorkspaceExportService } from "./workspace-export.service.js";
import { ContactPrivacyService } from "./contact-privacy.service.js";
import { AccountService } from "./account.service.js";

/*
 * Account lifecycle and GDPR routes (docs/PRIVACY_OPS.md):
 *
 *   POST /workspaces/:id/delete                     owner only, typed name
 *   POST /workspaces/:id/transfer-ownership         owner only
 *   GET  /workspaces/:id/exports                    data.export
 *   POST /workspaces/:id/exports                    data.export
 *   GET  /workspaces/:id/exports/:exportId/download data.export (raw file)
 *   GET  /workspaces/:id/contacts/:cid/privacy-export  contacts.export (JSON file)
 *   POST /workspaces/:id/contacts/:cid/erase        contacts.erase
 *   GET  /account                                   terms + whether the account can be closed
 *   GET  /account/export                            the person's own data (JSON file)
 *   POST /account/terms                             accept the Terms and Privacy Policy
 *   POST /account/close                             close one's own account
 *   POST /admin/workspaces/:id/delete|restore       platform admin
 *
 * Delete, transfer and exports also work while a workspace is suspended: a
 * customer can always take their data out or leave.
 */
@ApiTags("lifecycle")
@Controller()
export class LifecycleController {
  constructor(
    private readonly workspaces: WorkspaceLifecycleService,
    private readonly exports: WorkspaceExportService,
    private readonly contacts: ContactPrivacyService,
    private readonly account: AccountService,
    private readonly sessions: SessionService,
  ) {}

  // ─── Workspace ─────────────────────────────────────────────────────────────

  /** The owner rule is checked in the service (role, not a grantable permission). */
  @AllowSuspended()
  @HttpCode(200)
  @Post("workspaces/:workspaceId/delete")
  deleteWorkspace(@Ctx() ctx: RequestContext, @Body(DeleteWorkspaceInput) body: z.infer<typeof DeleteWorkspaceInput>) {
    return this.workspaces.deleteByOwner(ctx, body.confirmName);
  }

  @AllowSuspended()
  @HttpCode(200)
  @Post("workspaces/:workspaceId/transfer-ownership")
  transfer(@Ctx() ctx: RequestContext, @Body(TransferOwnershipInput) body: z.infer<typeof TransferOwnershipInput>) {
    return this.workspaces.transferOwnership(ctx, body.membershipId);
  }

  @AllowSuspended()
  @Permission("data.export")
  @Get("workspaces/:workspaceId/exports")
  listExports(@Ctx() ctx: RequestContext) {
    return this.exports.list(ctx);
  }

  @AllowSuspended()
  @Permission("data.export")
  @Post("workspaces/:workspaceId/exports")
  requestExport(@Ctx() ctx: RequestContext) {
    return this.exports.request(ctx);
  }

  @AllowSuspended()
  @Permission("data.export")
  @Raw()
  @Get("workspaces/:workspaceId/exports/:exportId/download")
  download(@Ctx() ctx: RequestContext, @Param("exportId") exportId: string, @Res() res: Response) {
    return this.exports.download(ctx, exportId, res);
  }

  // ─── One contact (data-subject requests) ──────────────────────────────────

  @Permission("contacts.export")
  @Raw()
  @Get("workspaces/:workspaceId/contacts/:contactId/privacy-export")
  async exportContact(@Ctx() ctx: RequestContext, @Param("contactId") contactId: string, @Res() res: Response) {
    const data = await this.contacts.exportContact(ctx, contactId);
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="contact-${data.contact.id}.json"`);
    res.setHeader("Cache-Control", "no-store");
    res.send(JSON.stringify(data, null, 2));
  }

  @Permission("contacts.erase")
  @HttpCode(200)
  @Post("workspaces/:workspaceId/contacts/:contactId/erase")
  erase(@Ctx() ctx: RequestContext, @Param("contactId") contactId: string, @Body(EraseContactInput) body: z.infer<typeof EraseContactInput>) {
    return this.contacts.erase(ctx, contactId, body.reason);
  }

  // ─── The signed-in person's own account ───────────────────────────────────

  @AllowUnverified()
  @Get("account")
  summary(@Ctx() ctx: RequestContext) {
    return this.account.summary(ctx);
  }

  @AllowUnverified()
  @Raw()
  @Get("account/export")
  async exportMine(@Ctx() ctx: RequestContext, @Res() res: Response) {
    const data = await this.account.exportMine(ctx);
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="my-account-data.json"`);
    res.setHeader("Cache-Control", "no-store");
    res.send(JSON.stringify(data, null, 2));
  }

  @AllowUnverified()
  @HttpCode(200)
  @Post("account/terms")
  acceptTerms(@Ctx() ctx: RequestContext, @Body(AcceptTermsInput) _body: z.infer<typeof AcceptTermsInput>) {
    return this.account.acceptTerms(ctx);
  }

  @AllowUnverified()
  @HttpCode(200)
  @Post("account/close")
  async close(@Ctx() ctx: RequestContext, @Body(CloseAccountInput) body: z.infer<typeof CloseAccountInput>, @Res({ passthrough: true }) res: Response) {
    const result = await this.account.close(ctx, body);
    this.sessions.clearCookie(res);
    return result;
  }

  // ─── Platform admin ───────────────────────────────────────────────────────

  @Platform("admin")
  @HttpCode(200)
  @Post("admin/workspaces/:id/delete")
  adminDelete(@Ctx() ctx: RequestContext, @Param("id") id: string, @Body(AdminDeleteWorkspaceInput) body: z.infer<typeof AdminDeleteWorkspaceInput>) {
    return this.workspaces.deleteByAdmin(ctx, id, body.reason);
  }

  @Platform("admin")
  @HttpCode(200)
  @Post("admin/workspaces/:id/restore")
  adminRestore(@Ctx() ctx: RequestContext, @Param("id") id: string) {
    return this.workspaces.restore(ctx, id);
  }
}
