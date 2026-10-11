import { Injectable, Logger } from "@nestjs/common";
import type { ParsedMail } from "mailparser";
import { normalizeEmail } from "@growthdesk/shared";
import { PrismaService, type Tx } from "../prisma/prisma.service.js";
import type { Mailbox, Prisma } from "../generated/prisma/client.js";
import { ContactsService } from "../crm/contacts.service.js";
import { SuppressionService } from "../crm/suppression.service.js";
import { ActivityService } from "../crm/activity.service.js";
import { EventsService } from "../core/events.service.js";
import { NotificationsService } from "../notifications/notifications.service.js";
import { Queues } from "../queues/queues.js";
import { isApiError } from "../common/errors.js";
import {
  addressList,
  addressOf,
  answersTo,
  asksToUnsubscribe,
  bodyTextOf,
  bracketed,
  detectBounce,
  isAutoReply,
  machineMailReason,
  referencesOf,
  replyTextOf,
  sanitizeInboundHtml,
  stripSubjectPrefix,
  type BounceReport,
} from "./inbound-parse.js";

export type IngestResult =
  | { outcome: "filed"; messageId: string; conversationId: string; contactId: string | null; reply: boolean; autoReply: boolean }
  | { outcome: "duplicate"; messageId: string }
  | { outcome: "bounced"; originalMessageId: string; email: string | null }
  /** A delivery report that is not a bounce (delayed / 4.x.x) or an already-recorded bounce. */
  | { outcome: "bounce_ignored"; reason: string }
  /** A delivery failure we cannot tie to a message we sent — nothing is marked. */
  | { outcome: "bounce_unmatched" }
  | { outcome: "skipped"; reason: string };

/** The IMAP folder a message was read from. */
export type InboundFolder = "inbox" | "junk";

type CampaignSettings = { stopOnReply?: boolean; stopOnAutoReply?: boolean };
const settingsOf = (value: Prisma.JsonValue | null | undefined): CampaignSettings =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as CampaignSettings) : {};

const STOPPABLE = ["active", "paused"] as const;

type ReplyPlan = NonNullable<Awaited<ReturnType<InboundEmailService["planReply"]>>>;
type ReplyInput = {
  messageId: string;
  conversation: { id: string; assigneeId: string | null };
  receivedAt: Date;
  sender: string;
  name: string;
  subject: string;
  bodyText: string;
};

const firstId = (raw: string | undefined): string | null => bracketed(String(raw ?? "").split(/[\s,]+/).find((s) => s.trim()) ?? null);
const bare = (id: string | null | undefined) => (id ?? "").trim().replace(/^<|>$/g, "");

/*
 * One inbound email, filed. Adapted from LinkDesk InboundMailService.ingest:
 *
 *   - deduplicated per workspace on the Message-ID (synthesised from the IMAP
 *     uid when a message has none), so re-reading a mailbox never files twice;
 *   - delivery reports are judged as bounces (real DSN parsing) and never
 *     filed as conversation messages;
 *   - threaded by In-Reply-To/References onto our own messages, else onto the
 *     sender's open conversation in this mailbox, else a new conversation;
 *   - a reply stops the enrollment it answers (and the contact's other
 *     enrollments whose campaigns stop on reply), counts once per enrollment,
 *     raises a review task and a notification, and emits `reply.received`.
 *
 * Changes from LinkDesk: a contact is created (through ContactsService.upsert,
 * as the CRM's single entry point) only for mail in a thread we started;
 * machine mail (newsletters, lists, notifications, no-reply senders) outside
 * our threads is not filed at all, and a stranger's mail outside them is
 * filed without a contact and counts as no reply. An opt-out is read only in
 * what the sender wrote, never in the quoted email. A bounce is only recorded
 * against an original message we can name. The message and its reply effects
 * commit in one transaction, with the event in it (outbox), so a failed pass
 * retried by the sync files the reply whole instead of as a "duplicate".
 */
@Injectable()
export class InboundEmailService {
  private readonly log = new Logger("inbound-email");

