import { Injectable, Logger } from "@nestjs/common";
import { normalizeEmail, type UnsubscribeDetails, type UnsubscribeResult } from "@growthdesk/shared";
import { PrismaService, type Tx } from "../prisma/prisma.service.js";
import { SuppressionService } from "../crm/suppression.service.js";
import { ActivityService } from "../crm/activity.service.js";
import { EventsService } from "../core/events.service.js";
import { ApiError } from "../common/errors.js";
import { readTrackingToken } from "../messaging/tracking.js";
import {
  CLICK_DEDUPE_MS,
  OPEN_DEDUPE_MS,
  isAutomatedFetch,
  redirectTarget,
  unsubscribeSummary,
  type UnsubscribeVia,
} from "./tracking-rules.js";

/** Who fetched a tracking URL, as far as the request says. */
export type Fetcher = { method: string; userAgent: string };

const STOPPABLE = ["active", "paused"] as const;

const invalidLink = () => new ApiError(404, "not_found", "This link is incomplete or was changed after it was sent, so it cannot be used.");
const unknownMessage = () => new ApiError(404, "not_found", "This unsubscribe link no longer matches an email we sent. Reply to the email and ask to be removed instead.");

/*
 * Open pixels, click redirects and unsubscribes, reached from links inside
 * sent emails (messaging/tracking.ts signs them). Every endpoint is public:
 * the HMAC-signed token is the only credential, and it names one message.
 *
 * The token carries no workspace, so the message is found once with the
 * unscoped client (see messageFor); everything after that is re-scoped to the
 * message's workspace through the tenant-guarded client.
 *
 * Opens and clicks update the Message row (openedAt/openCount,
 * clickedAt/clickCount) and add a MessageEvent. Campaign counters and the
 * per-step stats read those Message columns, and sequence branches read
 * openedAt/clickedAt, so nothing else needs touching; the engine's periodic
 * refreshStats recounts the campaign columns.
 */
@Injectable()
export class TrackingService {
  private readonly log = new Logger("tracking");

  constructor(
    private readonly prisma: PrismaService,
    private readonly suppression: SuppressionService,
    private readonly activity: ActivityService,
    private readonly events: EventsService,
  ) {}

  /**
   * The outbound message a token names, with its workspace. Unscoped by
   * necessity: the signed message id is the only thing the request carries,
   * and it is what tells us the workspace.
   */
  private async messageFor(messageId: string) {
    return this.prisma.unscoped.message.findFirst({
      where: { id: messageId, direction: "outbound", channel: "email" },
      select: {
        id: true,
        workspaceId: true,
        conversationId: true,
        enrollmentId: true,
        campaignId: true,
        mailboxId: true,
        fromAddress: true,
        toAddress: true,
        subject: true,
        sentAt: true,
        openedAt: true,
        clickedAt: true,
      },
    });
  }

