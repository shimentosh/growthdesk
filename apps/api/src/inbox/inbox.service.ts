import { Inject, Injectable } from "@nestjs/common";
import sanitizeHtml from "sanitize-html";
import type { z } from "zod";
import type { ComposeInput, ConversationPatchInput, ReplyInput } from "@growthdesk/shared";
import { Prisma } from "../generated/prisma/client.js";
import type { Message } from "../generated/prisma/client.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { OutboundEmailService, type SendEmailResult } from "../messaging/outbound-email.service.js";
import { ActivityService } from "../crm/activity.service.js";
import { NotificationsService } from "../notifications/notifications.service.js";
import { ApiError, badRequest, conflict, forbidden, notFound } from "../common/errors.js";
import { holds, me, ownershipScope, ws, type RequestContext } from "../common/context.js";
import { CHAT_SENDER, type ChatChannel, type ChatSender, type ChatSendResult } from "../channels/chat-sender.js";
import { ChannelsService } from "../channels/channels.service.js";
import type { ConversationListQueryT, ConversationTaskInputT } from "./inbox.schemas.js";

/*
 * The unified inbox: email, WhatsApp and Telegram conversations in one list.
 *
 * Visibility: a role with records.view_all sees every conversation; without
 * it, a person sees conversations assigned to them and unassigned ones (for
 * triage) — the same rule as tasks. Anything outside that answers 404.
 *
 * Sending is synchronous: email through OutboundEmailService (the only email
 * path), chat through the ChatSender. Provider outcomes map to HTTP as
 *   sent → 201 with the message;  deferred / failed / uncertain / unavailable → 409 with the reason;
 *   blocked (suppressed, opted out) → 422.
 */

const conversationInclude = {
  contact: { select: { id: true, fullName: true, email: true, phone: true, status: true, company: { select: { id: true, name: true } } } },
  assignee: { select: { id: true, name: true, email: true } },
  messages: { orderBy: { createdAt: "desc" }, take: 1, select: { id: true, direction: true, bodyText: true, createdAt: true, status: true } },
} satisfies Prisma.ConversationInclude;

type ConversationRow = Prisma.ConversationGetPayload<{ include: typeof conversationInclude }>;

const SANITIZE: sanitizeHtml.IOptions = {
  allowedTags: sanitizeHtml.defaults.allowedTags,
  allowedAttributes: { a: ["href", "title"], td: ["colspan", "rowspan"], th: ["colspan", "rowspan"] },
  allowedSchemes: ["http", "https", "mailto", "tel"],
  transformTags: { a: sanitizeHtml.simpleTransform("a", { target: "_blank", rel: "noopener noreferrer nofollow" }) },
};

/** "Re: Re: Fwd: Hello" → "Hello". */
export const baseSubject = (s: string) => s.replace(/^(\s*(re|fwd?|aw|sv)\s*(\[\d+\])?\s*:\s*)+/i, "").trim();

export function conversationRow(c: ConversationRow) {
  const last = c.messages[0];
  return {
    id: c.id,
    channel: c.channel,
    subject: c.subject,
    status: c.status,
    unread: c.unread,
    displayName: c.displayName,
    handle: c.handle,
    contact: c.contact,
    assignee: c.assignee,
    mailboxId: c.mailboxId,
    integrationId: c.channelIntegrationId,
    campaignId: c.campaignId,
    dealId: c.dealId,
    aiCategory: c.aiCategory,
    aiSentiment: c.aiSentiment,
    lastMessageAt: c.lastMessageAt,
    lastInboundAt: c.lastInboundAt,
    lastOutboundAt: c.lastOutboundAt,
    snoozedUntil: c.snoozedUntil,
    preview: last ? { direction: last.direction, status: last.status, text: last.bodyText.replace(/\s+/g, " ").trim().slice(0, 160), at: last.createdAt } : null,
    createdAt: c.createdAt,
  };
}