  constructor(
    private readonly prisma: PrismaService,
    private readonly contacts: ContactsService,
    private readonly suppression: SuppressionService,
    private readonly activity: ActivityService,
    private readonly events: EventsService,
    private readonly notifications: NotificationsService,
    private readonly queues: Queues,
  ) {}

  /**
   * `folder` is where the sync found it. Junk is read only to rescue replies
   * a spam filter caught, so from there nothing but mail answering a message
   * we sent (or a bounce of one) is filed.
   */
  async ingest(mailbox: Mailbox, mail: ParsedMail, uid: number, folder: InboundFolder = "inbox"): Promise<IngestResult> {
    const workspaceId = mailbox.workspaceId;
    const db = this.prisma.db;
    const from = addressOf(mail);
    const sender = normalizeEmail(from.email);
    if (!sender) return { outcome: "skipped", reason: "no sender address" };
    // Our own sends copied back into INBOX (some servers do) are not inbound mail.
    if (sender === mailbox.email.toLowerCase()) return { outcome: "skipped", reason: "sent from this mailbox" };

    const synthetic = `${uid}.${mailbox.imapUidValidity ?? "0"}.${mailbox.id}${folder === "junk" ? ".junk" : ""}@imap.local`;
    const providerMessageId = bracketed(mail.messageId) ?? `<${synthetic}>`;
    const held = await db.message.findFirst({ where: { workspaceId, channel: "email", providerMessageId }, select: { id: true } });
    if (held) return { outcome: "duplicate", messageId: held.id };

    const bounce = detectBounce(mail, sender);
    if (bounce) return this.handleBounce(mailbox, mail, bounce);

    return this.file(mailbox, mail, sender, from.name, providerMessageId, folder);
  }

  // ─── Bounces ─────────────────────────────────────────────────────────────────

  private async handleBounce(mailbox: Mailbox, mail: ParsedMail, bounce: BounceReport): Promise<IngestResult> {
    const workspaceId = mailbox.workspaceId;
    if (bounce.verdict === "soft") return { outcome: "bounce_ignored", reason: "delayed delivery (not a bounce)" };
    if (!bounce.referencedIds.length) return { outcome: "bounce_unmatched" };
    const ids = [...new Set(bounce.referencedIds.flatMap((id) => [id, bare(id)]))];
    const original = await this.prisma.db.message.findFirst({
      where: { workspaceId, channel: "email", direction: "outbound", providerMessageId: { in: ids } },
      orderBy: { createdAt: "desc" },
      include: { conversation: { select: { contactId: true } } },
    });
    // Never guess the failed address from the body: no message of ours, nothing marked.
    if (!original) return { outcome: "bounce_unmatched" };

    const email = normalizeEmail(original.toAddress.split(",")[0] ?? "");
    const failed = bounce.recipients.find((r) => r.action === "failed" || r.status.startsWith("5."));
    const status = failed?.status ?? "";
    const diagnostic = bounce.diagnostic || failed?.diagnostic || stripSubjectPrefix(mail.subject ?? "") || "Delivery failed";
    const now = new Date();

    const outcome = await this.prisma.db.$transaction(async (tx) => {
      const moved = await tx.message.updateMany({
        where: { id: original.id, workspaceId, status: { not: "bounced" } },
        data: { status: "bounced", bouncedAt: now, error: `Bounced: ${diagnostic}`.slice(0, 1000) },
      });
      if (!moved.count) return null; // already recorded — a re-read report changes nothing
      await tx.messageEvent.create({
        data: { workspaceId, messageId: original.id, type: "bounced", occurredAt: now, data: { kind: bounce.kind, status, diagnostic, recipient: failed?.recipient ?? email, report: bracketed(mail.messageId) } },
      });
      const contactId = (email ? await this.contactIdFor(tx, workspaceId, email) : null) ?? original.conversation.contactId ?? null;
      if (contactId) await tx.contact.updateMany({ where: { id: contactId, workspaceId, bouncedAt: null }, data: { bouncedAt: now } });
      if (email) await this.suppression.add(workspaceId, "email", email, "bounced", "bounce", null, tx);
      const which: Prisma.EnrollmentWhereInput[] = [];
      if (contactId) which.push({ contactId });
      if (original.enrollmentId) which.push({ id: original.enrollmentId });
      if (which.length) {
        await tx.enrollment.updateMany({
          where: { workspaceId, status: { in: [...STOPPABLE] }, OR: which },
          data: { status: "stopped", stopReason: "Bounced", nextRunAt: null },
        });
      }
      if (original.campaignId) {
        await tx.campaign.updateMany({ where: { id: original.campaignId, workspaceId }, data: { bounceCount: { increment: 1 } } });
      }
      if (contactId) {
        await this.activity.log(
          { workspaceId, contactId, type: "email.bounced", summary: `Email to ${email ?? original.toAddress} bounced${status ? ` (${status})` : ""}`, data: { messageId: original.id, campaignId: original.campaignId, diagnostic } },
          tx,
        );
      }
      await this.events.emitIn(tx, {
        workspaceId,
        type: "message.bounced",
        subjectType: "message",
        subjectId: original.id,
        payload: { messageId: original.id, contactId, campaignId: original.campaignId, enrollmentId: original.enrollmentId, email, status, diagnostic, kind: bounce.kind },
      });
      return { contactId };
    });
    if (!outcome) return { outcome: "bounce_ignored", reason: "bounce already recorded" };
    await this.events.kick();
    this.log.log(`${mailbox.email}: hard bounce for message ${original.id} (${email ?? "unknown address"})`);
    return { outcome: "bounced", originalMessageId: original.id, email };
  }

