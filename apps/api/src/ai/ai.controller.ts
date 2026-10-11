import { Controller, Get, HttpCode, Param, Post } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import type { z } from "zod";
import { AiDraftInput, AiReplyDraftInput, AiSummaryInput, AiWriteInput, type AiReplyDraftInputT, type AiSummaryInputT, type AiWriteInputT } from "@growthdesk/shared";
import { Body, Ctx, Permission } from "../common/decorators.js";
import type { RequestContext } from "../common/context.js";
import { AiService } from "./ai.service.js";

/*
 * The AI assistant, under /workspaces/:workspaceId/ai.
 *
 * Every generating route needs ai.use; the service adds the permission for
 * the record it reads (inbox.read, contacts.read, deals.read) and that
 * record's visibility rules. Generation answers 503 when no provider is
 * configured, 402 when the plan lacks `ai` or the month's AI credits are used
 * up. Nothing is sent or saved: drafts come back for a person to edit.
 *
 *   GET  status                          capability check for the UI (any member)
 *   POST conversations/:id/draft-reply   reply suggestion for an inbox thread
 *   POST conversations/:id/classify      label the latest reply now (inbox.reply|assign)
 *   POST draft-message                   first message to a contact (compose)
 *   POST write                           write / improve a template or sequence step
 *   GET  contacts/:id/summary            cached summary of the record as it is, or null (free)
 *   POST contacts/:id/summary            generate it (one credit unless cached)
 *   GET|POST deals/:id/summary           the same for a deal
 */
@ApiTags("ai")
@Controller("workspaces/:workspaceId/ai")
export class AiController {
  constructor(private readonly ai: AiService) {}

  @Get("status")
  status(@Ctx() ctx: RequestContext) {
    return this.ai.status(ctx);
  }

  @Permission("ai.use")
  @HttpCode(200)
  @Post("conversations/:id/draft-reply")
  draftReply(@Ctx() ctx: RequestContext, @Param("id") id: string, @Body(AiReplyDraftInput) body: AiReplyDraftInputT) {
    return this.ai.draftReply(ctx, id, body);
  }

  @Permission("ai.use")
  @HttpCode(200)
  @Post("conversations/:id/classify")
  classify(@Ctx() ctx: RequestContext, @Param("id") id: string) {
    return this.ai.classifyConversation(ctx, id);
  }

  @Permission("ai.use")
  @HttpCode(200)
  @Post("draft-message")
  draftMessage(@Ctx() ctx: RequestContext, @Body(AiDraftInput) body: z.infer<typeof AiDraftInput>) {
    return this.ai.draftMessage(ctx, body);
  }

  @Permission("ai.use")
  @HttpCode(200)
  @Post("write")
  write(@Ctx() ctx: RequestContext, @Body(AiWriteInput) body: AiWriteInputT) {
    return this.ai.write(ctx, body);
  }

  @Permission("ai.use")
  @Get("contacts/:id/summary")
  cachedContactSummary(@Ctx() ctx: RequestContext, @Param("id") id: string) {
    return this.ai.summary(ctx, "contact", id, { fresh: false }, false);
  }

  @Permission("ai.use")
  @HttpCode(200)
  @Post("contacts/:id/summary")
  contactSummary(@Ctx() ctx: RequestContext, @Param("id") id: string, @Body(AiSummaryInput) body: AiSummaryInputT) {
    return this.ai.summary(ctx, "contact", id, body, true);
  }

  @Permission("ai.use")
  @Get("deals/:id/summary")
  cachedDealSummary(@Ctx() ctx: RequestContext, @Param("id") id: string) {
    return this.ai.summary(ctx, "deal", id, { fresh: false }, false);
  }

  @Permission("ai.use")
  @HttpCode(200)
  @Post("deals/:id/summary")
  dealSummary(@Ctx() ctx: RequestContext, @Param("id") id: string, @Body(AiSummaryInput) body: AiSummaryInputT) {
    return this.ai.summary(ctx, "deal", id, body, true);
  }
}
