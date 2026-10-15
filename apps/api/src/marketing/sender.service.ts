import { Inject, Injectable, Logger } from "@nestjs/common";
import { emailDomain, fill, GUARDRAIL, renderEmail, variablesFor } from "@growthdesk/shared";
import { PrismaService } from "../prisma/prisma.service.js";
import { APP_CONFIG, type AppConfig } from "../config/config.js";
import { EntitlementsService } from "../billing/entitlements.service.js";
import { NotificationsService } from "../notifications/notifications.service.js";
import { QUEUES, Queues } from "../queues/queues.js";
import { AudienceService, readAudience, readGuardrailSince } from "./audience.service.js";
import { MarketingCampaignsService } from "./campaigns.service.js";
import { readBlocks, readTheme } from "./designs.service.js";
import { MarketingSetupService } from "./setup.service.js";
import { sendViaEsp } from "./esp.js";
import { marketingBase, marketingLinks, withMarketingTracking } from "./tokens.js";

/** Recipients one batch job sends before handing back to the queue. */
const BATCH = 50;
/** A row written ahead of a send whose outcome never came back within this time is settled as uncertain, never resent. */
const STALE_MS = 10 * 60_000;
/** A recipient the email service keeps deferring (4xx) is retried this often, behind the rows not tried yet... */
const RETRY_MS = 5 * 60_000;
/** ...and failed once it has been deferred for this long. */
const GIVE_UP_MS = 24 * 60 * 60_000;

/*
 * A deferred row stays `queued` with its sentAt cleared; its error records
 * the deferrals so far and when the first one happened, so the retry pace and
 * the give-up time survive between batches without a column of their own.
 */
const DEFERRED = /^Deferred (\d+)× since (\S+): /;
export function readDeferral(error: string): { tries: number; since: Date } | null {
  const m = DEFERRED.exec(error);
  const since = m ? new Date(m[2]!) : null;
  return m && since && !Number.isNaN(since.getTime()) ? { tries: Number(m[1]), since } : null;
}
export const deferralError = (tries: number, since: Date, error: string) => `Deferred ${tries}× since ${since.toISOString()}: ${error}`.slice(0, 500);

/*
 * The marketing send loop (worker only). `tick` runs every 10 s: it starts
 * due scheduled campaigns, queues one `batch` job per sending campaign (the
 * job id makes it one at a time per campaign), settles interrupted rows,
 * closes finished campaigns and refreshes their counters.
 *
 * Each recipient is re-checked right before sending (R2/R3): consent, list
 * subscription, do-not-contact, bounce and suppression can all change after
 * the campaign started. A row is stamped `sentAt` before the SMTP call
 * (write-ahead), so a crash mid-send leaves it marked rather than resent.
 */
@Injectable()
export class MarketingSenderService {
  private readonly log = new Logger("marketing-sender");