export function messageDto(m: Message, authors: Map<string, { id: string; name: string }> = new Map()) {
  return {
    id: m.id,
    conversationId: m.conversationId,
    channel: m.channel,
    direction: m.direction,
    status: m.status,
    fromAddress: m.fromAddress,
    toAddress: m.toAddress,
    cc: m.cc,
    subject: m.subject,
    bodyText: m.bodyText,
    // Sanitised on ingest; sanitised again here so a row written by any path is safe to render.
    bodyHtml: m.bodyHtml ? sanitizeHtml(m.bodyHtml, SANITIZE) : null,
    providerMessageId: m.providerMessageId,
    inReplyTo: m.inReplyTo,
    references: m.references,
    isAutoReply: m.isAutoReply,
    author: m.authorId ? (authors.get(m.authorId) ?? { id: m.authorId, name: "" }) : null,
    campaignId: m.campaignId,
    enrollmentId: m.enrollmentId,
    mailboxId: m.mailboxId,
    integrationId: m.channelIntegrationId,
    error: m.error,
    sentAt: m.sentAt,
    receivedAt: m.receivedAt,
    deliveredAt: m.deliveredAt,
    readAt: m.readAt,
    openedAt: m.openedAt,
    openCount: m.openCount,
    clickedAt: m.clickedAt,
    clickCount: m.clickCount,
    bouncedAt: m.bouncedAt,
    createdAt: m.createdAt,
  };
}

const sendRefused = (reason: string, details: Record<string, unknown>) => new ApiError(409, "send_failed", reason, undefined, details);
const sendBlocked = (reason: string) => new ApiError(422, "blocked", reason);

