import { Inject, Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import {
  designProblems,
  fill,
  renderEmail,
  starterBlocks,
  variablesFor,
  type MarketingAudienceT,
  type MarketingCampaignInputT,
  type MarketingRecipientsQuery,
} from "@growthdesk/shared";
import type { z } from "zod";
import type { MarketingCampaign, Prisma } from "../generated/prisma/client.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { APP_CONFIG, type AppConfig } from "../config/config.js";
import { EntitlementsService } from "../billing/entitlements.service.js";
import { AuditService } from "../core/audit.service.js";
import { badRequest, conflict, notFound, unavailable } from "../common/errors.js";
import { actorId, me, ws, type RequestContext } from "../common/context.js";
import { AudienceService, readAudience, type StoredAudience } from "./audience.service.js";
import { readBlocks, readTheme } from "./designs.service.js";
import { MarketingSetupService } from "./setup.service.js";
import { sendViaEsp } from "./esp.js";

const EDITABLE = new Set(["draft"]);
const shortId = () => randomUUID().slice(0, 8);

/*
 * Marketing campaigns: a one-off email to an audience of lists. A campaign
 * is edited as a draft, checked by `readiness`, then sent now or scheduled.
 * Sending creates one MarketingSend row per eligible recipient up front; the
 * worker (MarketingSenderService) works through them in batches.
 */
@Injectable()
export class MarketingCampaignsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService,
    private readonly audience: AudienceService,
    private readonly setup: MarketingSetupService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  dto(c: MarketingCampaign & { sendingDomain?: { domain: string } | null }) {
    const a = readAudience(c.audience);
    return {
      id: c.id,
      name: c.name,
      status: c.status,
      subject: c.subject,
      preheader: c.preheader,
      fromName: c.fromName,
      fromLocalPart: c.fromLocalPart,
      fromEmail: c.fromLocalPart && c.sendingDomain ? `${c.fromLocalPart}@${c.sendingDomain.domain}` : null,
      replyTo: c.replyTo,
      sendingDomainId: c.sendingDomainId,
      blocks: readBlocks(c.blocks),
      theme: readTheme(c.theme),
      audience: { listIds: a.listIds, excludeListIds: a.excludeListIds, viewId: a.viewId ?? null },
      trackOpens: c.trackOpens,
      trackClicks: c.trackClicks,
      scheduledAt: c.scheduledAt,
      startedAt: c.startedAt,
      completedAt: c.completedAt,
      pausedAt: c.pausedAt,
      pausedReason: c.pausedReason,
      canceledAt: c.canceledAt,
      stats: {
        recipients: c.recipientCount,
        sent: c.sentCount,
        failed: c.failedCount,
        skipped: c.skippedCount,
        uniqueOpens: c.uniqueOpenCount,
        uniqueClicks: c.uniqueClickCount,
        unsubscribes: c.unsubscribeCount,
        bounces: c.bounceCount,
        complaints: c.complaintCount,
      },
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
    };
  }

  private async find(ctx: RequestContext, id: string) {
    const c = await this.prisma.db.marketingCampaign.findFirst({ where: { id, workspaceId: ws(ctx).id, deletedAt: null }, include: { sendingDomain: { select: { domain: true } } } });
    if (!c) throw notFound("That campaign");
    return c;
  }

  async list(ctx: RequestContext) {
    const rows = await this.prisma.db.marketingCampaign.findMany({
      where: { workspaceId: ws(ctx).id, deletedAt: null },
      include: { sendingDomain: { select: { domain: true } } },
      orderBy: { createdAt: "desc" },
    });
    return rows.map((r) => this.dto(r));
  }

  async get(ctx: RequestContext, id: string) {
    return this.dto(await this.find(ctx, id));
  }

  /** Lists and the segment must belong to this workspace. */
  private async checkAudience(ctx: RequestContext, a: MarketingAudienceT) {
    const w = ws(ctx);
    const ids = [...new Set([...a.listIds, ...a.excludeListIds])];
    if (ids.length) {
      const found = await this.prisma.db.marketingList.count({ where: { workspaceId: w.id, id: { in: ids } } });
      if (found !== ids.length) throw badRequest("One of the lists does not exist", { audience: "Unknown list" });
    }
    if (a.viewId) await this.audience.resolve(ctx, a);
  }

  private async data(ctx: RequestContext, input: Partial<MarketingCampaignInputT>): Promise<Prisma.MarketingCampaignUncheckedUpdateInput> {
    const w = ws(ctx);
    const data: Prisma.MarketingCampaignUncheckedUpdateInput = {};
    for (const k of ["name", "subject", "preheader", "fromName", "fromLocalPart", "replyTo", "trackOpens", "trackClicks"] as const) {
      if (input[k] !== undefined) (data as Record<string, unknown>)[k] = input[k];
    }
    if (input.sendingDomainId !== undefined) {
      if (input.sendingDomainId) {
        const d = await this.prisma.db.sendingDomain.findFirst({ where: { id: input.sendingDomainId, workspaceId: w.id, deletedAt: null } });
        if (!d) throw badRequest("That sending domain does not exist", { sendingDomainId: "Unknown domain" });
      }
      data.sendingDomainId = input.sendingDomainId;
    }
    if (input.designId) {
      const d = await this.prisma.db.emailDesign.findFirst({ where: { id: input.designId, workspaceId: w.id } });
      if (!d) throw badRequest("That design does not exist", { designId: "Unknown design" });
      data.designId = d.id;
      data.blocks = d.blocks as never;
      data.theme = d.theme as never;
    }
    if (input.blocks !== undefined) data.blocks = input.blocks as never;
    if (input.theme !== undefined) data.theme = input.theme as never;
    if (input.audience !== undefined) {
      await this.checkAudience(ctx, input.audience);
      data.audience = { listIds: input.audience.listIds, excludeListIds: input.audience.excludeListIds, viewId: input.audience.viewId ?? null } as never;
    }
    return data;
  }

  async create(ctx: RequestContext, input: MarketingCampaignInputT) {
    const w = ws(ctx);
    await this.entitlements.assertFeature(w.billingAccountId, "marketing");
    const [profile, domain] = await Promise.all([
      this.prisma.db.workspace.findUniqueOrThrow({ where: { id: w.id }, select: { name: true, marketingFromName: true, marketingReplyTo: true } }),
      this.prisma.db.sendingDomain.findFirst({ where: { workspaceId: w.id, deletedAt: null, status: "verified" }, orderBy: { createdAt: "asc" } }),
    ]);
    const data = await this.data(ctx, input);
    const row = await this.prisma.db.marketingCampaign.create({
      data: {
        fromName: profile.marketingFromName || profile.name,
        fromLocalPart: "news",
        replyTo: profile.marketingReplyTo,
        sendingDomainId: domain?.id ?? null,
        blocks: starterBlocks(shortId) as never,
        ...(data as Omit<Prisma.MarketingCampaignUncheckedCreateInput, "workspaceId" | "name">),
        workspaceId: w.id,
        name: input.name,
        createdById: actorId(ctx),
      },
    });
    return this.get(ctx, row.id);
  }

  async update(ctx: RequestContext, id: string, input: Partial<MarketingCampaignInputT>) {
    const c = await this.find(ctx, id);
    if (!EDITABLE.has(c.status)) throw conflict(c.status === "scheduled" ? "Unschedule the campaign before editing it." : "Only a draft can be edited. Duplicate it to make changes.");
    await this.prisma.db.marketingCampaign.update({ where: { id, workspaceId: c.workspaceId }, data: await this.data(ctx, input) });
    return this.get(ctx, id);
  }

  async duplicate(ctx: RequestContext, id: string) {
    const c = await this.find(ctx, id);
    const a = readAudience(c.audience);
    const row = await this.prisma.db.marketingCampaign.create({
      data: {
        workspaceId: c.workspaceId,
        name: `${c.name} (copy)`.slice(0, 120),
        subject: c.subject,
        preheader: c.preheader,
        fromName: c.fromName,
        fromLocalPart: c.fromLocalPart,
        replyTo: c.replyTo,
        sendingDomainId: c.sendingDomainId,
        blocks: c.blocks as never,
        theme: c.theme as never,
        designId: c.designId,
        audience: { listIds: a.listIds, excludeListIds: a.excludeListIds, viewId: a.viewId ?? null } as never,
        trackOpens: c.trackOpens,
        trackClicks: c.trackClicks,
        createdById: actorId(ctx),
      },
    });
    return this.get(ctx, row.id);
  }

  async remove(ctx: RequestContext, id: string) {
    const c = await this.find(ctx, id);
    if (["sending", "scheduled", "paused"].includes(c.status)) throw conflict("Cancel the campaign before deleting it.");
    await this.prisma.db.marketingCampaign.update({ where: { id, workspaceId: c.workspaceId }, data: { deletedAt: new Date() } });
    return { deleted: true };
  }

  /** How many contacts this audience reaches right now. */
  async audienceCount(ctx: RequestContext, a: MarketingAudienceT) {
    await this.checkAudience(ctx, a);
    return { count: await this.audience.count(ctx, ws(ctx).id, a) };
  }

  /** Everything that stops this campaign from being sent, in words for people. Empty when it is ready. */
  async readiness(ctx: RequestContext, id: string) {
    const w = ws(ctx);
    const c = await this.find(ctx, id);
    const problems: string[] = [];
    const [esp, domain, profile, ent] = await Promise.all([
      this.prisma.db.espConnection.findUnique({ where: { workspaceId: w.id } }),
      c.sendingDomainId ? this.prisma.db.sendingDomain.findFirst({ where: { id: c.sendingDomainId, workspaceId: w.id, deletedAt: null } }) : null,
      this.prisma.db.workspace.findUniqueOrThrow({ where: { id: w.id }, select: { legalName: true, postalAddress: true } }),
      this.entitlements.forAccount(w.billingAccountId),
    ]);
    if (!ent.features.marketing) problems.push(`Email marketing is not included in the ${ent.effectivePlan.name} plan.`);
    if (ent.access !== "full") problems.push(ent.reason);
    if (!esp || esp.status !== "connected") problems.push("Connect an email service in Settings → Sending domains.");
    if (!domain) problems.push("Choose a sending domain.");
    else if (domain.status !== "verified") problems.push(`${domain.domain} is not verified yet. Add its DNS records and check again.`);
    else if (domain.pausedAt) problems.push(`Sending from ${domain.domain} is paused: ${domain.pausedReason}`);
    if (!c.fromLocalPart) problems.push("Set the From address.");
    if (!c.fromName.trim()) problems.push("Set the From name.");
    if (!c.subject.trim()) problems.push("Write a subject line.");
    if (!profile.legalName.trim() || !profile.postalAddress.trim()) problems.push("Add your legal company name and postal address in Settings → Company profile. Every marketing email must show them.");
    problems.push(...designProblems(readBlocks(c.blocks)));
    const a = readAudience(c.audience);
    if (!a.listIds.length) problems.push("Choose at least one list to send to.");
    const recipients = a.listIds.length ? await this.audience.count(ctx, w.id, a) : 0;
    if (a.listIds.length && recipients === 0) problems.push("No one in the chosen lists can receive this email (they need consent, a subscription and no suppression).");
    return { ready: problems.length === 0, problems, recipients };
  }

  /** Sends the current draft to up to five addresses, marked [Test]. Needs a working email service and domain. */
  async testSend(ctx: RequestContext, id: string, emails: string[]) {
    const w = ws(ctx);
    const c = await this.find(ctx, id);
    await this.entitlements.assertFeature(w.billingAccountId, "marketing");
    const esp = await this.prisma.db.espConnection.findUnique({ where: { workspaceId: w.id } });
    if (!esp) throw badRequest("Connect an email service first (Settings → Sending domains).");
    const domain = c.sendingDomainId ? await this.prisma.db.sendingDomain.findFirst({ where: { id: c.sendingDomainId, workspaceId: w.id, deletedAt: null } }) : null;
    if (!domain || domain.status !== "verified") throw badRequest("Choose a verified sending domain first.");
    const smtp = this.setup.smtpFor(esp);
    if (!smtp) throw unavailable("The email service's password can no longer be read. Reconnect it in Settings.");
    const profile = await this.prisma.db.workspace.findUniqueOrThrow({ where: { id: w.id }, select: { legalName: true, postalAddress: true } });
    const period = await this.entitlements.consume(w.id, w.billingAccountId, "monthlyMarketingEmails", emails.length);
    if (!period) throw badRequest("This month's marketing email allowance is used up.");
    const sender = me(ctx);
    const [first, ...rest] = sender.name.split(" ");
    const vars = variablesFor({ firstName: first, lastName: rest.join(" "), fullName: sender.name, email: sender.email });
    const preferencesUrl = `${this.config.PUBLIC_APP_URL.replace(/\/+$/, "")}/preferences/test`;
    const { html, text } = renderEmail(readBlocks(c.blocks), { preheader: c.preheader, theme: readTheme(c.theme), vars, footer: { legalName: profile.legalName, postalAddress: profile.postalAddress, preferencesUrl } });
    const results: { email: string; sent: boolean; error?: string }[] = [];
    let notSent = 0;
    for (const to of emails) {
      const r = await sendViaEsp(smtp, {
        from: `"${c.fromName.replace(/"/g, "")}" <${c.fromLocalPart}@${domain.domain}>`,
        to,
        replyTo: c.replyTo || undefined,
        subject: `[Test] ${fill(c.subject || c.name, vars).replace(/[\r\n]+/g, " ").trim()}`,
        html,
        text,
        messageId: `<test-${randomUUID()}@${domain.domain}>`,
        headers: { "X-Growthdesk-Test": "1" },
      });
      results.push(r.sent ? { email: to, sent: true } : { email: to, sent: false, error: r.failure.error });
      if (!r.sent && r.failure.outcome !== "unknown") notSent++;
    }
    // Give back what certainly did not go out, to the month it was taken from (as the worker does).
    if (notSent) {
      await this.prisma.db.usageCounter.updateMany({ where: { workspaceId: w.id, metric: "marketing_emails", period, value: { gte: notSent } }, data: { value: { decrement: notSent } } });
    }
    return { results };
  }

  /** Sends now, or schedules for `scheduledAt`. */
  async send(ctx: RequestContext, id: string, scheduledAt?: Date) {
    const w = ws(ctx);
    const c = await this.find(ctx, id);
    if (c.status !== "draft") throw conflict("Only a draft can be sent.");
    await this.entitlements.assertFullAccess(w.billingAccountId, "Sending marketing email");
    const ready = await this.readiness(ctx, id);
    if (!ready.ready) throw badRequest(ready.problems[0]!, undefined);
    // Freeze the segment now, so the worker sends to what the person saw.
    const stored = await this.audience.resolve(ctx, readAudience(c.audience));
    const later = scheduledAt && scheduledAt.getTime() > Date.now() + 60_000;
    if (later) {
      await this.prisma.db.marketingCampaign.update({ where: { id, workspaceId: w.id }, data: { status: "scheduled", scheduledAt, audience: stored as never } });
    } else {
      await this.prisma.db.marketingCampaign.update({ where: { id, workspaceId: w.id }, data: { audience: stored as never } });
      await this.start(w.id, id);
    }
    await this.audit.record(ctx, { action: later ? "marketing.campaign_scheduled" : "marketing.campaign_sent", targetType: "marketing_campaign", targetId: id, metadata: { recipients: ready.recipients, scheduledAt: later ? scheduledAt : null } });
    return this.get(ctx, id);
  }

  /**
   * Moves a draft or due scheduled campaign to `sending` and writes its
   * recipient rows. Idempotent: a campaign already past `scheduled` is left
   * alone, and the rows are unique per (campaign, contact).
   */
  async start(workspaceId: string, id: string) {
    await this.prisma.db.$transaction(async (tx) => {
      const moved = await tx.marketingCampaign.updateMany({
        where: { id, workspaceId, status: { in: ["draft", "scheduled"] } },
        data: { status: "sending", startedAt: new Date(), scheduledAt: null },
      });
      if (!moved.count) return;
      const c = await tx.marketingCampaign.findFirstOrThrow({ where: { id, workspaceId } });
      const recipients = await this.audience.recipients(workspaceId, readAudience(c.audience) as StoredAudience, tx);
      for (let i = 0; i < recipients.length; i += 1000) {
        await tx.marketingSend.createMany({
          data: recipients.slice(i, i + 1000).map((r) => ({ workspaceId, campaignId: id, contactId: r.id, email: r.email })),
          skipDuplicates: true,
        });
      }
      await tx.marketingCampaign.update({ where: { id, workspaceId }, data: { recipientCount: recipients.length } });
    }, { timeout: 120_000 });
  }

  async pause(ctx: RequestContext, id: string) {
    const c = await this.find(ctx, id);
    if (c.status !== "sending" && c.status !== "scheduled") throw conflict("Only a sending or scheduled campaign can be paused.");
    await this.prisma.db.marketingCampaign.update({ where: { id, workspaceId: c.workspaceId }, data: { status: "paused", pausedAt: new Date(), pausedReason: "Paused by a team member" } });
    await this.audit.record(ctx, { action: "marketing.campaign_paused", targetType: "marketing_campaign", targetId: id });
    return this.get(ctx, id);
  }

  /** Back to a draft so it can be edited; it is sent again with Send or Schedule. */
  async unschedule(ctx: RequestContext, id: string) {
    const c = await this.find(ctx, id);
    // Conditional on the status, so a campaign the worker just started is not pulled back.
    const moved = await this.prisma.db.marketingCampaign.updateMany({ where: { id, workspaceId: c.workspaceId, status: "scheduled" }, data: { status: "draft", scheduledAt: null } });
    if (!moved.count) throw conflict("Only a scheduled campaign can be unscheduled.");
    await this.audit.record(ctx, { action: "marketing.campaign_unscheduled", targetType: "marketing_campaign", targetId: id, metadata: { scheduledAt: c.scheduledAt } });
    return this.get(ctx, id);
  }

  async resume(ctx: RequestContext, id: string) {
    const w = ws(ctx);
    const c = await this.find(ctx, id);
    if (c.status !== "paused") throw conflict("Only a paused campaign can be resumed.");
    await this.entitlements.assertFullAccess(w.billingAccountId, "Sending marketing email");
    if (c.sendingDomainId) {
      const d = await this.prisma.db.sendingDomain.findFirst({ where: { id: c.sendingDomainId, workspaceId: w.id } });
      if (d?.pausedAt) throw conflict(`Sending from ${d.domain} is paused (${d.pausedReason}). Review it in Settings → Sending domains first.`);
    }
    const next = c.startedAt ? "sending" : c.scheduledAt ? "scheduled" : "sending";
    // After a guardrail pause, judge only what is sent from now on, or the old totals pause it again at once.
    // Only then: resetting the sample on every manual resume would let the guardrail be sidestepped.
    const rebase = c.startedAt && /bounce rate|complaint rate/i.test(c.pausedReason);
    await this.prisma.db.marketingCampaign.update({
      where: { id, workspaceId: w.id },
      data: { status: next, pausedAt: null, pausedReason: "", ...(rebase ? { audience: { ...(c.audience as object), guardrailSince: new Date().toISOString() } as never } : {}) },
    });
    if (next === "sending" && !c.startedAt) await this.start(w.id, id);
    await this.audit.record(ctx, { action: "marketing.campaign_resumed", targetType: "marketing_campaign", targetId: id });
    return this.get(ctx, id);
  }

  async cancel(ctx: RequestContext, id: string) {
    const c = await this.find(ctx, id);
    if (!["sending", "scheduled", "paused"].includes(c.status)) throw conflict("Only a sending, scheduled or paused campaign can be canceled.");
    await this.prisma.db.$transaction(async (tx) => {
      await tx.marketingCampaign.update({ where: { id, workspaceId: c.workspaceId }, data: { status: "canceled", canceledAt: new Date() } });
      await tx.marketingSend.updateMany({ where: { workspaceId: c.workspaceId, campaignId: id, status: "queued", sentAt: null }, data: { status: "skipped", error: "Campaign canceled" } });
    });
    await this.audit.record(ctx, { action: "marketing.campaign_canceled", targetType: "marketing_campaign", targetId: id });
    return this.get(ctx, id);
  }

  async recipients(ctx: RequestContext, id: string, q: z.infer<typeof MarketingRecipientsQuery>) {
    const c = await this.find(ctx, id);
    const where: Prisma.MarketingSendWhereInput = { workspaceId: c.workspaceId, campaignId: id, ...(q.status ? { status: q.status } : {}) };
    const [rows, total] = await Promise.all([
      this.prisma.db.marketingSend.findMany({
        where,
        orderBy: { createdAt: "asc" },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
        include: { contact: { select: { id: true, fullName: true } } },
      }),
      this.prisma.db.marketingSend.count({ where }),
    ]);
    return {
      items: rows.map((s) => ({
        id: s.id,
        email: s.email,
        contact: s.contact,
        status: s.status,
        error: s.error,
        sentAt: s.sentAt,
        openedAt: s.openedAt,
        clickedAt: s.clickedAt,
        unsubscribedAt: s.unsubscribedAt,
        bouncedAt: s.bouncedAt,
        complainedAt: s.complainedAt,
      })),
      total,
      page: q.page,
      pageSize: q.pageSize,
    };
  }
}