  /** Records a pixel load. Never throws: the pixel is served whatever happens here. */
  async recordOpen(token: string, who: Fetcher): Promise<void> {
    try {
      const t = readTrackingToken(token);
      if (t?.kind !== "open") return;
      const m = await this.messageFor(t.messageId);
      const now = new Date();
      if (!m || isAutomatedFetch({ ...who, sentAt: m.sentAt, now })) return;
      const { workspaceId } = m;
      const recent = await this.prisma.db.messageEvent.findFirst({
        where: { workspaceId, messageId: m.id, type: "opened", occurredAt: { gte: new Date(now.getTime() - OPEN_DEDUPE_MS) } },
        select: { id: true },
      });
      if (recent) return;
      await this.prisma.db.$transaction(async (tx) => {
        await tx.messageEvent.create({ data: { workspaceId, messageId: m.id, type: "opened", occurredAt: now, data: { userAgent: who.userAgent.slice(0, 300) } } });
        await tx.message.update({ where: { id: m.id, workspaceId }, data: { openCount: { increment: 1 } } });
        await tx.message.updateMany({ where: { id: m.id, workspaceId, openedAt: null }, data: { openedAt: now } });
      });
    } catch (e) {
      this.log.warn(`could not record an open: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /**
   * The URL a click token sends the browser to, after recording the click.
   * Only a URL inside a valid signature is ever returned — this is not an
   * open redirect. Recording failures never stop the redirect.
   */
  async click(token: string, who: Fetcher): Promise<string> {
    const t = readTrackingToken(token);
    const target = t?.kind === "click" ? redirectTarget(t.url) : null;
    if (!t || t.kind !== "click" || !target) throw invalidLink();
    try {
      await this.recordClick(t.messageId, target, who);
    } catch (e) {
      this.log.warn(`could not record a click: ${e instanceof Error ? e.message : String(e)}`);
    }
    return target;
  }

  private async recordClick(messageId: string, url: string, who: Fetcher) {
    const m = await this.messageFor(messageId);
    const now = new Date();
    if (!m || isAutomatedFetch({ ...who, sentAt: m.sentAt, now })) return;
    const { workspaceId } = m;
    const recent = await this.prisma.db.messageEvent.findFirst({
      where: { workspaceId, messageId: m.id, type: "clicked", occurredAt: { gte: new Date(now.getTime() - CLICK_DEDUPE_MS) }, data: { path: ["url"], equals: url } },
      select: { id: true },
    });
    if (recent) return;
    const contactId = await this.contactOf(this.prisma.db, workspaceId, m);
    await this.prisma.db.$transaction(async (tx) => {
      await tx.messageEvent.create({ data: { workspaceId, messageId: m.id, type: "clicked", occurredAt: now, data: { url: url.slice(0, 2000), userAgent: who.userAgent.slice(0, 300) } } });
      await tx.message.update({ where: { id: m.id, workspaceId }, data: { clickCount: { increment: 1 } } });
      const first = await tx.message.updateMany({ where: { id: m.id, workspaceId, clickedAt: null }, data: { clickedAt: now } });
      // The timeline gets the first click on an email; repeat clicks only count.
      if (first.count && contactId) {
        await this.activity.log(
          { workspaceId, contactId, type: "email.clicked", summary: `Clicked a link in "${m.subject}"`, data: { messageId: m.id, campaignId: m.campaignId, url: url.slice(0, 500) }, occurredAt: now },
          tx,
        );
      }
    });
  }

  // ─── Unsubscribe ───────────────────────────────────────────────────────────

  private async unsubscribeTarget(token: string) {
    const t = readTrackingToken(token);
    if (t?.kind !== "unsubscribe") throw invalidLink();
    const m = await this.messageFor(t.messageId);
    const email = normalizeEmail(m?.toAddress);
    if (!m || !email) throw unknownMessage();
    return { m, email };
  }

  /** What the unsubscribe page shows before the person confirms. Changes nothing. */
  async details(token: string): Promise<UnsubscribeDetails> {
    const { m, email } = await this.unsubscribeTarget(token);
    const { workspaceId } = m;
    const [workspace, mailbox, suppressed] = await Promise.all([
      this.prisma.db.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { name: true } }),
      m.mailboxId ? this.prisma.db.mailbox.findFirst({ where: { id: m.mailboxId, workspaceId }, select: { displayName: true } }) : null,
      this.suppression.check(workspaceId, { email }),
    ]);
    return { email, senderName: mailbox?.displayName ?? "", senderEmail: m.fromAddress, workspaceName: workspace.name, suppressed: suppressed !== null };
  }

  /**
   * Opts the email's recipient out of the workspace: suppression for the
   * address, contact.unsubscribedAt, the contact's running enrollments
   * stopped. The first time only: the campaign's unsubscribe count, a
   * MessageEvent, the timeline entry and `contact.unsubscribed` (outbox, in
   * the same transaction). Repeats — a second click, the provider retrying a
   * one-click POST — change nothing and still answer success.
   *
   * InboundEmailService.optOut does the same for "unsubscribe" replies; this
   * copy is keyed on the message's recipient instead of a reply's sender.
   */
  async unsubscribe(token: string, via: UnsubscribeVia): Promise<UnsubscribeResult> {
    const { m, email } = await this.unsubscribeTarget(token);
    const { workspaceId } = m;
    const workspace = await this.prisma.db.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { name: true } });
    const now = new Date();

    const changed = await this.prisma.db.$transaction(async (tx) => {
      // An outreach email's link opts out of outreach only (R3 in docs/PRODUCT_PLAN.md).
      const before = await tx.suppression.findFirst({ where: { workspaceId, kind: "email", value: email, scope: { in: SuppressionService.scopesFor("outreach") } }, select: { id: true } });
      await this.suppression.add(workspaceId, "email", email, "unsubscribed", via, null, tx, "outreach");
      const contactId = await this.contactOf(tx, workspaceId, m);
      let first = !before;
      if (contactId) {
        const moved = await tx.contact.updateMany({ where: { id: contactId, workspaceId, unsubscribedAt: null }, data: { unsubscribedAt: now } });
        first = moved.count > 0;
        await tx.enrollment.updateMany({
          where: { workspaceId, contactId, status: { in: [...STOPPABLE] } },
          data: { status: "stopped", stopReason: "Unsubscribed", nextRunAt: null },
        });
      }
      if (!first) return false;

      await tx.messageEvent.create({ data: { workspaceId, messageId: m.id, type: "unsubscribed", occurredAt: now, data: { via } } });
      if (m.campaignId && contactId) await tx.campaign.updateMany({ where: { id: m.campaignId, workspaceId }, data: { unsubscribeCount: { increment: 1 } } });
      if (contactId) {
        await this.activity.log({ workspaceId, contactId, type: "contact.unsubscribed", summary: unsubscribeSummary(via, email), data: { messageId: m.id, campaignId: m.campaignId, via }, occurredAt: now }, tx);
      }
      await this.events.emitIn(tx, {
        workspaceId,
        type: "contact.unsubscribed",
        subjectType: contactId ? "contact" : "email",
        subjectId: contactId ?? email,
        payload: { contactId, email, messageId: m.id, campaignId: m.campaignId, via },
      });
      return true;
    });

    if (changed) {
      await this.events.kick();
      this.log.log(`${email} unsubscribed from workspace ${workspaceId} (${via})`);
    }
    return { email, workspaceName: workspace.name, changed };
  }

  /**
   * The live contact an email was sent to: the enrollment's contact, else the
   * conversation's, following a merge to the surviving record; else the
   * contact holding the recipient address as an identifier.
   */
  private async contactOf(db: Tx, workspaceId: string, m: { enrollmentId: string | null; conversationId: string; toAddress: string }): Promise<string | null> {
    let id: string | null = null;
    if (m.enrollmentId) {
      id = (await db.enrollment.findFirst({ where: { id: m.enrollmentId, workspaceId }, select: { contactId: true } }))?.contactId ?? null;
    }
    id ??= (await db.conversation.findFirst({ where: { id: m.conversationId, workspaceId }, select: { contactId: true } }))?.contactId ?? null;
    if (!id) {
      const email = normalizeEmail(m.toAddress);
      if (email) id = (await db.contactIdentifier.findFirst({ where: { workspaceId, kind: "email", value: email }, select: { contactId: true } }))?.contactId ?? null;
    }
    if (!id) return null;
    let contact = await db.contact.findFirst({ where: { id, workspaceId }, select: { id: true, mergedIntoId: true } });
    if (contact?.mergedIntoId) contact = await db.contact.findFirst({ where: { id: contact.mergedIntoId, workspaceId }, select: { id: true, mergedIntoId: true } });
    return contact?.id ?? null;
  }
}
