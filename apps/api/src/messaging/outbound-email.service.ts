import { Inject, Injectable, Logger } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { APP_CONFIG, type AppConfig } from "../config/config.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { EntitlementsService } from "../billing/entitlements.service.js";
import { PlatformSettingsService } from "../core/platform-settings.service.js";
import { ActivityService } from "../crm/activity.service.js";
import { SuppressionService } from "../crm/suppression.service.js";
import { EventsService } from "../core/events.service.js";
import { MailboxAuthError, MailboxAuthService, MailboxAuthUnavailable } from "./mailbox-auth.service.js";
import { MailboxFaultService } from "./mailbox-faults.service.js";
import { sendSmtp, type SendFailure } from "./smtp.js";
import { escapeHtml, markdownToEmailHtml } from "./mail-html.js";
import { trackingBase, unsubscribeUrl, withTracking } from "./tracking.js";
import type { Mailbox } from "../generated/prisma/client.js";

export type SendEmailInput = {
  workspaceId: string;
  mailboxId: string;
  to: string;
  toName?: string;
  subject: string;
  /** Plain text with light markdown; rendered to an HTML part. */
  body: string;
  contactId?: string | null;
  conversationId?: string | null;
  campaignId?: string | null;
  enrollmentId?: string | null;
  templateId?: string | null;
  authorId?: string | null;
  /** The Message-ID this replies to; threads the message and its conversation. */
  inReplyTo?: string | null;
  references?: string | null;
  tracking?: { opens: boolean; clicks: boolean };
  /** Adds a visible unsubscribe link plus List-Unsubscribe / one-click headers. */
  unsubscribe?: boolean;
  /**
   * campaign: obeys the platform outreach kill switch and parks (deferred) when
   * the mailbox or plan allowance is exhausted. manual: a person pressing Send.
   */
  kind: "campaign" | "manual";
  /**
   * Write-ahead id. Pass the same id on a retry: a message already sent is
   * returned as sent, and one whose earlier attempt ended unconfirmed is
   * never sent again.
   */
  messageRowId?: string;
};

export type SendEmailResult =
  | { status: "sent"; messageRowId: string; providerMessageId: string; conversationId: string }
  | { status: "deferred"; reason: string; retryAt: Date | null; messageRowId?: string }
  /** failure.badAddress: the server refused the address (5.1.x); recorded as a bounce and suppressed. */
  | { status: "failed"; reason: string; messageRowId?: string; failure?: SendFailure }
  | { status: "uncertain"; reason: string; messageRowId: string }
  | { status: "blocked"; reason: string };

const startOfNextUtcDay = () => {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 5));
};

/*
 * The one path every email leaves through — campaign steps, inbox replies,
 * new conversations, test sends. Adapted from LinkDesk's
 * MessageDeliveryService and OutreachService.sendStep:
 *
 *   1. suppression re-checked at the moment of sending
 *   2. mailbox daily capacity reserved atomically (MailboxDailyCount)
 *   3. the plan's monthly email allowance consumed atomically
 *   4. the Message row written BEFORE talking to SMTP, with a deterministic
 *      Message-ID — so a crash mid-send leaves evidence, and a retry of the
 *      same messageRowId is never sent twice
 *   5. an SMTP outcome of "unknown" is recorded as uncertain, not retried
 *   6. a synchronous 5.1.x refusal of the address is recorded as a bounce
 *      (suppressed, contact marked bounced, message.bounced emitted), as an
 *      asynchronous bounce report would be
 *   7. mailbox faults go through MailboxFaultService, which tolerates a
 *      transient blip and tells admins when a mailbox stops working
 */
@Injectable()
export class OutboundEmailService {
  private readonly log = new Logger("outbound-email");

  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: MailboxAuthService,
    private readonly entitlements: EntitlementsService,
    private readonly platform: PlatformSettingsService,
    private readonly activity: ActivityService,
    private readonly suppression: SuppressionService,
    private readonly faults: MailboxFaultService,
    private readonly events: EventsService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** UTC day key for mailbox counters. */
  static day(d = new Date()) {
    return d.toISOString().slice(0, 10);
  }

