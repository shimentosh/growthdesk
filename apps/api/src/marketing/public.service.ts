import { Injectable, Logger } from "@nestjs/common";
import { normalizeEmail, type PreferencesDetails, type PreferencesUpdate } from "@growthdesk/shared";
import type { z } from "zod";
import { PrismaService, type Tx } from "../prisma/prisma.service.js";
import { ConsentService } from "../crm/consent.service.js";
import { ActivityService } from "../crm/activity.service.js";
import { SuppressionService } from "../crm/suppression.service.js";
import { badRequest, notFound } from "../common/errors.js";
import { isAutomatedFetch, redirectTarget } from "../tracking/tracking-rules.js";
import { readMarketingToken } from "./tokens.js";
import { MarketingSenderService } from "./sender.service.js";

export type Fetcher = { method: string; userAgent: string };

const invalidLink = () => notFound("This link");

/*
 * Everything a marketing email's recipient reaches without signing in: the
 * open pixel, tracked clicks, the preference page, the RFC 8058 one-click
 * unsubscribe, and the email service's bounce/complaint notifications. The
 * signed token (or the webhook's secret path) is the only credential; every
 * query below is then scoped to the workspace the send row belongs to.
 */
@Injectable()
export class MarketingPublicService {
  private readonly log = new Logger("marketing-public");

  constructor(
    private readonly prisma: PrismaService,
    private readonly consent: ConsentService,
    private readonly activity: ActivityService,
    private readonly suppression: SuppressionService,
    private readonly sender: MarketingSenderService,
  ) {}

  /** The send a token names. Unscoped by design: the signed token is how we learn the workspace. */
  private send(id: string) {
    return this.prisma.unscoped.marketingSend.findUnique({ where: { id } });
  }