  // ─── Replies and new mail ────────────────────────────────────────────────────

  private async file(mailbox: Mailbox, mail: ParsedMail, sender: string, senderName: string, providerMessageId: string, folder: InboundFolder): Promise<IngestResult> {
    const workspaceId = mailbox.workspaceId;
    const db = this.prisma.db;
    const now = new Date();
    const date = mail.date && !Number.isNaN(mail.date.getTime()) ? mail.date : null;
    const receivedAt = date && date.getTime() <= now.getTime() + 5 * 60_000 ? date : now;
    const subject = (mail.subject ?? "").slice(0, 500);
    const bodyText = bodyTextOf(mail);
    const name = senderName && !senderName.includes("@") ? senderName.slice(0, 200) : "";

    // 1. What it answers: our own messages, matched on In-Reply-To / References.
    const ids = answersTo(mail);
    const related = ids.length
      ? await db.message.findMany({
          where: { workspaceId, channel: "email", providerMessageId: { in: ids } },
          select: { id: true, conversationId: true, direction: true, enrollmentId: true, campaignId: true, providerMessageId: true },
          orderBy: { createdAt: "desc" },
          take: 25,
        })
      : [];
    const parentId = bare(firstId(mail.inReplyTo));
    const isParent = (m: { providerMessageId: string | null }) => Boolean(parentId) && bare(m.providerMessageId) === parentId;
    const parent = related.find(isParent) ?? related[0] ?? null;
    const outbound = related.find((m) => m.direction === "outbound" && isParent(m)) ?? related.find((m) => m.direction === "outbound") ?? null;

    // 2. The conversation it belongs to, if there is one already.
    let found = parent ? await db.conversation.findFirst({ where: { id: parent.conversationId, workspaceId } }) : null;
    found ??= await db.conversation.findFirst({
      where: { workspaceId, channel: "email", mailboxId: mailbox.id, status: "open", peer: { equals: sender, mode: "insensitive" } },
      orderBy: [{ lastMessageAt: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }],
    });

    // 3. Whether it belongs to a thread we started: it answers a message we
    // sent, or lands in a conversation where we have written. Machine mail and
    // anything from Junk is filed only then. A stranger's mail outside our
    // threads is filed, but makes no contact and counts as no reply.
    const wroteThere = found ? await db.message.findFirst({ where: { workspaceId, conversationId: found.id, direction: "outbound" }, select: { id: true } }) : null;
    const ours = Boolean(outbound || wroteThere);
    const machine = machineMailReason(mail, sender);
    if (!ours && folder === "junk") return { outcome: "skipped", reason: "junk mail outside our threads" };
    if (!ours && machine) return { outcome: "skipped", reason: `machine mail (${machine})` };
    // Machine mail in our thread (a helpdesk acknowledgement, a list echo) is not a person answering.
    const autoReply = isAutoReply(mail) || Boolean(machine);

    // 4. Who sent it: the contact holding that address, or (in our threads only) a new one.
    const contact = await this.contactFor(mailbox, sender, name, ours);

    if (!found) {
      const root = referencesOf(mail)[0] ?? providerMessageId;
      // Upsert on the unique key: two passes racing on one thread end up in one conversation.
      found = await db.conversation.upsert({
        where: { workspaceId_externalKey: { workspaceId, externalKey: `${mailbox.id}:${root}` } },
        create: {
          workspaceId,
          channel: "email",
          contactId: contact?.id ?? null,
          subject: stripSubjectPrefix(subject).slice(0, 300),
          mailboxId: mailbox.id,
          externalKey: `${mailbox.id}:${root}`,
          peer: sender,
          handle: sender,
          displayName: name || contact?.fullName || sender,
          campaignId: outbound?.campaignId ?? null,
        },
        update: {},
      });
    }
    const conversation = found;

    // 5. What a reply sets in motion, read before anything is written so the
    // message and its effects commit together: a pass that fails half-way
    // leaves nothing behind, and the retry files the whole reply.
    const contactId = contact?.id ?? conversation.contactId ?? null;
    const plan = await this.planReply({
      mailbox,
      contactId,
      outbound,
      autoReply,
      // A known contact writing afresh is answering us too; a stranger outside our threads is not.
      countsAsReply: ours || Boolean(contact),
      unsubscribe: !autoReply && asksToUnsubscribe(replyTextOf(mail)),
    });

    // 6. The message, the conversation it lands in, and the reply's effects, in one transaction.
    const campaignId = outbound?.campaignId ?? conversation.campaignId ?? null;
    const lastMessageAt = conversation.lastMessageAt && conversation.lastMessageAt > receivedAt ? conversation.lastMessageAt : receivedAt;
    const lastInboundAt = conversation.lastInboundAt && conversation.lastInboundAt > receivedAt ? conversation.lastInboundAt : receivedAt;
    const reply = { conversation: { id: conversation.id, assigneeId: conversation.assigneeId }, receivedAt, sender, name: name || contact?.fullName || sender, subject, bodyText };
    let message;
    let unsubscribed = false;
    try {
      message = await db.$transaction(async (tx) => {
        const row = await tx.message.create({
          data: {
            workspaceId,
            conversationId: conversation.id,
            channel: "email",
            direction: "inbound",
            status: "received",
            fromAddress: sender,
            toAddress: addressList(mail.to),
            cc: addressList(mail.cc),
            subject,
            bodyText,
            bodyHtml: sanitizeInboundHtml(mail.html),
            providerMessageId,
            inReplyTo: firstId(mail.inReplyTo),
            references: referencesOf(mail).join(" ").slice(0, 8000) || null,
            isAutoReply: autoReply,
            enrollmentId: outbound?.enrollmentId ?? null,
            campaignId,
            mailboxId: mailbox.id,
            receivedAt,
          },
        });
        await tx.conversation.update({
          where: { id: conversation.id, workspaceId },
          data: {
            unread: true,
            status: "open",
            snoozedUntil: null,
            lastInboundAt,
            lastMessageAt,
            ...(!conversation.contactId && contact ? { contactId: contact.id } : {}),
            ...(!conversation.campaignId && campaignId ? { campaignId } : {}),
          },
        });
        if (contact) {
          await this.activity.log(
            { workspaceId, contactId: contact.id, type: "email.received", summary: `Email received: ${subject || "(no subject)"}`, occurredAt: receivedAt, data: { messageId: row.id, conversationId: conversation.id, campaignId, mailbox: mailbox.email, isAutoReply: autoReply } },
            tx,
          );
        }
        if (plan) unsubscribed = await this.applyReply(tx, plan, { ...reply, messageId: row.id });
        return row;
      });
    } catch (e) {
      // Another pass filed the same Message-ID first.
      if ((e as { code?: string }).code === "P2002") {
        const again = await db.message.findFirst({ where: { workspaceId, channel: "email", providerMessageId }, select: { id: true } });
        if (again) return { outcome: "duplicate", messageId: again.id };
      }
      throw e;
    }

    // 7. After commit: notifications and classification. The reply is already
    // recorded, so a failure here is logged rather than failing the message.
    if (plan) {
      await this.events.kick();
      if (unsubscribed) this.log.log(`${mailbox.email}: ${sender} asked to unsubscribe by reply`);
      if (plan.isReply) await this.afterReply(plan, { ...reply, messageId: message.id });
    }

    return { outcome: "filed", messageId: message.id, conversationId: conversation.id, contactId, reply: Boolean(plan?.isReply), autoReply };
  }

