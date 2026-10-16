import { Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Res } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import type { Response } from "express";
import { z } from "zod";
import { ComposeInput, ConversationPatchInput, ConversationTagsInput, ReplyInput, requiredText } from "@growthdesk/shared";
import { Body, Ctx, Permission, Query, Raw } from "../common/decorators.js";
import { ws, type RequestContext } from "../common/context.js";
import { RealtimeService } from "../realtime/realtime.service.js";
import { InboxService } from "./inbox.service.js";
import { InboxSummaryService } from "./inbox-summary.service.js";
import { ConversationListQuery, ConversationTaskInput, type ConversationListQueryT, type ConversationTaskInputT } from "./inbox.schemas.js";

const ConversationNoteInput = z.object({ body: requiredText(10000) });

/*
 * The unified inbox, under /workspaces/:workspaceId/inbox.
 *
 * Permissions (the guard checks any-of; the service adds the finer rules):
 *   reading (list, unread count, thread, notes)          inbox.read
 *   working a conversation (status, snooze, mark read,
 *     claim it, internal notes)                          inbox.reply or inbox.assign
 *   assigning it to / taking it from someone else         inbox.assign (service)
 *   sending (reply, compose)                              inbox.reply
 *   a follow-up task                                      inbox.read + tasks.write (service)
 * Visibility follows records.view_all: without it, only conversations
 * assigned to you or unassigned exist (others answer 404).
 */
@ApiTags("inbox")
@Controller("workspaces/:workspaceId/inbox")
export class InboxController {
  constructor(
    private readonly inbox: InboxService,
    private readonly realtime: RealtimeService,
    private readonly summaries: InboxSummaryService,
  ) {}

  @Permission("inbox.read")
  @Get("conversations")
  list(@Ctx() ctx: RequestContext, @Query(ConversationListQuery) q: ConversationListQueryT) {
    return this.inbox.list(ctx, q);
  }

  /** Open, unread, not snoozed — per channel and in total (the sidebar badge). */
  @Permission("inbox.read")
  @Get("unread-count")
  unreadCount(@Ctx() ctx: RequestContext) {
    return this.inbox.unreadCount(ctx);
  }

  /** Counts for the filter rail: views, channels, campaigns with replies, tags, live-chat widgets. */
  @Permission("inbox.read")
  @Get("facets")
  facets(@Ctx() ctx: RequestContext) {
    return this.inbox.facets(ctx);
  }

  /** "Inbox today": unread, needs a reply, snoozed until today, mine, the oldest unanswered and the AI-label counts. */
  @Permission("inbox.read")
  @Get("summary")
  summary(@Ctx() ctx: RequestContext) {
    return this.summaries.summary(ctx);
  }

  /**
   * Server-Sent Events: `conversation` { conversationId, reason } whenever one
   * changes (new message, reply, status, tags). Ids only: the page refetches
   * what it shows through the normal, permission-checked endpoints.
   */
  @Permission("inbox.read")
  @Raw()
  @Get("stream")
  stream(@Ctx() ctx: RequestContext, @Res() res: Response) {
    this.realtime.stream(res, [`ws:${ws(ctx).id}`]);
  }

  /** New outbound message to a contact (starts or continues their conversation on that channel). */
  @Permission("inbox.reply")
  @Post("compose")
  compose(@Ctx() ctx: RequestContext, @Body(ComposeInput) body: z.infer<typeof ComposeInput>) {
    return this.inbox.compose(ctx, body);
  }

  /** The thread (oldest first, newest 500), notes, the contact's open deals and tasks, and chat reachability. */
  @Permission("inbox.read")
  @Get("conversations/:id")
  detail(@Ctx() ctx: RequestContext, @Param("id") id: string) {
    return this.inbox.detail(ctx, id);
  }

  @Permission("inbox.reply", "inbox.assign")
  @Patch("conversations/:id")
  patch(@Ctx() ctx: RequestContext, @Param("id") id: string, @Body(ConversationPatchInput) body: z.infer<typeof ConversationPatchInput>) {
    return this.inbox.patch(ctx, id, body);
  }

  @Permission("inbox.reply", "inbox.assign")
  @HttpCode(200)
  @Post("conversations/:id/read")
  markRead(@Ctx() ctx: RequestContext, @Param("id") id: string) {
    return this.inbox.markRead(ctx, id);
  }

  @Permission("inbox.reply")
  @Post("conversations/:id/reply")
  reply(@Ctx() ctx: RequestContext, @Param("id") id: string, @Body(ReplyInput) body: z.infer<typeof ReplyInput>) {
    return this.inbox.reply(ctx, id, body);
  }

  /** Replace the conversation's tags. */
  @Permission("inbox.reply", "inbox.assign")
  @Put("conversations/:id/tags")
  setTags(@Ctx() ctx: RequestContext, @Param("id") id: string, @Body(ConversationTagsInput) body: z.infer<typeof ConversationTagsInput>) {
    return this.inbox.setTags(ctx, id, body.tagIds);
  }

  @Permission("inbox.read")
  @Get("conversations/:id/notes")
  notes(@Ctx() ctx: RequestContext, @Param("id") id: string) {
    return this.inbox.notes(ctx, id);
  }

  @Permission("inbox.reply", "inbox.assign")
  @Post("conversations/:id/notes")
  addNote(@Ctx() ctx: RequestContext, @Param("id") id: string, @Body(ConversationNoteInput) body: z.infer<typeof ConversationNoteInput>) {
    return this.inbox.addNote(ctx, id, body.body);
  }

  /** The note's author, or anyone holding inbox.assign. */
  @Permission("inbox.reply", "inbox.assign")
  @Delete("conversations/:id/notes/:noteId")
  removeNote(@Ctx() ctx: RequestContext, @Param("id") id: string, @Param("noteId") noteId: string) {
    return this.inbox.removeNote(ctx, id, noteId);
  }

  @Permission("inbox.read")
  @Post("conversations/:id/tasks")
  createTask(@Ctx() ctx: RequestContext, @Param("id") id: string, @Body(ConversationTaskInput) body: ConversationTaskInputT) {
    return this.inbox.createTask(ctx, id, body);
  }
}