  /** Reserves one send against the mailbox's daily limit. False when the limit is reached. */
  async reserveSlot(mailbox: Pick<Mailbox, "id" | "workspaceId" | "dailyLimit">, enforce: boolean): Promise<boolean> {
    const day = OutboundEmailService.day();
    const rows = await this.prisma.db.$queryRaw<{ count: number }[]>`
      INSERT INTO "MailboxDailyCount" ("id", "workspaceId", "mailboxId", "day", "count")
      VALUES (${randomUUID()}::uuid, ${mailbox.workspaceId}::uuid, ${mailbox.id}::uuid, ${day}, 1)
      ON CONFLICT ("mailboxId", "day") DO UPDATE SET "count" = "MailboxDailyCount"."count" + 1
      WHERE ${!enforce} OR "MailboxDailyCount"."count" < ${mailbox.dailyLimit}
      RETURNING "count"`;
    return rows.length > 0;
  }

  async releaseSlot(mailbox: Pick<Mailbox, "id" | "workspaceId">) {
    await this.prisma.db.mailboxDailyCount.updateMany({
      where: { workspaceId: mailbox.workspaceId, mailboxId: mailbox.id, day: OutboundEmailService.day(), count: { gt: 0 } },
      data: { count: { decrement: 1 } },
    });
  }

  /** Sends today per mailbox, for capacity displays and rotation. */
  async sentToday(workspaceId: string, mailboxIds: string[]) {
    const rows = await this.prisma.db.mailboxDailyCount.findMany({ where: { workspaceId, mailboxId: { in: mailboxIds }, day: OutboundEmailService.day() } });
    return new Map(rows.map((r) => [r.mailboxId, r.count]));
  }

  /** The connected mailbox among `allowed` with the most capacity left today (LinkDesk pickMailbox), or null. */
  async pickMailbox(workspaceId: string, allowed: string[]): Promise<Mailbox | null> {
    const boxes = await this.prisma.db.mailbox.findMany({
      where: { workspaceId, deletedAt: null, status: "connected", ...(allowed.length ? { id: { in: allowed } } : {}) },
    });
    if (!boxes.length) return null;
    const sent = await this.sentToday(workspaceId, boxes.map((b) => b.id));
    const usable = boxes.map((b) => ({ b, used: sent.get(b.id) ?? 0 })).filter((x) => x.used < x.b.dailyLimit);
    usable.sort((a, b) => a.used / a.b.dailyLimit - b.used / b.b.dailyLimit);
    return usable[0]?.b ?? null;
  }