  /**
   * Reads what a reply would change: the enrollment it answers, the contact's
   * other running enrollments, and whether it counts at all. Null when it
   * changes nothing (an out-of-office the campaign ignores, a stranger's mail).
   */
  private async planReply(input: {
    mailbox: Mailbox;
    contactId: string | null;
    outbound: { enrollmentId: string | null; campaignId: string | null } | null;
    autoReply: boolean;
    countsAsReply: boolean;
    unsubscribe: boolean;
  }) {
    const { mailbox, contactId, autoReply } = input;
    const workspaceId = mailbox.workspaceId;
    const db = this.prisma.db;
    const campaignSelect = { select: { id: true, settings: true, ownerId: true, createdById: true } } as const;

    const direct = input.outbound?.enrollmentId
      ? await db.enrollment.findFirst({ where: { id: input.outbound.enrollmentId, workspaceId }, include: { campaign: campaignSelect } })
      : null;
    const directCampaign = direct?.campaign ?? (input.outbound?.campaignId ? await db.campaign.findFirst({ where: { id: input.outbound.campaignId, workspaceId }, ...campaignSelect }) : null);

    // An out-of-office is not an answer unless the campaign it answers says it is.
    const isReply = input.countsAsReply && (autoReply ? settingsOf(directCampaign?.settings).stopOnAutoReply === true : true);
    if (!isReply && !input.unsubscribe) return null;

    const others = contactId
      ? await db.enrollment.findMany({
          where: { workspaceId, contactId, status: { in: [...STOPPABLE] }, ...(direct ? { id: { not: direct.id } } : {}) },
          include: { campaign: campaignSelect },
        })
      : [];
    const contact = contactId ? await db.contact.findFirst({ where: { id: contactId, workspaceId }, select: { id: true, ownerId: true } }) : null;
    return { mailbox, contactId, autoReply, isReply, unsubscribe: input.unsubscribe, direct, directCampaign, others, contact };
  }

