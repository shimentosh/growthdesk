import { Injectable } from "@nestjs/common";
import { Prisma } from "../generated/prisma/client.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { holds, ws, type RequestContext } from "../common/context.js";
import { dayBounds } from "../tasks/tasks.service.js";
import { InboxService } from "./inbox.service.js";

/** How many of the oldest unanswered conversations the summary lists. */
const NEEDS_REPLY_TAKE = 5;

/*
 * GET /inbox/summary — the "Inbox today" overview shown when no conversation
 * is open. Read-only, and over the same conversations the caller can see in
 * the list (records.view_all, else assigned to them or unassigned):
 *
 *   unread        InboxService.unreadCount (open, not snoozed)
 *   needsReply    open, not snoozed, the contact wrote last (lastInboundAt
 *                 after lastOutboundAt, or nothing sent yet)
 *   snoozedToday  snoozed, waking before the end of today (workspace zone)
 *   mine          open, not snoozed, assigned to the caller
 *   oldest        the five longest-waiting of needsReply
 *   labels        open, not snoozed, per AI reply label
 */
@Injectable()
export class InboxSummaryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly inbox: InboxService,
  ) {}

  /** Same rule as InboxService.scope. */
  private scope(ctx: RequestContext): Prisma.ConversationWhereInput {
    if (holds(ctx, "records.view_all")) return {};
    return { OR: [{ assigneeId: ctx.identity?.userId ?? "00000000-0000-0000-0000-000000000000" }, { assigneeId: null }] };
  }

  async summary(ctx: RequestContext) {
    const w = ws(ctx);
    const db = this.prisma.db;
    const now = new Date();
    const user = ctx.identity?.userId ?? "00000000-0000-0000-0000-000000000000";
    const awake: Prisma.ConversationWhereInput = {
      workspaceId: w.id,
      status: "open",
      AND: [this.scope(ctx), { OR: [{ snoozedUntil: null }, { snoozedUntil: { lte: now } }] }],
    };
    const needsReply: Prisma.ConversationWhereInput = {
      ...awake,
      lastInboundAt: { not: null },
      OR: [{ lastOutboundAt: null }, { lastInboundAt: { gt: this.prisma.unscoped.conversation.fields.lastOutboundAt } }],
    };
    const { end } = dayBounds(w.timezone, now);
    const [unread, needsReplyCount, snoozedToday, mine, oldest, labels] = await Promise.all([
      this.inbox.unreadCount(ctx),
      db.conversation.count({ where: needsReply }),
      db.conversation.count({ where: { workspaceId: w.id, status: "open", snoozedUntil: { gt: now, lte: end }, AND: [this.scope(ctx)] } }),
      db.conversation.count({ where: { ...awake, assigneeId: user } }),
      db.conversation.findMany({
        where: needsReply,
        orderBy: [{ lastInboundAt: "asc" }, { id: "asc" }],
        take: NEEDS_REPLY_TAKE,
        select: {
          id: true,
          channel: true,
          subject: true,
          displayName: true,
          handle: true,
          aiCategory: true,
          lastInboundAt: true,
          contact: { select: { id: true, fullName: true, email: true } },
          assignee: { select: { id: true, name: true, email: true } },
        },
      }),
      db.conversation.groupBy({ by: ["aiCategory"], where: { ...awake, aiCategory: { not: "" } }, _count: { _all: true } }),
    ]);
    return {
      unread: unread.total,
      needsReply: needsReplyCount,
      snoozedToday,
      mine,
      oldest,
      labels: labels.map((l) => ({ category: l.aiCategory, count: l._count._all })).sort((a, b) => b.count - a.count),
    };
  }
}
