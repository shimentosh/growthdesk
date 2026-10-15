import { Inject, Injectable, Logger } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { ConfirmSubscriptionDetails } from "@growthdesk/shared";
import { PrismaService } from "../prisma/prisma.service.js";
import { APP_CONFIG, type AppConfig } from "../config/config.js";
import { EntitlementsService } from "../billing/entitlements.service.js";
import { ConsentService } from "../crm/consent.service.js";
import { ActivityService } from "../crm/activity.service.js";
import { SuppressionService } from "../crm/suppression.service.js";
import { EventsService } from "../core/events.service.js";
import { badRequest, notFound } from "../common/errors.js";
import { MarketingSetupService } from "./setup.service.js";
import { sendViaEsp } from "./esp.js";
import { confirmUrl, readConfirmToken } from "./tokens.js";
import { CONFIRM_RESEND_MS, confirmationEmail } from "./double-opt-in.js";

const invalidLink = () => notFound("This link");

/*
 * Double opt-in for lead lists. On a list with `doubleOptIn`, someone added
 * without recorded consent joins as `pending` (ListsService.addMembers, the
 * CSV import, workflows) and is emailed a signed link. Pressing "Confirm" on
 * the page it opens (/confirm/:token) subscribes them, records their consent
 * and emits `list.subscribed`. Opening the link changes nothing: mail
 * scanners follow links, and a scanner must not be able to opt someone in.
 *
 * Pending members are never sent campaigns: the audience and the send loop
 * only take `subscribed` memberships. Nothing expires on its own.
 *
 * The confirmation goes out through the workspace's own email service, from
 * the identity of its latest campaign on a verified domain, and counts
 * against the month's marketing email allowance like a test send.
 */
@Injectable()
export class DoubleOptInService {
  private readonly log = new Logger("double-opt-in");