  constructor(
    private readonly prisma: PrismaService,
    private readonly entitlements: EntitlementsService,
    private readonly notifications: NotificationsService,
    private readonly queues: Queues,
    private readonly audience: AudienceService,
    private readonly campaigns: MarketingCampaignsService,
    private readonly setup: MarketingSetupService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async tick() {
    const db = this.prisma.unscoped; // cross-tenant sweep: finds due work in every workspace
    const now = new Date();
    const due = await db.marketingCampaign.findMany({ where: { status: "scheduled", scheduledAt: { lte: now }, deletedAt: null }, select: { id: true, workspaceId: true } });
    for (const c of due) await this.campaigns.start(c.workspaceId, c.id);

    await db.marketingSend.updateMany({
      where: { status: "queued", sentAt: { lt: new Date(now.getTime() - STALE_MS) } },
      data: { status: "failed", error: "Interrupted while sending; it may have been delivered, so it was not sent again." },
    });

    const sending = await db.marketingCampaign.findMany({ where: { status: "sending", deletedAt: null }, select: { id: true, workspaceId: true } });
    let queued = 0;
    let completed = 0;
    for (const c of sending) {
      const left = await db.marketingSend.count({ where: { workspaceId: c.workspaceId, campaignId: c.id, status: "queued" } });
      if (left === 0) {
        await this.refresh(c.workspaceId, c.id);
        await db.marketingCampaign.updateMany({ where: { id: c.id, workspaceId: c.workspaceId, status: "sending" }, data: { status: "sent", completedAt: new Date() } });
        completed++;
        continue;
      }
      await this.queues.add(QUEUES.marketing, "batch", { workspaceId: c.workspaceId, campaignId: c.id }, { jobId: `mk-batch-${c.id}`, attempts: 1, removeOnComplete: true, removeOnFail: 100 });
      queued++;
    }
    return { started: due.length, queued, completed };
  }

  /** Recomputes a campaign's counters from its rows. */
  async refresh(workspaceId: string, campaignId: string) {
    const db = this.prisma.db;
    const base = { workspaceId, campaignId };
    const [byStatus, opens, clicks, unsubs] = await Promise.all([
      db.marketingSend.groupBy({ by: ["status"], where: base, _count: { _all: true } }),
      db.marketingSend.count({ where: { ...base, openedAt: { not: null } } }),
      db.marketingSend.count({ where: { ...base, clickedAt: { not: null } } }),
      db.marketingSend.count({ where: { ...base, unsubscribedAt: { not: null } } }),
    ]);
    const n = (s: string) => byStatus.find((r) => r.status === s)?._count._all ?? 0;
    await db.marketingCampaign.update({
      where: { id: campaignId, workspaceId },
      data: {
        // Bounced and complained rows were sent first.
        sentCount: n("sent") + n("bounced") + n("complained"),
        failedCount: n("failed"),
        skippedCount: n("skipped"),
        bounceCount: n("bounced"),
        complaintCount: n("complained"),
        uniqueOpenCount: opens,
        uniqueClickCount: clicks,
        unsubscribeCount: unsubs,
      },
    });
  }

  private async pauseCampaign(workspaceId: string, campaignId: string, reason: string) {
    const moved = await this.prisma.db.marketingCampaign.updateMany({ where: { id: campaignId, workspaceId, status: "sending" }, data: { status: "paused", pausedAt: new Date(), pausedReason: reason } });
    if (moved.count) {
      this.log.warn(`campaign ${campaignId} paused: ${reason}`);
      const c = await this.prisma.db.marketingCampaign.findFirst({ where: { id: campaignId, workspaceId }, select: { name: true, createdById: true } });
      if (c?.createdById) {
        await this.notifications.notify(workspaceId, [c.createdById], { type: "marketing.paused", title: `"${c.name}" was paused`, body: reason, link: `/w/${workspaceId}/marketing/campaigns/${campaignId}`, email: true }).catch(() => undefined);
      }
    }
  }

  /** Sends up to BATCH queued recipients of one campaign. */
  async batch(workspaceId: string, campaignId: string) {
    const db = this.prisma.db;
    const c = await db.marketingCampaign.findFirst({ where: { id: campaignId, workspaceId, status: "sending", deletedAt: null } });
    if (!c) return { sent: 0 };
    const [esp, domain, ws] = await Promise.all([
      db.espConnection.findUnique({ where: { workspaceId } }),
      c.sendingDomainId ? db.sendingDomain.findFirst({ where: { id: c.sendingDomainId, workspaceId, deletedAt: null } }) : null,
      db.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { billingAccountId: true, legalName: true, postalAddress: true, status: true } }),
    ]);
    if (ws.status === "suspended") return this.pauseCampaign(workspaceId, campaignId, "The workspace is suspended.").then(() => ({ sent: 0 }));
    if (!esp || esp.status !== "connected") return this.pauseCampaign(workspaceId, campaignId, "The email service is not connected.").then(() => ({ sent: 0 }));
    if (!domain || domain.status !== "verified") return this.pauseCampaign(workspaceId, campaignId, "The sending domain is no longer verified.").then(() => ({ sent: 0 }));
    if (domain.pausedAt) return this.pauseCampaign(workspaceId, campaignId, `Sending from ${domain.domain} is paused: ${domain.pausedReason}`).then(() => ({ sent: 0 }));
    const ent = await this.entitlements.forAccount(ws.billingAccountId);
    if (ent.access !== "full" || !ent.features.marketing) return this.pauseCampaign(workspaceId, campaignId, ent.reason || "Email marketing is not included in the current plan.").then(() => ({ sent: 0 }));
    const smtp = this.setup.smtpFor(esp);
    if (!smtp) return this.pauseCampaign(workspaceId, campaignId, "The email service's password can no longer be read. Reconnect it.").then(() => ({ sent: 0 }));