  /** Writes a planned reply's effects inside the message's transaction. True when it recorded a first opt-out. */
  private async applyReply(tx: Tx, plan: ReplyPlan, input: ReplyInput): Promise<boolean> {
    const { mailbox, contactId, autoReply, direct, directCampaign, contact } = plan;
    const { receivedAt } = input;
    const workspaceId = mailbox.workspaceId;

    // A written opt-out first, so the enrollments it stops say why.
    const unsubscribed = plan.unsubscribe ? await this.optOut(tx, workspaceId, input.sender, contactId, directCampaign?.id ?? null, input.messageId, "reply") : false;
    if (!plan.isReply) return unsubscribed;

    const touch = async (enrollment: { id: string; campaignId: string }, stop: boolean) => {
      const first = await tx.enrollment.updateMany({ where: { id: enrollment.id, workspaceId, repliedAt: null }, data: { repliedAt: receivedAt } });
      if (first.count) await tx.campaign.updateMany({ where: { id: enrollment.campaignId, workspaceId }, data: { replyCount: { increment: 1 } } });
      if (stop) {
        await tx.enrollment.updateMany({
          where: { id: enrollment.id, workspaceId, status: { in: [...STOPPABLE] } },
          data: { status: "stopped", stopReason: "Replied", nextRunAt: null },
        });
      }
    };
    if (direct) await touch(direct, settingsOf(direct.campaign.settings).stopOnReply !== false);
    for (const e of plan.others) {
      const s = settingsOf(e.campaign.settings);
      if (s.stopOnReply === false) continue;
      if (autoReply && s.stopOnAutoReply !== true) continue;
      await touch(e, true);
    }

    if (contactId) {
      await tx.contact.updateMany({ where: { id: contactId, workspaceId, OR: [{ lastRepliedAt: null }, { lastRepliedAt: { lt: receivedAt } }] }, data: { lastRepliedAt: receivedAt } });
      await tx.contact.updateMany({ where: { id: contactId, workspaceId, status: { in: ["new", "contacted"] } }, data: { status: "replied" } });
    }

    const assignee = input.conversation.assigneeId ?? contact?.ownerId ?? directCampaign?.ownerId ?? directCampaign?.createdById ?? mailbox.createdById ?? null;
    const open = await tx.task.findFirst({ where: { workspaceId, conversationId: input.conversation.id, type: "review_reply", status: "open" }, select: { id: true } });
    if (!open) {
      await tx.task.create({
        data: {
          workspaceId,
          type: "review_reply",
          title: `Review reply from ${input.name}`.slice(0, 300),
          description: input.subject ? `Re: ${stripSubjectPrefix(input.subject)}`.slice(0, 1000) : "",
          priority: "high",
          dueAt: new Date(receivedAt.getTime() + 24 * 3600_000),
          assigneeId: assignee,
          contactId,
          conversationId: input.conversation.id,
          campaignId: directCampaign?.id ?? null,
          enrollmentId: direct?.id ?? null,
          source: "system",
        },
      });
    }

    await this.events.emitIn(tx, {
      workspaceId,
      type: "reply.received",
      subjectType: "conversation",
      subjectId: input.conversation.id,
      payload: { conversationId: input.conversation.id, messageId: input.messageId, contactId, campaignId: directCampaign?.id ?? null, isAutoReply: autoReply },
    });
    return unsubscribed;
  }