  constructor(
    private readonly prisma: PrismaService,
    private readonly entitlements: EntitlementsService,
    private readonly consent: ConsentService,
    private readonly activity: ActivityService,
    private readonly suppression: SuppressionService,
    private readonly events: EventsService,
    private readonly setup: MarketingSetupService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Where confirmations are sent from: a verified, unpaused domain, named as the latest campaign on it was. */
  private async identity(workspaceId: string, workspaceName: string) {
    const db = this.prisma.db;
    const domains = await db.sendingDomain.findMany({ where: { workspaceId, deletedAt: null, status: "verified", pausedAt: null }, orderBy: { verifiedAt: "asc" }, select: { id: true, domain: true } });
    if (!domains.length) return null;
    const last = await db.marketingCampaign.findFirst({
      where: { workspaceId, deletedAt: null, sendingDomainId: { in: domains.map((d) => d.id) }, fromLocalPart: { not: "" } },
      orderBy: [{ startedAt: { sort: "desc", nulls: "last" } }, { updatedAt: "desc" }],
      select: { fromName: true, fromLocalPart: true, replyTo: true, sendingDomainId: true },
    });
    const domain = domains.find((d) => d.id === last?.sendingDomainId) ?? domains[0]!;
    const name = (last?.fromName || workspaceName).replace(/["\r\n]/g, "");
    return { domain: domain.domain, from: `"${name}" <${last?.fromLocalPart || "no-reply"}@${domain.domain}>`, replyTo: last?.replyTo || undefined };
  }

  /** Why confirmations could not go out right now, or null when they can. */
  async notReady(workspaceId: string): Promise<string | null> {
    const esp = await this.prisma.db.espConnection.findUnique({ where: { workspaceId } });
    if (!esp || esp.status !== "connected") return "Double opt-in sends a confirmation email: connect an email service first (Settings → Sending domains).";
    const domain = await this.prisma.db.sendingDomain.findFirst({ where: { workspaceId, deletedAt: null, status: "verified", pausedAt: null }, select: { id: true } });
    if (!domain) return "Double opt-in sends a confirmation email: verify a sending domain first (Settings → Sending domains).";
    return null;
  }

  /** Turning double opt-in on needs somewhere to send the confirmations from. */
  async assertReady(workspaceId: string) {
    const why = await this.notReady(workspaceId);
    if (why) throw badRequest(why, { doubleOptIn: why });
  }

  /**
   * Sends one membership's confirmation (worker, `confirm` job). Skips quietly
   * when the member is no longer pending, cannot be emailed, or had one in
   * the last 24 hours. A deferral (4xx) throws so the queue retries it.
   */
  async send(workspaceId: string, membershipId: string): Promise<{ sent: boolean; reason?: string }> {
    const db = this.prisma.db;
    const m = await db.listMembership.findFirst({
      where: { id: membershipId, workspaceId },
      include: { list: { select: { name: true, archivedAt: true } }, contact: { select: { id: true, email: true, deletedAt: true, doNotContact: true, bouncedAt: true, consentStatus: true } } },
    });
    if (!m || m.status !== "pending") return { sent: false, reason: "not pending" };
    const c = m.contact;
    const skip =
      m.list.archivedAt ? "the list is archived"
      : c.deletedAt ? "the contact was deleted"
      : !c.email ? "no email address"
      : c.doNotContact ? "do not contact"
      : c.bouncedAt ? "the address bounced before"
      : c.consentStatus === "denied" ? "consent refused"
      : await this.suppression.check(workspaceId, { email: c.email }, undefined, "marketing");
    if (skip) return { sent: false, reason: skip };

    const ws = await db.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { name: true, legalName: true, postalAddress: true, status: true, billingAccountId: true } });
    if (ws.status === "suspended") return { sent: false, reason: "workspace suspended" };
    const ent = await this.entitlements.forAccount(ws.billingAccountId);
    if (ent.access !== "full" || !ent.features.marketing) return { sent: false, reason: "marketing not in the plan" };
    const esp = await db.espConnection.findUnique({ where: { workspaceId } });
    const smtp = esp?.status === "connected" ? this.setup.smtpFor(esp) : null;
    const from = await this.identity(workspaceId, ws.name);
    if (!smtp || !from) {
      this.log.warn(`confirmation for membership ${membershipId} not sent: no working email service or verified domain`);
      return { sent: false, reason: "sending is not set up" };
    }

    // Claim the send (write-ahead, at most one a day): a parallel job or a re-add within 24 h finds nothing to claim.
    const previous = m.confirmSentAt;
    const claimed = await db.listMembership.updateMany({
      where: { id: m.id, workspaceId, status: "pending", OR: [{ confirmSentAt: null }, { confirmSentAt: { lt: new Date(Date.now() - CONFIRM_RESEND_MS) } }] },
      data: { confirmSentAt: new Date() },
    });
    if (!claimed.count) return { sent: false, reason: "one was sent in the last 24 hours" };
    const release = () => db.listMembership.updateMany({ where: { id: m.id, workspaceId }, data: { confirmSentAt: previous } });

    const period = await this.entitlements.consume(workspaceId, ws.billingAccountId, "monthlyMarketingEmails");
    if (!period) {
      await release();
      return { sent: false, reason: "monthly marketing email allowance used up" };
    }
    const mail = confirmationEmail({
      workspaceName: ws.name,
      listName: m.list.name,
      email: c.email!,
      confirmUrl: confirmUrl(this.config.PUBLIC_APP_URL, m.id),
      legalName: ws.legalName,
      postalAddress: ws.postalAddress,
    });
    const result = await sendViaEsp(smtp, {
      from: from.from,
      to: c.email!,
      replyTo: from.replyTo,
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
      messageId: `<confirm-${randomUUID()}@${from.domain}>`,
      headers: { "X-Growthdesk-Confirm": m.id },
    });
    if (result.sent) {
      await this.activity.log({ workspaceId, contactId: c.id, type: "marketing.confirmation_sent", summary: `Sent a confirmation email for the list ${m.list.name}`, data: { listId: m.listId } });
      return { sent: true };
    }
    const f = result.failure;
    if (f.outcome !== "unknown") {
      // Nothing went out: give the allowance back, and let a retry or a later re-add send it.
      await this.prisma.db.usageCounter.updateMany({ where: { workspaceId, metric: "marketing_emails", period, value: { gt: 0 } }, data: { value: { decrement: 1 } } });
      await release();
    }
    if (f.outcome === "deferred") throw new Error(`Confirmation email deferred: ${f.error}`);
    this.log.warn(`confirmation for membership ${membershipId} failed: ${f.error}`);
    return { sent: false, reason: f.error };
  }

  // ─── The public confirmation page ─────────────────────────────────────────

  /** The membership a confirmation token names. Unscoped by design: the signed token is how we learn the workspace. */
  private async target(token: string) {
    const id = readConfirmToken(token);
    if (!id) throw invalidLink();
    const m = await this.prisma.unscoped.listMembership.findUnique({
      where: { id },
      include: { list: { select: { name: true, archivedAt: true } }, contact: { select: { email: true, deletedAt: true } } },
    });
    if (!m || m.list.archivedAt || m.contact.deletedAt || !m.contact.email) throw invalidLink();
    return m;
  }

  private async view(m: Awaited<ReturnType<DoubleOptInService["target"]>>, status = m.status): Promise<ConfirmSubscriptionDetails> {
    const ws = await this.prisma.db.workspace.findUniqueOrThrow({ where: { id: m.workspaceId }, select: { name: true, legalName: true } });
    return { email: m.contact.email!, workspaceName: ws.name, legalName: ws.legalName, listName: m.list.name, status };
  }

  /** What the confirmation page shows. Changes nothing. */
  async details(token: string) {
    return this.view(await this.target(token));
  }

  /** The person pressed "Confirm": subscribe them, record their consent, emit list.subscribed. Idempotent. */
  async confirm(token: string, ip: string, userAgent: string): Promise<ConfirmSubscriptionDetails> {
    const m = await this.target(token);
    const { workspaceId, contactId, listId } = m;
    let status = m.status;
    if (m.status === "pending") {
      status = await this.prisma.db.$transaction(async (tx) => {
        const now = new Date();
        const moved = await tx.listMembership.updateMany({ where: { id: m.id, workspaceId, status: "pending" }, data: { status: "subscribed", subscribedAt: now, unsubscribedAt: null } });
        if (!moved.count) return (await tx.listMembership.findFirst({ where: { id: m.id, workspaceId }, select: { status: true } }))?.status ?? m.status;
        // Confirming is consent given by the person themselves, as on the preference page.
        await this.consent.setIn(tx, { workspaceId, contactId, status: "granted", source: "Double opt-in confirmation", ip, userAgent, detail: { via: "double_opt_in", listId } });
        await tx.suppression.deleteMany({ where: { workspaceId, kind: "email", value: m.contact.email!, scope: "marketing", reason: "unsubscribed" } });
        await this.activity.log({ workspaceId, contactId, type: "marketing.subscribed", summary: `Confirmed their subscription to ${m.list.name} (double opt-in)`, data: { listId } }, tx);
        await this.events.emitIn(tx, {
          workspaceId,
          type: "list.subscribed",
          subjectType: "contact",
          subjectId: contactId,
          payload: { contactId, listId, listName: m.list.name, source: "double_opt_in" },
        });
        return "subscribed" as const;
      });
      await this.events.kick();
    }
    return this.view(m, status);
  }
}