  async send(input: SendEmailInput): Promise<SendEmailResult> {
    const { workspaceId } = input;
    const mailbox = await this.prisma.db.mailbox.findFirst({ where: { id: input.mailboxId, workspaceId, deletedAt: null } });
    if (!mailbox) return { status: "failed", reason: "That mailbox no longer exists." };
    if (mailbox.status !== "connected") {
      return { status: "deferred", reason: `The mailbox ${mailbox.email} is not connected${mailbox.lastError ? `: ${mailbox.lastError}` : ""}.`, retryAt: null };
    }
    const workspace = await this.prisma.db.workspace.findUniqueOrThrow({ where: { id: workspaceId } });
    if (workspace.status !== "active") return { status: "blocked", reason: "The workspace is suspended." };

    // Idempotency: a retried write-ahead id.
    if (input.messageRowId) {
      const prior = await this.prisma.db.message.findFirst({ where: { id: input.messageRowId, workspaceId } });
      if (prior?.status === "sent" || prior?.status === "delivered" || prior?.status === "read") {
        return { status: "sent", messageRowId: prior.id, providerMessageId: prior.providerMessageId ?? "", conversationId: prior.conversationId };
      }
      if (prior && (prior.status === "sending" || prior.status === "uncertain")) {
        await this.prisma.db.message.update({
          where: { id: prior.id, workspaceId },
          data: { status: "uncertain", error: "The mail server did not confirm this message. It may have been delivered, so it was not sent again." },
        });
        return { status: "uncertain", reason: "An earlier attempt may have been delivered; not sent again.", messageRowId: prior.id };
      }
      if (prior && prior.status === "failed") return { status: "failed", reason: prior.error || "Failed earlier", messageRowId: prior.id };
    }

    if (input.kind === "campaign") {
      const settings = await this.platform.get();
      if (!settings.outreachEnabled) return { status: "deferred", reason: "Outreach is paused on this installation.", retryAt: new Date(Date.now() + 15 * 60_000) };
      const ent = await this.entitlements.forAccount(workspace.billingAccountId);
      if (ent.access !== "full") return { status: "deferred", reason: ent.reason, retryAt: new Date(Date.now() + 60 * 60_000) };
    }

    const blocked = await this.suppression.check(workspaceId, { email: input.to });
    if (blocked) return { status: "blocked", reason: blocked };
    if (input.contactId) {
      const contact = await this.prisma.db.contact.findFirst({ where: { id: input.contactId, workspaceId }, select: { doNotContact: true, unsubscribedAt: true, deletedAt: true } });
      if (!contact || contact.deletedAt) return { status: "blocked", reason: "The contact no longer exists." };
      if (contact.doNotContact || contact.unsubscribedAt) return { status: "blocked", reason: "The contact has opted out." };
    }

    // Capacity: campaign sends park when the mailbox is full; a person's reply is counted but never refused for it.
    if (!(await this.reserveSlot(mailbox, input.kind === "campaign"))) {
      return { status: "deferred", reason: `${mailbox.email} has reached its daily limit of ${mailbox.dailyLimit}.`, retryAt: startOfNextUtcDay() };
    }
    if (!(await this.entitlements.consume(workspaceId, workspace.billingAccountId, "monthlyEmails", 1))) {
      await this.releaseSlot(mailbox);
      if (input.kind === "campaign") return { status: "deferred", reason: "This month's email allowance is used up.", retryAt: null };
      return { status: "failed", reason: "This month's email allowance on your plan is used up. Upgrade to send more." };
    }

    const messageRowId = input.messageRowId ?? randomUUID();
    const domain = mailbox.email.split("@")[1] || "growthdesk.local";
    const providerMessageId = `<${messageRowId}@${domain}>`;
    const { id: conversationId, created: newConversation } = await this.conversationFor(input, mailbox, providerMessageId);

    await this.prisma.db.message.upsert({
      where: { id: messageRowId, workspaceId },
      create: {
        id: messageRowId,
        workspaceId,
        conversationId,
        channel: "email",
        direction: "outbound",
        status: "sending",
        fromAddress: mailbox.email,
        toAddress: input.to,
        subject: input.subject,
        bodyText: input.body,
        providerMessageId,
        inReplyTo: input.inReplyTo ?? null,
        references: input.references ?? input.inReplyTo ?? null,
        authorId: input.authorId ?? null,
        enrollmentId: input.enrollmentId ?? null,
        campaignId: input.campaignId ?? null,
        mailboxId: mailbox.id,
        templateId: input.templateId ?? null,
        attempts: 1,
      },
      update: { status: "sending", attempts: { increment: 1 } },
    });

    const base = trackingBase(this.config.PUBLIC_APP_URL);
    const unsubscribe = input.unsubscribe ? unsubscribeUrl(base, messageRowId) : null;
    const signature = mailbox.signature.trim();
    const textBody = [input.body.trim(), signature ? `--\n${signature}` : "", unsubscribe ? `If you would rather not hear from me again, reply "unsubscribe" or visit: ${unsubscribe}` : ""].filter(Boolean).join("\n\n");
    let html = markdownToEmailHtml(input.body) + (signature ? `<div style="margin-top:14px;color:#52525b;font-size:13px;white-space:pre-line">${escapeHtml(signature)}</div>` : "");
    if (unsubscribe) html += `<p style="margin-top:22px;font-size:11px;color:#a1a1aa">Not interested? <a href="${unsubscribe}" style="color:#a1a1aa">Unsubscribe</a></p>`;
    html = withTracking(html, messageRowId, { open: input.tracking?.opens ?? false, click: input.tracking?.clicks ?? false }, base);

    let result;
    // Set when the credentials step has already recorded its own fault on the mailbox.
    let faultRecorded = false;
    try {
      const settings = await this.auth.smtpSettings(mailbox);
      result = await sendSmtp(settings, {
        from: mailbox.displayName ? `"${mailbox.displayName.replace(/"/g, "")}" <${mailbox.email}>` : mailbox.email,
        to: input.toName ? `"${input.toName.replace(/"/g, "")}" <${input.to}>` : input.to,
        subject: input.subject,
        text: textBody,
        html,
        messageId: providerMessageId,
        inReplyTo: input.inReplyTo ?? null,
        references: input.references ?? input.inReplyTo ?? null,
        headers: unsubscribe ? { "List-Unsubscribe": `<${unsubscribe}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } : undefined,
      });
    } catch (e) {
      // Credentials could not be produced (e.g. OAuth refresh failed): nothing was sent.
      // A refused or unreadable sign-in is final; the provider being unreachable is worth another try.
      const error = e instanceof Error ? e.message : String(e);
      faultRecorded = e instanceof MailboxAuthUnavailable;
      result = { sent: false as const, failure: { error, outcome: e instanceof MailboxAuthError ? ("rejected" as const) : ("deferred" as const), mailboxAtFault: true } };
    }

    if (result.sent) {
      const now = new Date();
      await this.prisma.db.$transaction(async (tx) => {
        await tx.message.update({ where: { id: messageRowId, workspaceId }, data: { status: "sent", sentAt: now, error: "" } });
        await tx.messageEvent.create({ data: { workspaceId, messageId: messageRowId, type: "sent", occurredAt: now } });
        await tx.conversation.update({ where: { id: conversationId, workspaceId }, data: { lastMessageAt: now, lastOutboundAt: now } });
        if (input.contactId) {
          await tx.contact.updateMany({ where: { id: input.contactId, workspaceId }, data: { lastContactedAt: now } });
          await tx.contact.updateMany({ where: { id: input.contactId, workspaceId, status: "new" }, data: { status: "contacted" } });
        }
        if (mailbox.status !== "connected" || mailbox.lastError || mailbox.sendFailures) {
          await tx.mailbox.update({ where: { id: mailbox.id, workspaceId }, data: { status: "connected", lastError: "", sendFailures: 0 } });
        }
      });
      if (input.contactId) {
        await this.activity.log({ workspaceId, contactId: input.contactId, actorId: input.authorId, type: "email.sent", summary: `Email sent: ${input.subject}`, data: { messageId: messageRowId, campaignId: input.campaignId, mailbox: mailbox.email } });
      }
      return { status: "sent", messageRowId, providerMessageId, conversationId };
    }

    const failure = result.failure;
    // sendSmtp has already retired a transport the failure broke; here only the mailbox's status is judged.
    if (failure.mailboxAtFault && !faultRecorded) await this.faults.failed(mailbox, failure.error, failure.outcome !== "rejected");
    if (failure.outcome === "unknown") {
      await this.prisma.db.message.update({ where: { id: messageRowId, workspaceId }, data: { status: "uncertain", error: `Unconfirmed: ${failure.error}`.slice(0, 1000) } });
      return { status: "uncertain", reason: failure.error, messageRowId };
    }
    // Nothing went out: give back the capacity and the allowance.
    await this.releaseSlot(mailbox);
    await this.prisma.db.usageCounter.updateMany({
      where: { workspaceId, metric: "emails", period: new Date().toISOString().slice(0, 7), value: { gt: 0 } },
      data: { value: { decrement: 1 } },
    });
    if (failure.outcome === "deferred") {
      // Delete the write-ahead row so the retry starts clean under the same id.
      await this.prisma.db.message.deleteMany({ where: { id: messageRowId, workspaceId, status: "sending" } });
      if (newConversation) await this.prisma.db.conversation.deleteMany({ where: { id: conversationId, workspaceId, messages: { none: {} } } });
      return { status: "deferred", reason: failure.error, retryAt: new Date(Date.now() + 10 * 60_000) };
    }
    if (failure.badAddress) {
      await this.recordBounce(input, mailbox, messageRowId, failure.error);
      return { status: "failed", reason: failure.error, messageRowId, failure };
    }
    await this.prisma.db.message.update({ where: { id: messageRowId, workspaceId }, data: { status: "failed", error: failure.error.slice(0, 1000) } });
    await this.prisma.db.messageEvent.create({ data: { workspaceId, messageId: messageRowId, type: "failed", data: { error: failure.error.slice(0, 500) } } });
    return { status: "failed", reason: failure.error, messageRowId, failure };
  }

  /**
   * A synchronous hard bounce: the server refused the address during the SMTP
   * conversation. Recorded as InboundEmailService records a bounce report:
   * the message bounced, the contact marked, the address suppressed, the
   * contact's other sequences stopped, message.bounced emitted, so the dead
   * address is never enrolled again. The sending enrollment itself is left to
   * the caller (the engine stops it), so the caller's own state stays consistent.
   */
  private async recordBounce(input: SendEmailInput, mailbox: Mailbox, messageRowId: string, diagnostic: string) {
    const { workspaceId } = input;
    const email = input.to.trim().toLowerCase();
    const status = diagnostic.match(/\b5\.1\.\d{1,3}\b/)?.[0] ?? "";
    const now = new Date();
    await this.prisma.db.$transaction(async (tx) => {
      const msg = await tx.message.update({
        where: { id: messageRowId, workspaceId },
        data: { status: "bounced", bouncedAt: now, error: `Bounced: ${diagnostic}`.slice(0, 1000) },
        select: { campaignId: true, enrollmentId: true },
      });
      await tx.messageEvent.create({
        data: { workspaceId, messageId: messageRowId, type: "bounced", occurredAt: now, data: { kind: "smtp", status, diagnostic: diagnostic.slice(0, 500), recipient: email } },
      });
      if (input.contactId) await tx.contact.updateMany({ where: { id: input.contactId, workspaceId, bouncedAt: null }, data: { bouncedAt: now } });
      await this.suppression.add(workspaceId, "email", email, "bounced", "bounce", null, tx);
      if (input.contactId) {
        await tx.enrollment.updateMany({
          where: { workspaceId, contactId: input.contactId, status: { in: ["active", "paused"] }, ...(input.enrollmentId ? { id: { not: input.enrollmentId } } : {}) },
          data: { status: "stopped", stopReason: "Bounced", nextRunAt: null },
        });
        await this.activity.log(
          {
            workspaceId,
            contactId: input.contactId,
            type: "email.bounced",
            summary: `Email to ${email} bounced${status ? ` (${status})` : ""}`,
            data: { messageId: messageRowId, campaignId: msg.campaignId, diagnostic, mailbox: mailbox.email },
          },
          tx,
        );
      }
      await this.events.emitIn(tx, {
        workspaceId,
        type: "message.bounced",
        subjectType: "message",
        subjectId: messageRowId,
        payload: { messageId: messageRowId, contactId: input.contactId ?? null, campaignId: msg.campaignId, enrollmentId: msg.enrollmentId, email, status, diagnostic, kind: "smtp" },
      });
    });
    await this.events.kick();
    this.log.log(`${mailbox.email}: ${email} refused at send time (${status || "5xx"}); recorded as a bounce`);
  }

  /**
   * The conversation an outbound email belongs to: the one given, else the
   * one holding the message it replies to, else a new conversation keyed by
   * this message's own Message-ID (the root of a new thread).
   */
  private async conversationFor(input: SendEmailInput, mailbox: Mailbox, providerMessageId: string): Promise<{ id: string; created: boolean }> {
    const { workspaceId } = input;
    if (input.conversationId) {
      const c = await this.prisma.db.conversation.findFirst({ where: { id: input.conversationId, workspaceId } });
      if (c) return { id: c.id, created: false };
    }
    if (input.inReplyTo) {
      const parent = await this.prisma.db.message.findFirst({ where: { workspaceId, channel: "email", providerMessageId: input.inReplyTo }, select: { conversationId: true } });
      if (parent) return { id: parent.conversationId, created: false };
    }
    const contact = input.contactId
      ? await this.prisma.db.contact.findFirst({ where: { id: input.contactId, workspaceId }, select: { fullName: true } })
      : null;
    const created = await this.prisma.db.conversation.create({
      data: {
        workspaceId,
        channel: "email",
        contactId: input.contactId ?? null,
        subject: input.subject.replace(/^\s*(re|fwd?)\s*:\s*/i, "").slice(0, 300),
        mailboxId: mailbox.id,
        externalKey: `${mailbox.id}:${providerMessageId}`,
        peer: input.to,
        handle: input.to,
        displayName: input.toName || contact?.fullName || input.to,
        campaignId: input.campaignId ?? null,
        assigneeId: input.authorId ?? null,
      },
    });
    return { id: created.id, created: true };
  }
}