  /** Tells the people who own the conversation and queues the AI classification. Best effort. */
  private async afterReply(plan: ReplyPlan, input: ReplyInput): Promise<void> {
    const { mailbox, contact, directCampaign } = plan;
    const workspaceId = mailbox.workspaceId;
    const recipients = [input.conversation.assigneeId, contact?.ownerId].filter((u): u is string => Boolean(u));
    if (!recipients.length) {
      const fallback = directCampaign?.ownerId ?? directCampaign?.createdById ?? mailbox.createdById;
      if (fallback) recipients.push(fallback);
    }
    try {
      await this.notifications.notify(workspaceId, recipients, {
        type: "reply.received",
        title: `${input.name} replied`,
        body: [input.subject, input.bodyText.slice(0, 280)].filter(Boolean).join("\n\n"),
        link: `/w/${workspaceId}/inbox/${input.conversation.id}`,
        email: true,
      });
    } catch (e) {
      this.log.warn(`could not notify about reply ${input.messageId}: ${e instanceof Error ? e.message : String(e)}`);
    }

    try {
      // BullMQ refuses custom ids containing ":", hence the dash.
      await this.queues.add("ai", "classify-reply", { workspaceId, messageId: input.messageId }, { jobId: `classify-${input.messageId}` });
    } catch (e) {
      this.log.warn(`could not queue reply classification for ${input.messageId}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /**
   * Records an opt-out for an address: suppression, contact.unsubscribedAt,
   * the contact's running enrollments stopped. Returns true the first time
   * (the contact was not unsubscribed before). Shared by the reply path; the
   * tracking module has its own copy keyed on the message's recipient.
   */
  private async optOut(tx: Tx, workspaceId: string, email: string, contactId: string | null, campaignId: string | null, messageId: string, via: string): Promise<boolean> {
    // A reply asking to stop answers an outreach email, so it opts out of outreach only.
    await this.suppression.add(workspaceId, "email", email, "unsubscribed", via, null, tx, "outreach");
    let first = !contactId;
    if (contactId) {
      const moved = await tx.contact.updateMany({ where: { id: contactId, workspaceId, unsubscribedAt: null }, data: { unsubscribedAt: new Date() } });
      first = moved.count > 0;
      await tx.enrollment.updateMany({
        where: { workspaceId, contactId, status: { in: [...STOPPABLE] } },
        data: { status: "stopped", stopReason: "Unsubscribed", nextRunAt: null },
      });
    }
    if (!first) return false;
    if (campaignId && contactId) await tx.campaign.updateMany({ where: { id: campaignId, workspaceId }, data: { unsubscribeCount: { increment: 1 } } });
    if (contactId) {
      await this.activity.log({ workspaceId, contactId, type: "contact.unsubscribed", summary: `Unsubscribed by replying (${email})`, data: { messageId, via } }, tx);
    }
    await this.events.emitIn(tx, {
      workspaceId,
      type: "contact.unsubscribed",
      subjectType: contactId ? "contact" : "email",
      subjectId: contactId ?? email,
      payload: { contactId, email, messageId, campaignId, via },
    });
    return true;
  }

  // ─── Contacts ────────────────────────────────────────────────────────────────

  /** The live contact holding an email identifier (following merges), or null. */
  private async contactIdFor(db: Tx, workspaceId: string, email: string): Promise<string | null> {
    const ident = await db.contactIdentifier.findFirst({ where: { workspaceId, kind: "email", value: email }, select: { contactId: true } });
    if (!ident) return null;
    let contact = await db.contact.findFirst({ where: { id: ident.contactId, workspaceId }, select: { id: true, mergedIntoId: true, deletedAt: true } });
    if (contact?.mergedIntoId) {
      contact = await db.contact.findFirst({ where: { id: contact.mergedIntoId, workspaceId }, select: { id: true, mergedIntoId: true, deletedAt: true } });
    }
    return contact && !contact.deletedAt ? contact.id : null;
  }

  /**
   * The sender's contact: found by email identifier, else — when `create`,
   * i.e. the mail is in a thread we started — created through
   * ContactsService.upsert (source "inbound"). A plan's contact limit leaves
   * the conversation without a contact rather than losing the mail.
   */
  private async contactFor(mailbox: Mailbox, sender: string, name: string, create: boolean): Promise<{ id: string; fullName: string } | null> {
    const workspaceId = mailbox.workspaceId;
    const db = this.prisma.db;
    const known = await db.contactIdentifier.findFirst({ where: { workspaceId, kind: "email", value: sender }, select: { contactId: true } });
    let contactId: string | null = null;
    if (known) {
      // The address belongs to a contact; a deleted one is not resurrected by mail.
      contactId = await this.contactIdFor(db, workspaceId, sender);
    } else if (create) {
      const workspace = await db.workspace.findUnique({ where: { id: workspaceId }, select: { billingAccountId: true } });
      if (!workspace) return null;
      try {
        const result = await this.contacts.upsert(
          workspaceId,
          workspace.billingAccountId,
          { email: sender, ...(name ? { fullName: name } : {}) },
          { source: "inbound", onDuplicate: "update", sourceData: { mailbox: mailbox.email } },
        );
        contactId = result.contactId;
        if (result.created) await this.events.kick();
      } catch (e) {
        if (isApiError(e) && e.status === 402) {
          this.log.warn(`${mailbox.email}: contact limit reached — mail from ${sender} filed without a contact`);
        } else {
          this.log.warn(`${mailbox.email}: could not create a contact for ${sender}: ${e instanceof Error ? e.message : String(e)}`);
        }
        return null;
      }
    }
    if (!contactId) return null;
    return db.contact.findFirst({ where: { id: contactId, workspaceId }, select: { id: true, fullName: true } });
  }
}
