import { Controller, Get, Param, Patch, Post } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import type { z } from "zod";
import {
  AdminSupportCaseCreateInput,
  AdminSupportCaseUpdateInput,
  AdminSupportCasesQuery,
  AdminSupportNoteInput,
  AdminSupportViewQuery,
} from "@growthdesk/shared";
import { Body, Ctx, Platform, Query } from "../common/decorators.js";
import type { RequestContext } from "../common/context.js";
import { AdminSupportService } from "./admin-support.service.js";

/** /v1/admin/support/… — the case queue, active grants, and the grant-gated support view of a workspace. */
@ApiTags("admin")
@Platform("support")
@Controller("admin/support")
export class AdminSupportController {
  constructor(private readonly support: AdminSupportService) {}

  @Get("cases")
  cases(@Query(AdminSupportCasesQuery) q: z.infer<typeof AdminSupportCasesQuery>) {
    return this.support.listCases(q);
  }

  @Post("cases")
  open(@Ctx() ctx: RequestContext, @Body(AdminSupportCaseCreateInput) body: z.infer<typeof AdminSupportCaseCreateInput>) {
    return this.support.createCase(ctx, body);
  }

  @Get("cases/:id")
  detail(@Param("id") id: string) {
    return this.support.caseDetail(id);
  }

  @Patch("cases/:id")
  update(@Ctx() ctx: RequestContext, @Param("id") id: string, @Body(AdminSupportCaseUpdateInput) body: z.infer<typeof AdminSupportCaseUpdateInput>) {
    return this.support.updateCase(ctx, id, body);
  }

  @Post("cases/:id/notes")
  note(@Ctx() ctx: RequestContext, @Param("id") id: string, @Body(AdminSupportNoteInput) body: z.infer<typeof AdminSupportNoteInput>) {
    return this.support.addNote(ctx, id, body.body);
  }

  @Get("grants")
  grants() {
    return this.support.activeGrants();
  }

  // ─── Support view (needs the workspace's active SupportAccessGrant) ────────

  @Get("workspaces/:id")
  summary(@Ctx() ctx: RequestContext, @Param("id") id: string) {
    return this.support.supportSummary(ctx, id);
  }

  @Get("workspaces/:id/contacts")
  contacts(@Ctx() ctx: RequestContext, @Param("id") id: string, @Query(AdminSupportViewQuery) q: z.infer<typeof AdminSupportViewQuery>) {
    return this.support.supportContacts(ctx, id, q);
  }

  @Get("workspaces/:id/conversations")
  conversations(@Ctx() ctx: RequestContext, @Param("id") id: string, @Query(AdminSupportViewQuery) q: z.infer<typeof AdminSupportViewQuery>) {
    return this.support.supportConversations(ctx, id, q);
  }

  @Get("workspaces/:id/conversations/:conversationId")
  conversation(@Ctx() ctx: RequestContext, @Param("id") id: string, @Param("conversationId") conversationId: string) {
    return this.support.supportConversation(ctx, id, conversationId);
  }
}