@Injectable()
export class InboxService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly outbound: OutboundEmailService,
    private readonly channels: ChannelsService,
    private readonly activity: ActivityService,
    private readonly notifications: NotificationsService,
    @Inject(CHAT_SENDER) private readonly chat: ChatSender,
  ) {}

  /** Without records.view_all: assigned to me, or unassigned. */
  private scope(ctx: RequestContext): Prisma.ConversationWhereInput {
    if (holds(ctx, "records.view_all")) return {};
    return { OR: [{ assigneeId: ctx.identity?.userId ?? "00000000-0000-0000-0000-000000000000" }, { assigneeId: null }] };
  }

  async find(ctx: RequestContext, id: string) {
    const w = ws(ctx);
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound("That conversation");
    const c = await this.prisma.db.conversation.findFirst({ where: { id, workspaceId: w.id, AND: [this.scope(ctx)] } });
    if (!c) throw notFound("That conversation");
    return c;
  }

  async list(ctx: RequestContext, q: ConversationListQueryT) {
    const w = ws(ctx);
    const user = ctx.identity?.userId ?? null;
    const now = new Date();
    const and: Prisma.ConversationWhereInput[] = [this.scope(ctx)];
    if (q.status === "open") and.push({ status: "open", OR: [{ snoozedUntil: null }, { snoozedUntil: { lte: now } }] });
    else if (q.status === "snoozed") and.push({ status: "open", snoozedUntil: { gt: now } });
    else if (q.status === "closed") and.push({ status: "closed" });
    if (q.channel) and.push({ channel: q.channel });
    if (q.unread !== undefined) and.push({ unread: q.unread });
    if (q.assignee === "me") and.push({ assigneeId: user ?? "00000000-0000-0000-0000-000000000000" });
    else if (q.assignee === "none") and.push({ assigneeId: null });
    else if (q.assignee) and.push({ assigneeId: q.assignee });
    if (q.mailboxId) and.push({ mailboxId: q.mailboxId });
    if (q.campaignId) and.push({ campaignId: q.campaignId });
    if (q.q) {
      const term = q.q.trim();
      and.push({
        OR: [
          { subject: { contains: term, mode: "insensitive" } },
          { displayName: { contains: term, mode: "insensitive" } },
          { handle: { contains: term, mode: "insensitive" } },
          { contact: { fullName: { contains: term, mode: "insensitive" } } },
          { contact: { email: { contains: term.toLowerCase() } } },
        ],
      });
    }
    const where: Prisma.ConversationWhereInput = { workspaceId: w.id, AND: and };
    const [rows, total] = await Promise.all([
      this.prisma.db.conversation.findMany({
        where,
        include: conversationInclude,
        orderBy: [{ lastMessageAt: { sort: "desc", nulls: "last" } }, { id: "desc" }],
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      this.prisma.db.conversation.count({ where }),
    ]);
    return { items: rows.map(conversationRow), total, page: q.page, pageSize: q.pageSize };
  }

  async unreadCount(ctx: RequestContext) {
    const w = ws(ctx);
    const rows = await this.prisma.db.conversation.groupBy({
      by: ["channel"],
      // Snoozed conversations stay out of the count until they wake.
      where: { workspaceId: w.id, unread: true, status: "open", AND: [this.scope(ctx), { OR: [{ snoozedUntil: null }, { snoozedUntil: { lte: new Date() } }] }] },
      _count: { _all: true },
    });
    const byChannel: Record<string, number> = { email: 0, whatsapp: 0, telegram: 0 };
    for (const r of rows) byChannel[r.channel] = r._count._all;
    return { total: Object.values(byChannel).reduce((a, b) => a + b, 0), byChannel };
  }

  private async authors(ids: (string | null)[]) {
    const unique = [...new Set(ids.filter((x): x is string => Boolean(x)))];
    if (!unique.length) return new Map<string, { id: string; name: string }>();
    const users = await this.prisma.db.user.findMany({ where: { id: { in: unique } }, select: { id: true, name: true } });
    return new Map(users.map((u) => [u.id, u]));
  }

  async detail(ctx: RequestContext, id: string) {
    const w = ws(ctx);
    const c = await this.find(ctx, id);
    const db = this.prisma.db;
    const [full, newest, notes, deals, tasks, campaign] = await Promise.all([
      db.conversation.findFirstOrThrow({
        where: { id: c.id, workspaceId: w.id },
        include: {
          ...conversationInclude,
          contact: {
            select: {
              id: true,
              fullName: true,
              email: true,
              phone: true,
              jobTitle: true,
              status: true,
              ownerId: true,
              doNotContact: true,
              unsubscribedAt: true,
              lastContactedAt: true,
              lastRepliedAt: true,
              company: { select: { id: true, name: true, domain: true } },
            },
          },
          mailbox: { select: { id: true, email: true, displayName: true, status: true, lastError: true } },
          integration: { select: { id: true, name: true, channel: true, provider: true, status: true, lastError: true } },
        },
      }),
      db.message.findMany({ where: { workspaceId: w.id, conversationId: c.id }, orderBy: { createdAt: "desc" }, take: 500 }),
      db.conversationNote.findMany({ where: { workspaceId: w.id, conversationId: c.id }, orderBy: { createdAt: "asc" } }),
      c.contactId
        ? db.deal.findMany({
            where: { workspaceId: w.id, contactId: c.contactId, status: "open", deletedAt: null },
            include: { stage: { select: { id: true, name: true } } },
            orderBy: { createdAt: "desc" },
          })
        : Promise.resolve([]),
      db.task.findMany({
        where: { workspaceId: w.id, status: "open", OR: [{ conversationId: c.id }, ...(c.contactId ? [{ contactId: c.contactId }] : [])] },
        orderBy: { dueAt: { sort: "asc", nulls: "last" } },
        take: 20,
        select: { id: true, type: true, title: true, dueAt: true, priority: true, assigneeId: true, conversationId: true },
      }),
      c.campaignId ? db.campaign.findFirst({ where: { id: c.campaignId, workspaceId: w.id }, select: { id: true, name: true, status: true } }) : Promise.resolve(null),
    ]);
    const messages = newest.reverse();
    const authors = await this.authors([...messages.map((m) => m.authorId), ...notes.map((n) => n.authorId)]);
    const channel = c.channel;
    const reachability =
      (channel === "whatsapp" || channel === "telegram") && c.contactId ? await this.chat.reachability(w.id, channel, c.contactId) : null;
    return {
      ...conversationRow(full),
      peer: full.peer,
      contact: full.contact,
      mailbox: full.mailbox,
      integration: full.integration,
      messages: messages.map((m) => messageDto(m, authors)),
      notes: notes.map((n) => ({ id: n.id, body: n.body, author: n.authorId ? (authors.get(n.authorId) ?? { id: n.authorId, name: "" }) : null, createdAt: n.createdAt })),
      deals: deals.map((d) => ({ id: d.id, name: d.name, value: Number(d.value), currency: d.currency, status: d.status, stage: d.stage })),
      tasks,
      campaign,
      reachability,
    };
  }

  async patch(ctx: RequestContext, id: string, input: z.infer<typeof ConversationPatchInput>) {
    const w = ws(ctx);
    const c = await this.find(ctx, id);
    const self = ctx.identity?.userId ?? null;
    const data: Prisma.ConversationUncheckedUpdateInput = {};
    if (input.unread !== undefined) data.unread = input.unread;
    if (input.status !== undefined) data.status = input.status;
    if (input.snoozedUntil !== undefined) data.snoozedUntil = input.snoozedUntil;
    let notifyAssignee: string | null = null;
    if (input.assigneeId !== undefined && input.assigneeId !== c.assigneeId) {
      const touchesOthers = (input.assigneeId !== null && input.assigneeId !== self) || (c.assigneeId !== null && c.assigneeId !== self);
      if (touchesOthers && !holds(ctx, "inbox.assign")) throw forbidden("Your role cannot assign conversations to other people");
      if (input.assigneeId) {
        const member = await this.prisma.db.membership.findUnique({ where: { workspaceId_userId: { workspaceId: w.id, userId: input.assigneeId } } });
        if (!member) throw badRequest("Conversations can only be assigned to members of this workspace", { assigneeId: "Not a member" });
        if (input.assigneeId !== self) notifyAssignee = input.assigneeId;
      }
      data.assigneeId = input.assigneeId;
    }
    if (input.dealId !== undefined) {
      if (input.dealId) {
        const deal = await this.prisma.db.deal.findFirst({ where: { id: input.dealId, workspaceId: w.id, deletedAt: null }, select: { id: true } });
        if (!deal) throw notFound("That deal");
      }
      data.dealId = input.dealId;
    }
    if (Object.keys(data).length) await this.prisma.db.conversation.update({ where: { id: c.id, workspaceId: w.id }, data });
    if (notifyAssignee) {
      await this.notifications.notify(w.id, [notifyAssignee], {
        type: "conversation.assigned",
        title: `Conversation assigned to you: ${c.displayName || c.handle || c.subject}`,
        link: `/w/${w.id}/inbox?c=${c.id}`,
      });
    }
    return this.summary(ctx, c.id);
  }

  private async summary(ctx: RequestContext, id: string) {
    const w = ws(ctx);
    const row = await this.prisma.db.conversation.findFirst({ where: { id, workspaceId: w.id }, include: conversationInclude });
    if (!row) throw notFound("That conversation");
    return conversationRow(row);
  }

  async markRead(ctx: RequestContext, id: string) {
    const w = ws(ctx);
    const c = await this.find(ctx, id);
    await this.prisma.db.conversation.update({ where: { id: c.id, workspaceId: w.id }, data: { unread: false } });
    return { id: c.id, unread: false };
  }

  private async messageOut(workspaceId: string, messageRowId: string) {
    const m = await this.prisma.db.message.findFirst({ where: { id: messageRowId, workspaceId } });
    if (!m) throw notFound("That message");
    return messageDto(m, await this.authors([m.authorId]));
  }

  private async emailOutcome(workspaceId: string, result: SendEmailResult) {
    switch (result.status) {
      case "sent":
        return this.messageOut(workspaceId, result.messageRowId);
      case "blocked":
        throw sendBlocked(result.reason);
      default:
        throw sendRefused(result.reason, { status: result.status, messageId: "messageRowId" in result ? (result.messageRowId ?? null) : null });
    }
  }

  private async chatOutcome(workspaceId: string, result: ChatSendResult) {
    switch (result.status) {
      case "sent":
        return this.messageOut(workspaceId, result.messageRowId);
      case "blocked":
        throw sendBlocked(result.reason);
      default:
        throw sendRefused(result.reason, { status: result.status, messageId: "messageRowId" in result ? (result.messageRowId ?? null) : null });
    }
  }

  async reply(ctx: RequestContext, id: string, input: z.infer<typeof ReplyInput>) {
    const w = ws(ctx);
    const author = me(ctx).userId;
    const c = await this.find(ctx, id);
    let out;
    if (c.channel === "email") {
      const mailboxId = input.mailboxId ?? c.mailboxId;
      if (!mailboxId) throw conflict("Choose a mailbox to reply from — this conversation has none.");
      const mailbox = await this.prisma.db.mailbox.findFirst({ where: { id: mailboxId, workspaceId: w.id, deletedAt: null }, select: { id: true } });
      if (!mailbox) throw notFound("That mailbox");
      let to = c.peer;
      if (!to && c.contactId) to = (await this.prisma.db.contact.findFirst({ where: { id: c.contactId, workspaceId: w.id }, select: { email: true } }))?.email ?? "";
      if (!to) throw conflict("This conversation has no address to reply to.");
      // Thread on the newest message they sent; else on our own newest.
      const parent =
        (await this.prisma.db.message.findFirst({
          where: { workspaceId: w.id, conversationId: c.id, direction: "inbound", providerMessageId: { not: null } },
          orderBy: { createdAt: "desc" },
        })) ??
        (await this.prisma.db.message.findFirst({
          where: { workspaceId: w.id, conversationId: c.id, direction: "outbound", providerMessageId: { not: null } },
          orderBy: { createdAt: "desc" },
        }));
      const inReplyTo = parent?.providerMessageId ?? null;
      const references = inReplyTo ? [...new Set([...(parent?.references ?? "").split(/\s+/).filter(Boolean), inReplyTo])].join(" ") : null;
      const original = c.subject || parent?.subject || "";
      const subject = input.subject?.trim() || `Re: ${baseSubject(original) || "(no subject)"}`;
      const result = await this.outbound.send({
        workspaceId: w.id,
        mailboxId,
        to,
        toName: c.displayName && c.displayName !== to ? c.displayName : undefined,
        subject,
        body: input.body,
        contactId: c.contactId,
        conversationId: c.id,
        authorId: author,
        inReplyTo,
        references,
        kind: "manual",
      });
      out = await this.emailOutcome(w.id, result);
    } else if (c.channel === "whatsapp" || c.channel === "telegram") {
      const base = { workspaceId: w.id, channel: c.channel as ChatChannel, conversationId: c.id, integrationId: c.channelIntegrationId, body: input.body, authorId: author };
      const result = c.contactId ? await this.chat.send({ ...base, contactId: c.contactId }) : await this.channels.deliver({ ...base, contactId: null });
      out = await this.chatOutcome(w.id, result);
    } else {
      throw badRequest("Call conversations cannot be replied to — log a call instead.");
    }
    await this.prisma.db.conversation.update({ where: { id: c.id, workspaceId: w.id }, data: { unread: false } });
    return out;
  }

  async compose(ctx: RequestContext, input: z.infer<typeof ComposeInput>) {
    const w = ws(ctx);
    const author = me(ctx).userId;
    const contact = await this.prisma.db.contact.findFirst({
      where: { id: input.contactId, workspaceId: w.id, deletedAt: null, ...(ownershipScope(ctx) as Prisma.ContactWhereInput) },
    });
    if (!contact) throw notFound("That contact");
    if (input.channel === "email") {
      if (!contact.email) throw badRequest("This contact has no email address.");
      const subject = input.subject?.trim();
      if (!subject) throw badRequest("A subject is required", { subject: "Required" });
      let mailboxId = input.mailboxId ?? null;
      if (mailboxId) {
        const box = await this.prisma.db.mailbox.findFirst({ where: { id: mailboxId, workspaceId: w.id, deletedAt: null }, select: { id: true } });
        if (!box) throw notFound("That mailbox");
      } else {
        mailboxId = (await this.outbound.pickMailbox(w.id, []))?.id ?? null;
        if (!mailboxId) throw conflict("Connect a mailbox before sending email.");
      }
      if (input.templateId) await this.template(w.id, input.templateId, "email");
      const result = await this.outbound.send({
        workspaceId: w.id,
        mailboxId,
        to: contact.email,
        toName: contact.fullName || undefined,
        subject,
        body: input.body,
        contactId: contact.id,
        templateId: input.templateId ?? null,
        authorId: author,
        kind: "manual",
      });
      return this.emailOutcome(w.id, result);
    }
    const channel = input.channel;
    const reach = await this.chat.reachability(w.id, channel, contact.id);
    if (!reach.reachable) throw sendRefused(reach.reason, { status: "unavailable" });
    let template: { name: string; language: string; params?: string[] } | null = null;
    if (input.templateId) {
      const t = await this.template(w.id, input.templateId, channel);
      if (channel === "whatsapp") {
        if (!t.waTemplate) throw badRequest("That template has no approved WhatsApp template name.");
        template = { name: t.waTemplate, language: t.waLanguage || "en_US", params: [] };
      }
    }
    const result = await this.chat.send({
      workspaceId: w.id,
      channel,
      contactId: contact.id,
      integrationId: input.integrationId ?? null,
      body: input.body,
      template,
      templateId: input.templateId ?? null,
      authorId: author,
    });
    return this.chatOutcome(w.id, result);
  }

  private async template(workspaceId: string, id: string, channel: "email" | "whatsapp" | "telegram") {
    const t = await this.prisma.db.template.findFirst({ where: { id, workspaceId, archivedAt: null } });
    if (!t) throw notFound("That template");
    if (t.channel !== channel) throw badRequest(`That is a ${t.channel} template`);
    return t;
  }

  // ─── Notes and tasks ───────────────────────────────────────────────────────

  async notes(ctx: RequestContext, id: string) {
    const w = ws(ctx);
    const c = await this.find(ctx, id);
    const notes = await this.prisma.db.conversationNote.findMany({ where: { workspaceId: w.id, conversationId: c.id }, orderBy: { createdAt: "asc" } });
    const authors = await this.authors(notes.map((n) => n.authorId));
    return notes.map((n) => ({ id: n.id, body: n.body, author: n.authorId ? (authors.get(n.authorId) ?? { id: n.authorId, name: "" }) : null, createdAt: n.createdAt }));
  }

  async addNote(ctx: RequestContext, id: string, body: string) {
    const w = ws(ctx);
    const c = await this.find(ctx, id);
    const author = me(ctx);
    const n = await this.prisma.db.conversationNote.create({ data: { workspaceId: w.id, conversationId: c.id, authorId: author.userId, body } });
    return { id: n.id, body: n.body, author: { id: author.userId, name: author.name }, createdAt: n.createdAt };
  }

  async removeNote(ctx: RequestContext, conversationId: string, noteId: string) {
    const w = ws(ctx);
    const c = await this.find(ctx, conversationId);
    if (!/^[0-9a-f-]{36}$/i.test(noteId)) throw notFound("That note");
    const n = await this.prisma.db.conversationNote.findFirst({ where: { id: noteId, workspaceId: w.id, conversationId: c.id } });
    if (!n) throw notFound("That note");
    if (n.authorId !== ctx.identity?.userId && !holds(ctx, "inbox.assign")) throw forbidden("Only the note's author or an inbox manager can delete it");
    await this.prisma.db.conversationNote.deleteMany({ where: { id: n.id, workspaceId: w.id } });
    return { ok: true };
  }

  /** A follow-up task linked to the conversation and its contact. */
  async createTask(ctx: RequestContext, id: string, input: ConversationTaskInputT) {
    const w = ws(ctx);
    if (!holds(ctx, "tasks.write")) throw forbidden("Your role cannot create tasks");
    const c = await this.find(ctx, id);
    const self = me(ctx).userId;
    const assigneeId = input.assigneeId === undefined ? self : input.assigneeId;
    if (assigneeId && assigneeId !== self) {
      if (!holds(ctx, "tasks.assign")) throw forbidden("Your role cannot assign tasks to other people");
      const member = await this.prisma.db.membership.findUnique({ where: { workspaceId_userId: { workspaceId: w.id, userId: assigneeId } } });
      if (!member) throw badRequest("Tasks can only be assigned to members of this workspace");
    }
    const title = input.title?.trim() || `Follow up with ${c.displayName || c.handle || "this conversation"}`;
    const task = await this.prisma.db.task.create({
      data: {
        workspaceId: w.id,
        type: input.type,
        title,
        description: input.description ?? "",
        priority: input.priority ?? "medium",
        dueAt: input.dueAt ?? null,
        assigneeId,
        createdById: self,
        contactId: c.contactId,
        dealId: c.dealId,
        conversationId: c.id,
        campaignId: c.campaignId,
        source: "manual",
      },
    });
    if (c.contactId) {
      await this.activity.log({ workspaceId: w.id, contactId: c.contactId, dealId: c.dealId, actorId: self, type: "task.created", summary: `Task: ${title}`, data: { taskId: task.id, conversationId: c.id } });
    }
    if (assigneeId && assigneeId !== self) {
      await this.notifications.notify(w.id, [assigneeId], { type: "task.assigned", title: `New task: ${title}`, link: `/w/${w.id}/tasks?task=${task.id}` });
    }
    return task;
  }
}
