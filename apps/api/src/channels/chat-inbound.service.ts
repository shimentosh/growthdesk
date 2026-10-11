import { Injectable, Logger } from "@nestjs/common";
import { PrismaService, type Tx } from "../prisma/prisma.service.js";
import { ContactsService } from "../crm/contacts.service.js";
import { SuppressionService } from "../crm/suppression.service.js";
import { ActivityService } from "../crm/activity.service.js";
import { EventsService } from "../core/events.service.js";
import { NotificationsService } from "../notifications/notifications.service.js";
import { Queues } from "../queues/queues.js";
import { isApiError } from "../common/errors.js";
import type { ChatChannel } from "./chat-sender.js";
import { OPT_OUT } from "./providers.js";

/*
 * A message arriving on WhatsApp or Telegram, filed against a conversation and
 * a contact. Ported in shape from LinkDesk's ChatInboundService (peer id =
 * identity + reply address, one lookup to find the thread, provider message id
 * for dedupe), without LinkDesk's vendor directory and stranger cap, and with
 * Growthdesk's sales side effects: campaign enrollments stop on reply, the
 * contact is marked replied, `reply.received` is emitted for workflows and
 * the AI classifier is asked to label the reply.
 *
 * Never throws on a payload it does not understand (callers are webhooks that
 * must answer 200, and a poller that must keep going); database failures do
 * propagate, so a webhook answers 500 and the provider redelivers — the
 * unique (workspaceId, channel, providerMessageId) makes redelivery harmless.
 */

export type InboundChat = {
  workspaceId: string;
  integrationId: string;
  channel: ChatChannel;
  /** What the provider wants back to reply: WhatsApp wa_id, Telegram chat id. */
  peer: string;
  /** What a person reads: "+4477…", "@handle". */
  handle: string;
  displayName: string;
  body: string;
  /** "wa:<wamid>" / "tg:<botId>:<chatId>:<message_id>". */
  providerMessageId: string;
  sentAt: Date;
  /** The identifier filed against the contact: WhatsApp → E.164 number, Telegram → chat id. */
  identifier: { kind: "whatsapp" | "telegram"; value: string };
  /** WhatsApp: the sender's number in E.164 (used for contact matching and opt-out suppression). */
  phone?: string | null;
  /** Our side: the WhatsApp display number or the bot's @username. */
  toAddress?: string;
  /**
   * Telegram /start: links the person to a contact (a specific one when the
   * deep-link payload was a valid signed contact token). Not counted as a reply.
   */
  start?: { contactId: string | null } | null;
};

export type FiledChat =
  | { outcome: "filed"; messageId: string; conversationId: string; contactId: string | null; optOut: boolean }
  | { outcome: "duplicate" }
  | { outcome: "empty" };

const isUnique = (e: unknown) => (e as { code?: string })?.code === "P2002";
const LABEL: Record<ChatChannel, string> = { whatsapp: "WhatsApp", telegram: "Telegram" };

@Injectable()
export class ChatInboundService {
  private readonly log = new Logger("chat-inbound");

  constructor(
    private readonly prisma: PrismaService,
    private readonly contacts: ContactsService,
    private readonly suppression: SuppressionService,
    private readonly activity: ActivityService,
    private readonly events: EventsService,
    private readonly notifications: NotificationsService,
    private readonly queues: Queues,
  ) {}