  async open(token: string, who: Fetcher) {
    try {
      const t = readMarketingToken(token, "open");
      if (!t) return;
      const s = await this.send(t.sendId);
      if (!s || isAutomatedFetch({ ...who, sentAt: s.sentAt, now: new Date() })) return;
      await this.prisma.db.marketingSend.updateMany({ where: { id: s.id, workspaceId: s.workspaceId, openedAt: null }, data: { openedAt: new Date() } });
    } catch (e) {
      this.log.warn(`could not record an open: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** Records the click (when a person made it) and returns where to send the browser. */
  async click(token: string, who: Fetcher): Promise<string> {
    const t = readMarketingToken(token, "click");
    const target = t?.kind === "click" ? redirectTarget(t.url) : null;
    if (!t || !target) throw invalidLink();
    try {
      const s = await this.send(t.sendId);
      if (s && !isAutomatedFetch({ ...who, sentAt: s.sentAt, now: new Date() })) {
        const now = new Date();
        await this.prisma.db.marketingSend.updateMany({ where: { id: s.id, workspaceId: s.workspaceId, clickedAt: null }, data: { clickedAt: now } });
        // A click proves the email was opened, even with images blocked.
        await this.prisma.db.marketingSend.updateMany({ where: { id: s.id, workspaceId: s.workspaceId, openedAt: null }, data: { openedAt: now } });
      }
    } catch (e) {
      this.log.warn(`could not record a click: ${e instanceof Error ? e.message : String(e)}`);
    }
    return target;
  }

  private async target(token: string) {
    const t = readMarketingToken(token);
    if (!t || (t.kind !== "preferences" && t.kind !== "unsubscribe")) throw invalidLink();
    const s = await this.send(t.sendId);
    if (!s) throw invalidLink();
    return s;
  }

  async details(token: string): Promise<PreferencesDetails> {
    const s = await this.target(token);
    const { workspaceId, contactId } = s;
    const [ws, contact, memberships] = await Promise.all([
      this.prisma.db.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { name: true, legalName: true } }),
      this.prisma.db.contact.findFirst({ where: { id: contactId, workspaceId }, select: { consentStatus: true } }),
      this.prisma.db.listMembership.findMany({
        where: { workspaceId, contactId, list: { archivedAt: null } },
        include: { list: { select: { id: true, name: true, description: true } } },
        orderBy: { createdAt: "asc" },
      }),
    ]);
    const lists = memberships.map((m) => ({ id: m.list.id, name: m.list.name, description: m.list.description, subscribed: m.status === "subscribed" }));
    return {
      email: s.email,
      workspaceName: ws.name,
      legalName: ws.legalName,
      unsubscribedFromAll: contact?.consentStatus === "denied" || !lists.some((l) => l.subscribed),
      lists,
    };
  }

  /** Leaves every list, withdraws consent and adds a marketing-only suppression (R3). Returns true the first time. */
  private async unsubscribeAllIn(tx: Tx, s: { id: string; workspaceId: string; contactId: string; email: string; campaignId: string }, via: string, ip: string, userAgent: string) {
    const { workspaceId, contactId } = s;
    const now = new Date();
    const left = await tx.listMembership.updateMany({ where: { workspaceId, contactId, status: { not: "unsubscribed" } }, data: { status: "unsubscribed", unsubscribedAt: now } });
    const consentChanged = await this.consent.setIn(tx, { workspaceId, contactId, status: "denied", source: via, ip, userAgent, detail: { via: "preferences", sendId: s.id, campaignId: s.campaignId } });
    await this.suppression.add(workspaceId, "email", s.email, "unsubscribed", via === "One-click unsubscribe" ? "one_click" : "preference_page", null, tx, "marketing");
    await tx.marketingSend.updateMany({ where: { id: s.id, workspaceId, unsubscribedAt: null }, data: { unsubscribedAt: now } });
    const first = left.count > 0 || consentChanged;
    if (first) await this.activity.log({ workspaceId, contactId, type: "marketing.unsubscribed", summary: `Unsubscribed from all marketing email (${via})`, data: { sendId: s.id, campaignId: s.campaignId } }, tx);
    return first;
  }

  /** RFC 8058 one-click: the mail app's own unsubscribe button POSTs here. */
  async oneClick(token: string, ip: string, userAgent: string) {
    const s = await this.target(token);
    await this.prisma.db.$transaction((tx) => this.unsubscribeAllIn(tx, s, "One-click unsubscribe", ip, userAgent));
    await this.sender.refresh(s.workspaceId, s.campaignId).catch(() => undefined);
    return { unsubscribed: true };
  }

  async update(token: string, input: z.infer<typeof PreferencesUpdate>, ip: string, userAgent: string): Promise<PreferencesDetails> {
    const s = await this.target(token);
    const { workspaceId, contactId } = s;
    await this.prisma.db.$transaction(async (tx) => {
      if (input.unsubscribeAll) {
        await this.unsubscribeAllIn(tx, s, "Preference page", ip, userAgent);
        return;
      }
      const now = new Date();
      for (const change of input.lists ?? []) {
        // Only lists this person is on (or was on) can be changed here.
        const m = await tx.listMembership.findFirst({ where: { workspaceId, contactId, listId: change.listId }, include: { list: { select: { name: true, archivedAt: true } } } });
        if (!m || m.list.archivedAt) throw badRequest("That list is not available");
        if (change.subscribed && m.status !== "subscribed") {
          // Choosing to subscribe on their own preference page is consent, given by the person themselves.
          await this.consent.setIn(tx, { workspaceId, contactId, status: "granted", source: "Preference page", ip, userAgent, detail: { via: "preferences", listId: change.listId, sendId: s.id } });
          await tx.suppression.deleteMany({ where: { workspaceId, kind: "email", value: s.email, scope: "marketing", reason: "unsubscribed" } });
          await tx.listMembership.update({ where: { id: m.id, workspaceId }, data: { status: "subscribed", subscribedAt: now, unsubscribedAt: null, source: "Preference page" } });
          await this.activity.log({ workspaceId, contactId, type: "marketing.subscribed", summary: `Re-subscribed to ${m.list.name} (Preference page)`, data: { listId: change.listId } }, tx);
        } else if (!change.subscribed && m.status === "subscribed") {
          await tx.listMembership.update({ where: { id: m.id, workspaceId }, data: { status: "unsubscribed", unsubscribedAt: now } });
          await tx.marketingSend.updateMany({ where: { id: s.id, workspaceId, unsubscribedAt: null }, data: { unsubscribedAt: now } });
          await this.activity.log({ workspaceId, contactId, type: "marketing.unsubscribed", summary: `Unsubscribed from ${m.list.name} (Preference page)`, data: { listId: change.listId } }, tx);
        }
      }
    });
    await this.sender.refresh(workspaceId, s.campaignId).catch(() => undefined);
    return this.details(token);
  }

  // ─── Email service notifications ──────────────────────────────────────────

  /** The workspace a webhook URL belongs to. */
  async webhookWorkspace(token: string) {
    const c = await this.prisma.unscoped.espConnection.findUnique({ where: { webhookToken: token }, select: { workspaceId: true } });
    if (!c) throw notFound("This webhook");
    return c.workspaceId;
  }

  /**
   * A permanent bounce or a spam complaint for one recipient. Matches the send
   * by our id, then the provider's id; suppresses for every engine (bounces
   * and complaints are R3's `all`), and a complaint also withdraws consent.
   */
  async espEvent(workspaceId: string, e: { type: "bounce" | "complaint"; permanent: boolean; email: string; providerMessageId?: string | null; sendId?: string | null }) {
    const email = normalizeEmail(e.email);
    if (!email || (e.type === "bounce" && !e.permanent)) return { matched: false };
    const s =
      (e.sendId ? await this.prisma.db.marketingSend.findFirst({ where: { id: e.sendId, workspaceId } }) : null) ??
      (e.providerMessageId ? await this.prisma.db.marketingSend.findFirst({ where: { workspaceId, providerMessageId: e.providerMessageId } }) : null) ??
      (await this.prisma.db.marketingSend.findFirst({ where: { workspaceId, email, status: { in: ["sent", "bounced", "complained"] } }, orderBy: { sentAt: "desc" } }));
    const now = new Date();
    await this.prisma.db.$transaction(async (tx) => {
      await this.suppression.add(workspaceId, "email", email, e.type === "bounce" ? "bounced" : "complained", "email_service", null, tx, "all");
      if (s) {
        await tx.marketingSend.update({
          where: { id: s.id, workspaceId },
          data: e.type === "bounce" ? { status: "bounced", bouncedAt: now } : { status: "complained", complainedAt: now },
        });
        if (e.type === "bounce") await tx.contact.updateMany({ where: { id: s.contactId, workspaceId, bouncedAt: null }, data: { bouncedAt: now } });
        if (e.type === "complaint") {
          await this.consent.setIn(tx, { workspaceId, contactId: s.contactId, status: "denied", source: "Marked as spam", detail: { via: "complaint", sendId: s.id, campaignId: s.campaignId } });
          await tx.listMembership.updateMany({ where: { workspaceId, contactId: s.contactId, status: "subscribed" }, data: { status: "unsubscribed", unsubscribedAt: now } });
        }
        await this.activity.log(
          { workspaceId, contactId: s.contactId, type: e.type === "bounce" ? "marketing.bounced" : "marketing.complained", summary: e.type === "bounce" ? `Marketing email to ${email} bounced` : `${email} marked a marketing email as spam`, data: { sendId: s.id, campaignId: s.campaignId } },
          tx,
        );
      }
    });
    if (s) {
      await this.sender.refresh(workspaceId, s.campaignId);
      await this.sender.guardrail(workspaceId, s.campaignId);
    }
    return { matched: Boolean(s) };
  }
}