    const rows = await this.nextRows(workspaceId, campaignId);
    const audience = readAudience(c.audience);
    const sup = await this.audience.suppressed(workspaceId);
    const blocks = readBlocks(c.blocks);
    const theme = readTheme(c.theme);
    const base = marketingBase(this.config.PUBLIC_APP_URL);
    const from = `"${c.fromName.replace(/["\r\n]/g, "")}" <${c.fromLocalPart}@${domain.domain}>`;
    let sent = 0;

    for (const row of rows) {
      const contact = await db.contact.findFirst({
        where: { id: row.contactId, workspaceId },
        include: {
          company: { select: { name: true, domain: true } },
          owner: { select: { name: true } },
          listMemberships: { where: { listId: { in: audience.listIds }, status: "subscribed" }, select: { id: true } },
        },
      });
      const skip =
        !contact || contact.deletedAt ? "The contact was deleted"
        : contact.email !== row.email ? "The contact's email address changed"
        : contact.consentStatus !== "granted" ? "No marketing consent"
        : contact.doNotContact ? "Marked do not contact"
        : contact.bouncedAt ? "The address bounced before"
        : !contact.listMemberships.length ? "No longer subscribed"
        : sup.emails.has(row.email) || sup.domains.has(emailDomain(row.email)) ? "On the suppression list"
        : null;
      if (skip) {
        await db.marketingSend.updateMany({ where: { id: row.id, workspaceId, status: "queued" }, data: { status: "skipped", error: skip } });
        continue;
      }
      // The period the email is counted in, so a refund gives it back to the same month.
      const period = await this.entitlements.consume(workspaceId, ws.billingAccountId, "monthlyMarketingEmails");
      if (!period) {
        await this.pauseCampaign(workspaceId, campaignId, "This month's marketing email allowance is used up. It renews on your billing day, or upgrade the plan.");
        break;
      }
      // Write-ahead: claim the row so no other run sends it.
      const claimed = await db.marketingSend.updateMany({ where: { id: row.id, workspaceId, status: "queued", sentAt: null }, data: { sentAt: new Date() } });
      if (!claimed.count) {
        await this.refund(workspaceId, period);
        continue;
      }

      const links = marketingLinks(base, this.config.PUBLIC_APP_URL, row.id);
      const vars = variablesFor(contact!);
      const rendered = renderEmail(blocks, {
        preheader: c.preheader,
        theme,
        vars,
        footer: { legalName: ws.legalName, postalAddress: ws.postalAddress, preferencesUrl: links.preferences },
      });
      const html = withMarketingTracking(rendered.html, links, base, this.config.PUBLIC_APP_URL, { open: c.trackOpens, click: c.trackClicks });
      const result = await sendViaEsp(smtp, {
        from,
        to: row.email,
        replyTo: c.replyTo || undefined,
        subject: fill(c.subject, vars).replace(/[\r\n]+/g, " ").trim(),
        html,
        text: rendered.text,
        messageId: `<${row.id}@${domain.domain}>`,
        headers: {
          "List-Unsubscribe": `<${links.unsubscribe}>`,
          "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
          "X-Growthdesk-Send": row.id,
          "Feedback-ID": `${campaignId.slice(0, 8)}:${workspaceId.slice(0, 8)}:growthdesk`,
        },
      });

      if (result.sent) {
        await db.marketingSend.update({ where: { id: row.id, workspaceId }, data: { status: "sent", providerMessageId: result.providerMessageId, error: "" } });
        sent++;
        continue;
      }
      const f = result.failure;
      // Nothing went out (unless the outcome is unknown): give the allowance back.
      if (f.outcome !== "unknown") await this.refund(workspaceId, period);
      if (f.outcome === "deferred") {
        // Try again later, behind the rows not tried yet, so one recipient cannot hold up the rest;
        // after a day of deferrals it is failed. The batch stops either way: a 4xx is usually the
        // service throttling us, which the next tick's pace respects.
        const prev = readDeferral(row.error);
        const since = prev?.since ?? new Date();
        const expired = Date.now() - since.getTime() >= GIVE_UP_MS;
        await db.marketingSend.update({
          where: { id: row.id, workspaceId },
          data: expired ? { status: "failed", error: `Deferred for over a day, gave up: ${f.error}`.slice(0, 500) } : { sentAt: null, error: deferralError((prev?.tries ?? 0) + 1, since, f.error) },
        });
        if (f.mailboxAtFault) {
          await db.espConnection.update({ where: { workspaceId }, data: { status: "error", lastError: f.error.slice(0, 500), lastCheckedAt: new Date() } });
          await this.pauseCampaign(workspaceId, campaignId, `The email service refused the connection: ${f.error.slice(0, 200)}`);
        }
        break;
      }
      await db.marketingSend.update({
        where: { id: row.id, workspaceId },
        data: { status: "failed", error: (f.outcome === "unknown" ? `May have been delivered (not resent): ${f.error}` : f.error).slice(0, 500) },
      });
      if (f.mailboxAtFault) {
        await db.espConnection.update({ where: { workspaceId }, data: { status: "error", lastError: f.error.slice(0, 500), lastCheckedAt: new Date() } });
        await this.pauseCampaign(workspaceId, campaignId, `The email service refused the credentials: ${f.error.slice(0, 200)}`);
        break;
      }
    }