  async file(input: InboundChat): Promise<FiledChat> {
    const body = input.body.trim();
    const peer = input.peer.trim();
    if (!body || !peer) return { outcome: "empty" };
    const { workspaceId, channel } = input;
    const db = this.prisma.db;

    // Asked first so a replayed delivery writes nothing; the unique index is the real guarantee.
    const held = await db.message.findFirst({ where: { workspaceId, channel, providerMessageId: input.providerMessageId }, select: { id: true } });
    if (held) return { outcome: "duplicate" };

    const workspace = await db.workspace.findUnique({ where: { id: workspaceId }, select: { billingAccountId: true } });
    if (!workspace) return { outcome: "empty" };

    const externalKey = `${input.integrationId}:${peer}`;
    const existing = await db.conversation.findUnique({ where: { workspaceId_externalKey: { workspaceId, externalKey } } });
    const contactId = await this.resolveContact(input, existing?.contactId ?? null, workspace.billingAccountId);

    const isStart = Boolean(input.start);
    const optOut = !isStart && OPT_OUT.test(body);
    const sentAt = input.sentAt;
    const later = (a: Date | null | undefined, b: Date) => (a && a > b ? a : b);

    // Which campaign this answers: the conversation's own, else the contact's newest live enrollment.
    const enrollment = contactId
      ? await db.enrollment.findFirst({
          where: { workspaceId, contactId, status: { in: ["active", "paused"] } },
          orderBy: { enrolledAt: "desc" },
          select: { id: true, campaignId: true },
        })
      : null;
    const campaignId = existing?.campaignId ?? enrollment?.campaignId ?? null;

    const run = () =>
      db.$transaction(async (tx) => {
        const convo = await tx.conversation.upsert({
          where: { workspaceId_externalKey: { workspaceId, externalKey } },
          create: {
            workspaceId,
            channel,
            contactId,
            channelIntegrationId: input.integrationId,
            externalKey,
            peer,
            handle: input.handle,
            displayName: input.displayName || input.handle,
            subject: "",
            status: "open",
            unread: true,
            campaignId,
            lastMessageAt: sentAt,
            lastInboundAt: sentAt,
          },
          update: {
            unread: true,
            status: "open",
            snoozedUntil: null,
            lastMessageAt: later(existing?.lastMessageAt, sentAt),
            lastInboundAt: later(existing?.lastInboundAt, sentAt),
            ...(existing && !existing.contactId && contactId ? { contactId } : {}),
            ...(existing && !existing.campaignId && campaignId ? { campaignId } : {}),
            ...(input.handle ? { handle: input.handle } : {}),
            ...(existing && !existing.displayName && input.displayName ? { displayName: input.displayName } : {}),
          },
        });
        const message = await tx.message.create({
          data: {
            workspaceId,
            conversationId: convo.id,
            channel,
            direction: "inbound",
            status: "received",
            fromAddress: input.handle,
            toAddress: input.toAddress ?? "",
            bodyText: body.slice(0, 20_000),
            providerMessageId: input.providerMessageId,
            channelIntegrationId: input.integrationId,
            campaignId,
            enrollmentId: enrollment?.id ?? null,
            receivedAt: sentAt,
          },
        });
        const ctxIds = { conversationId: convo.id, messageId: message.id };

        if (isStart) {
          if (contactId) {
            await this.activity.log(
              { workspaceId, contactId, type: "telegram.started", summary: `Started a chat with the Telegram bot as ${input.handle}`, data: ctxIds },
              tx,
            );
          }
        } else if (optOut) {
          await this.optOut(tx, input, contactId, ctxIds);
        } else {
          await this.reply(tx, input, contactId, ctxIds, campaignId, body);
        }
        return { convo, message };
      });

    let filed: Awaited<ReturnType<typeof run>>;
    try {
      filed = await run();
    } catch (e) {
      if (!isUnique(e)) throw e;
      // Either the same message raced in twice (duplicate), or two first messages raced to create the conversation (retry once).
      const again = await db.message.findFirst({ where: { workspaceId, channel, providerMessageId: input.providerMessageId }, select: { id: true } });
      if (again) return { outcome: "duplicate" };
      filed = await run();
    }

    await this.events.kick();
    await this.prisma.db.channelIntegration.updateMany({ where: { id: input.integrationId, workspaceId }, data: { lastEventAt: new Date() } });

    if (!isStart && !optOut) {
      try {
        await this.queues.add("ai", "classify-reply", { workspaceId, messageId: filed.message.id }, { jobId: `classify-${filed.message.id}` });
      } catch (e) {
        this.log.warn(`could not queue reply classification: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    await this.notify(input, filed.convo, contactId, body, isStart, optOut);
    return { outcome: "filed", messageId: filed.message.id, conversationId: filed.convo.id, contactId, optOut };
  }

  /**
   * The contact this sender is: the conversation's own, a contact named by a
   * signed /start link, the owner of the channel identifier, (WhatsApp) the
   * owner of the phone number — or a new contact. A plan's contact limit does
   * not lose the message: it is filed without a contact.
   */
  private async resolveContact(input: InboundChat, conversationContactId: string | null, billingAccountId: string): Promise<string | null> {
    const { workspaceId } = input;
    const db = this.prisma.db;
    const live = async (id: string | null | undefined) =>
      id ? ((await db.contact.findFirst({ where: { id, workspaceId, deletedAt: null }, select: { id: true } }))?.id ?? null) : null;

    if (input.start?.contactId) {
      const linked = await live(input.start.contactId);
      if (linked) {
        await this.ensureIdentifier(workspaceId, linked, input.identifier.kind, input.identifier.value);
        return linked;
      }
    }
    const fromConversation = await live(conversationContactId);
    if (fromConversation) {
      await this.ensureIdentifier(workspaceId, fromConversation, input.identifier.kind, input.identifier.value);
      return fromConversation;
    }
    const ident = await db.contactIdentifier.findFirst({ where: { workspaceId, kind: input.identifier.kind, value: input.identifier.value }, select: { contactId: true } });
    const byIdent = await live(ident?.contactId);
    if (byIdent) return byIdent;
    if (input.phone) {
      const byPhone = await db.contactIdentifier.findFirst({ where: { workspaceId, kind: "phone", value: input.phone }, select: { contactId: true } });
      const found = await live(byPhone?.contactId);
      if (found) {
        await this.ensureIdentifier(workspaceId, found, input.identifier.kind, input.identifier.value);
        return found;
      }
    }
    try {
      const res = await this.contacts.upsert(
        workspaceId,
        billingAccountId,
        { fullName: input.displayName || input.handle, phone: input.phone ?? undefined },
        { source: input.channel, onDuplicate: "update", emitEvent: "contact.created", sourceData: { handle: input.handle, peer: input.peer } },
      );
      await this.ensureIdentifier(workspaceId, res.contactId, input.identifier.kind, input.identifier.value);
      return res.contactId;
    } catch (e) {
      if (isApiError(e) && e.status === 402) {
        this.log.warn(`${workspaceId}: contact limit reached — ${LABEL[input.channel]} message from ${input.handle} filed without a contact`);
        return null;
      }
      throw e;
    }
  }

  /** Adds the channel identifier to a contact unless another contact already holds it. */
  async ensureIdentifier(workspaceId: string, contactId: string, kind: "whatsapp" | "telegram" | "phone", value: string) {
    const db = this.prisma.db;
    const owner = await db.contactIdentifier.findFirst({ where: { workspaceId, kind, value } });
    if (owner) return owner.contactId === contactId;
    const hasKind = await db.contactIdentifier.count({ where: { workspaceId, contactId, kind } });
    try {
      await db.contactIdentifier.create({ data: { workspaceId, contactId, kind, value, isPrimary: hasKind === 0 } });
      return true;
    } catch (e) {
      if (isUnique(e)) return false;
      throw e;
    }
  }

  private async reply(tx: Tx, input: InboundChat, contactId: string | null, ids: { conversationId: string; messageId: string }, campaignId: string | null, body: string) {
    const { workspaceId, channel } = input;
    const now = new Date();
    const stoppedIn: string[] = [];
    if (contactId) {
      await tx.contact.updateMany({ where: { id: contactId, workspaceId }, data: { lastRepliedAt: input.sentAt } });
      await tx.contact.updateMany({ where: { id: contactId, workspaceId, status: { in: ["new", "contacted"] } }, data: { status: "replied" } });
      const live = await tx.enrollment.findMany({
        where: { workspaceId, contactId, status: { in: ["active", "paused"] } },
        include: { campaign: { select: { id: true, settings: true } } },
      });
      for (const e of live) {
        const stop = (e.campaign.settings as { stopOnReply?: boolean } | null)?.stopOnReply !== false;
        // The repliedAt guard makes a second reply (or a redelivery) count once.
        const first = await tx.enrollment.updateMany({
          where: { id: e.id, workspaceId, repliedAt: null },
          data: { repliedAt: now, ...(stop ? { status: "stopped", stopReason: "Replied", nextRunAt: null } : {}) },
        });
        if (first.count) await tx.campaign.updateMany({ where: { id: e.campaignId, workspaceId }, data: { replyCount: { increment: 1 } } });
        else if (stop) await tx.enrollment.updateMany({ where: { id: e.id, workspaceId, status: { in: ["active", "paused"] } }, data: { status: "stopped", stopReason: "Replied", nextRunAt: null } });
        if (stop) stoppedIn.push(e.campaignId);
      }
      await this.activity.log(
        { workspaceId, contactId, type: `${channel}.received`, summary: `${LABEL[channel]} message: ${body.slice(0, 120)}`, data: { ...ids, campaignId, stoppedCampaignIds: stoppedIn }, occurredAt: input.sentAt },
        tx,
      );
    }
    await this.events.emitIn(tx, {
      workspaceId,
      type: "reply.received",
      subjectType: contactId ? "contact" : "conversation",
      subjectId: contactId ?? ids.conversationId,
      payload: { ...ids, contactId, channel, campaignId, stoppedCampaignIds: stoppedIn, isAutoReply: false },
    });
  }

  private async optOut(tx: Tx, input: InboundChat, contactId: string | null, ids: { conversationId: string; messageId: string }) {
    const { workspaceId, channel } = input;
    const now = new Date();
    if (channel === "whatsapp" && input.phone) {
      await this.suppression.add(workspaceId, "phone", input.phone, "opted_out", "whatsapp", null, tx);
    }
    if (!contactId) return;
    await tx.contact.updateMany({ where: { id: contactId, workspaceId, unsubscribedAt: null }, data: { unsubscribedAt: now } });
    const live = await tx.enrollment.findMany({ where: { workspaceId, contactId, status: { in: ["active", "paused"] } }, select: { id: true, campaignId: true } });
    for (const e of live) {
      const res = await tx.enrollment.updateMany({
        where: { id: e.id, workspaceId, status: { in: ["active", "paused"] } },
        data: { status: "stopped", stopReason: "Unsubscribed", nextRunAt: null },
      });
      if (res.count) await tx.campaign.updateMany({ where: { id: e.campaignId, workspaceId }, data: { unsubscribeCount: { increment: 1 } } });
    }
    await this.activity.log({ workspaceId, contactId, type: "contact.unsubscribed", summary: `Opted out on ${LABEL[channel]}`, data: { ...ids, channel } }, tx);
    await this.events.emitIn(tx, {
      workspaceId,
      type: "contact.unsubscribed",
      subjectType: "contact",
      subjectId: contactId,
      payload: { ...ids, channel, via: "keyword", stoppedCampaignIds: live.map((e) => e.campaignId) },
    });
  }

  /** The bell: the conversation's assignee, else the contact's owner, else the workspace's owners and admins. */
  private async notify(
    input: InboundChat,
    convo: { id: string; assigneeId: string | null },
    contactId: string | null,
    body: string,
    isStart: boolean,
    optOut: boolean,
  ) {
    const { workspaceId, channel } = input;
    const who = input.displayName || input.handle;
    const n = {
      type: optOut ? "contact.unsubscribed" : "reply.received",
      title: isStart ? `${who} started a chat with your Telegram bot` : optOut ? `${who} opted out on ${LABEL[channel]}` : `${who} replied on ${LABEL[channel]}`,
      body: isStart || optOut ? "" : body.slice(0, 200),
      link: `/w/${workspaceId}/inbox?conversation=${convo.id}`,
    };
    let target = convo.assigneeId;
    if (!target && contactId) {
      target = (await this.prisma.db.contact.findFirst({ where: { id: contactId, workspaceId }, select: { ownerId: true } }))?.ownerId ?? null;
    }
    if (target) await this.notifications.notify(workspaceId, [target], n);
    else await this.notifications.notifyRoles(workspaceId, ["owner", "admin"], n);
  }
}