    await this.refresh(workspaceId, campaignId);
    await this.guardrail(workspaceId, campaignId);
    return { sent, processed: rows.length };
  }

  /**
   * The next rows to try: those never tried first (error is empty until a
   * deferral), then deferred ones whose retry is due.
   */
  private async nextRows(workspaceId: string, campaignId: string) {
    const db = this.prisma.db;
    const where = { workspaceId, campaignId, status: "queued" as const, sentAt: null };
    const fresh = await db.marketingSend.findMany({ where: { ...where, error: "" }, orderBy: { id: "asc" }, take: BATCH });
    if (fresh.length >= BATCH) return fresh;
    const deferred = await db.marketingSend.findMany({ where: { ...where, error: { not: "" } }, orderBy: { id: "asc" }, take: 500 });
    const now = Date.now();
    const due = deferred.filter((r) => {
      const d = readDeferral(r.error);
      return !d || now >= d.since.getTime() + d.tries * RETRY_MS;
    });
    return [...fresh, ...due.slice(0, BATCH - fresh.length)];
  }

  /** Gives back one marketing email of the month it was taken from. */
  private async refund(workspaceId: string, period: string) {
    await this.prisma.db.usageCounter.updateMany({ where: { workspaceId, metric: "marketing_emails", period, value: { gt: 0 } }, data: { value: { decrement: 1 } } });
  }

  /**
   * R5: pause the campaign and its sending domain when bounces or complaints
   * run high. After a guardrail pause is resumed, only emails sent since the
   * resume are judged (see readGuardrailSince), so the old totals do not
   * pause it again at once.
   */
  async guardrail(workspaceId: string, campaignId: string) {
    const c = await this.prisma.db.marketingCampaign.findFirst({ where: { id: campaignId, workspaceId } });
    if (!c) return;
    const since = readGuardrailSince(c.audience);
    let sent = c.sentCount;
    let bounces = c.bounceCount;
    let complaints = c.complaintCount;
    if (since) {
      const byStatus = await this.prisma.db.marketingSend.groupBy({
        by: ["status"],
        where: { workspaceId, campaignId, sentAt: { gte: since }, status: { in: ["sent", "bounced", "complained"] } },
        _count: { _all: true },
      });
      const n = (st: string) => byStatus.find((r) => r.status === st)?._count._all ?? 0;
      bounces = n("bounced");
      complaints = n("complained");
      sent = n("sent") + bounces + complaints;
    }
    if (sent < GUARDRAIL.minSample) return;
    const bounceRate = bounces / sent;
    const complaintRate = complaints / sent;
    const reason =
      bounceRate > GUARDRAIL.maxBounceRate ? `Bounce rate ${(bounceRate * 100).toFixed(1)}% is above ${(GUARDRAIL.maxBounceRate * 100).toFixed(0)}%. Clean the list before sending more.`
      : complaintRate > GUARDRAIL.maxComplaintRate ? `Spam complaint rate ${(complaintRate * 100).toFixed(2)}% is above ${(GUARDRAIL.maxComplaintRate * 100).toFixed(1)}%. Check who is on the list and how they joined.`
      : null;
    if (!reason) return;
    if (c.status === "sending") await this.pauseCampaign(workspaceId, campaignId, reason);
    if (c.sendingDomainId) {
      await this.prisma.db.sendingDomain.updateMany({ where: { id: c.sendingDomainId, workspaceId, pausedAt: null }, data: { pausedAt: new Date(), pausedReason: reason } });
    }
  }
}
