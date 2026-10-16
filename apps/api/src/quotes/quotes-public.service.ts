import { Injectable, Logger } from "@nestjs/common";
import type { z } from "zod";
import {
  OPEN_QUOTE_STATUSES,
  effectiveQuoteStatus,
  quoteNumberLabel,
  type BillingPeriod,
  type QuoteAcceptInput,
  type QuoteDeclineInput,
  type QuotePublicView,
  type QuoteStatus,
} from "@growthdesk/shared";
import { Prisma } from "../generated/prisma/client.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { ActivityService } from "../crm/activity.service.js";
import { EventsService } from "../core/events.service.js";
import { BrandingService } from "../core/branding.service.js";
import { NotificationsService } from "../notifications/notifications.service.js";
import { conflict, notFound } from "../common/errors.js";
import type { RequestContext } from "../common/context.js";
import { quoteDocumentHash } from "./quote-document.js";
import { lineDto, quoteInclude, storedTotals, utcDay, type QuoteRow } from "./quotes.service.js";

const TOKEN = /^[0-9a-f]{48}$/;

/** Why a quote in this state cannot be accepted or declined. */
function closedReason(status: QuoteStatus, q: Pick<QuoteRow, "validUntil">): string {
  switch (status) {
    case "accepted":
      return "This quote has already been accepted.";
    case "declined":
      return "This quote was declined.";
    case "expired":
      return `This quote expired on ${q.validUntil?.toISOString().slice(0, 10) ?? "its valid-until date"}. Ask the sender for a new one.`;
    case "void":
      return "This quote was withdrawn by the sender.";
    default:
      return "This quote is being updated by the sender. You'll get the new version shortly.";
  }
}

/*
 * The buyer's side of a quote, reached at /q/<publicToken> without signing in:
 * the document, "Accept and sign" and "Decline". The 48-hex-character token is
 * the only credential (unguessable, one per quote); every query after the
 * token lookup is scoped to the quote's own workspace.
 *
 * What an acceptance here records — and so what it can prove: the name, email
 * and title the signer typed, their typed or drawn signature, that they ticked
 * "I agree", the time, their IP address and browser, and a sha256 of the
 * quote's content (quote-document.ts). It shows that someone holding the link
 * accepted exactly this content at that moment. It does not verify who that
 * person is (no identity check, no certificate-backed signature), so it is an
 * electronic acceptance, not a qualified/advanced e-signature.
 */
@Injectable()
export class QuotesPublicService {
  private readonly log = new Logger("quotes-public");

  constructor(
    private readonly prisma: PrismaService,
    private readonly activity: ActivityService,
    private readonly events: EventsService,
    private readonly branding: BrandingService,
    private readonly notifications: NotificationsService,
  ) {}

  /** The quote a token names. Unscoped by design: the token is how we learn the workspace. */
  private async byToken(token: string) {
    if (!TOKEN.test(token)) throw notFound("This quote");
    const q = await this.prisma.unscoped.quote.findUnique({ where: { publicToken: token }, include: quoteInclude });
    if (!q || q.deletedAt) throw notFound("This quote");
    return q;
  }

  /** People of the quote's own workspace previewing it are not "the buyer viewed it". */
  private async isTeammate(workspaceId: string, ctx: RequestContext) {
    if (!ctx.identity) return false;
    return Boolean(await this.prisma.db.membership.findUnique({ where: { workspaceId_userId: { workspaceId, userId: ctx.identity.userId } }, select: { userId: true } }));
  }

  private ownerOf(q: Pick<QuoteRow, "ownerId" | "createdById">) {
    return q.ownerId ?? q.createdById;
  }

  async view(token: string, ctx: RequestContext): Promise<QuotePublicView> {
    let q = await this.byToken(token);
    const status = effectiveQuoteStatus(q);
    if (OPEN_QUOTE_STATUSES.includes(status) && !(await this.isTeammate(q.workspaceId, ctx))) {
      const now = new Date();
      const first = await this.prisma.db.quote.updateMany({ where: { id: q.id, workspaceId: q.workspaceId, firstViewedAt: null }, data: { firstViewedAt: now } });
      await this.prisma.db.quote.updateMany({ where: { id: q.id, workspaceId: q.workspaceId, status: "sent" }, data: { status: "viewed" } });
      await this.prisma.db.quote.updateMany({ where: { id: q.id, workspaceId: q.workspaceId }, data: { viewCount: { increment: 1 }, lastViewedAt: now } });
      if (first.count) {
        const label = quoteNumberLabel(q.number);
        if (q.contactId || q.dealId) {
          await this.activity.log({ workspaceId: q.workspaceId, contactId: q.contactId, dealId: q.dealId, type: "quote.viewed", summary: `Quote ${label} opened by the buyer`, data: { quoteId: q.id } });
        }
        const owner = this.ownerOf(q);
        if (owner) await this.notifications.notify(q.workspaceId, [owner], { type: "quote.viewed", title: `Quote ${label} was opened`, body: q.title, link: `/w/${q.workspaceId}/quotes/${q.id}` });
      }
      q = await this.byToken(token);
    }
    return this.viewModel(q);
  }

  private async viewModel(q: QuoteRow): Promise<QuotePublicView> {
    const status = effectiveQuoteStatus(q);
    const [workspace, contact, company, owner, brand] = await Promise.all([
      this.prisma.db.workspace.findUnique({ where: { id: q.workspaceId }, select: { name: true, legalName: true, postalAddress: true } }),
      q.contactId ? this.prisma.db.contact.findFirst({ where: { id: q.contactId, workspaceId: q.workspaceId }, select: { fullName: true, email: true } }) : null,
      q.companyId ? this.prisma.db.company.findFirst({ where: { id: q.companyId, workspaceId: q.workspaceId }, select: { name: true } }) : null,
      this.ownerOf(q) ? this.prisma.db.user.findUnique({ where: { id: this.ownerOf(q)! }, select: { name: true, email: true } }) : null,
      this.branding.get(),
    ]);
    // A draft (being revised) or a withdrawn quote shows who it is from, not its content.
    const hidden = status === "draft" || status === "void";
    const totals = storedTotals(q);
    const accepted = q.status === "accepted";
    return {
      number: quoteNumberLabel(q.number),
      title: q.title,
      status,
      currency: q.currency,
      validUntil: q.validUntil ? q.validUntil.toISOString().slice(0, 10) : null,
      sentAt: q.sentAt?.toISOString() ?? null,
      intro: hidden ? "" : q.intro,
      terms: hidden ? "" : q.terms,
      from: {
        workspaceName: workspace?.name ?? "",
        legalName: workspace?.legalName ?? "",
        postalAddress: workspace?.postalAddress ?? "",
        senderName: owner?.name ?? "",
        senderEmail: owner?.email ?? "",
      },
      to: { name: contact?.fullName ?? "", email: contact?.email ?? "", company: company?.name ?? "" },
      lineItems: hidden
        ? []
        : q.lineItems.map((l) => {
            const { id: _id, productId: _p, position: _pos, ...rest } = lineDto(l);
            return { ...rest, billingPeriod: rest.billingPeriod as BillingPeriod };
          }),
      totals: hidden
        ? { subtotal: "0.00", discountTotal: "0.00", taxTotal: "0.00", total: "0.00", oneTime: "0.00", recurring: { monthly: "0.00", quarterly: "0.00", yearly: "0.00" }, summary: "" }
        : { subtotal: totals.subtotal, discountTotal: totals.discountTotal, taxTotal: totals.taxTotal, total: totals.total, oneTime: totals.oneTime, recurring: totals.recurring, summary: totals.summary },
      acceptance:
        accepted && q.acceptedAt
          ? {
              signerName: q.signerName,
              signerTitle: q.signerTitle,
              signerEmail: q.signerEmail,
              acceptedAt: q.acceptedAt.toISOString(),
              signatureType: q.signatureData.startsWith("data:image/") ? "drawn" : "typed",
              signature: q.signatureData,
              documentHash: q.documentHash,
            }
          : null,
      declinedAt: q.status === "declined" ? (q.declinedAt?.toISOString() ?? null) : null,
      productName: brand.productName,
    };
  }

  /**
   * Accept and sign. Refused unless the quote is open (sent or viewed, and not
   * past its valid-until date). The status change is claimed with a
   * conditional update, so two acceptances at once record exactly one.
   *
   * Deal rule: a deal still valued at 0 takes the quote's one-time total (or,
   * for a quote with only recurring lines, its total); a deal someone already
   * valued is left alone.
   */
  async accept(token: string, input: z.infer<typeof QuoteAcceptInput>, ctx: RequestContext) {
    const q = await this.byToken(token);
    const status = effectiveQuoteStatus(q);
    if (!OPEN_QUOTE_STATUSES.includes(status)) throw conflict(closedReason(status, q));
    const now = new Date();
    const label = quoteNumberLabel(q.number);
    let totals = storedTotals(q);
    const owner = this.ownerOf(q);
    let hash = "";
    await this.prisma.db.$transaction(async (tx) => {
      const claimed = await tx.quote.updateMany({
        where: { id: q.id, workspaceId: q.workspaceId, status: { in: [...OPEN_QUOTE_STATUSES] }, OR: [{ validUntil: null }, { validUntil: { gte: utcDay() } }] },
        data: {
          status: "accepted",
          acceptedAt: now,
          signerName: input.signerName,
          signerEmail: input.signerEmail,
          signerTitle: input.signerTitle ?? "",
          signatureData: input.signature.data,
          signerIp: ctx.ip.slice(0, 100),
          signerUserAgent: ctx.userAgent.slice(0, 500),
        },
      });
      if (!claimed.count) throw conflict("This quote changed while you were reading it. Reload the page to see the current version.");
      // Hashed from the rows as they stand now, inside the transaction that locked them: exactly what was accepted.
      const signed = await tx.quote.findFirstOrThrow({ where: { id: q.id, workspaceId: q.workspaceId }, include: quoteInclude });
      hash = quoteDocumentHash(signed);
      totals = storedTotals(signed);
      await tx.quote.updateMany({ where: { id: q.id, workspaceId: q.workspaceId }, data: { documentHash: hash } });
      let dealValueSet: string | null = null;
      if (q.dealId) {
        const value = totals.cents.oneTime > 0 ? totals.oneTime : totals.total;
        const updated = await tx.deal.updateMany({ where: { id: q.dealId, workspaceId: q.workspaceId, value: 0, deletedAt: null }, data: { value: new Prisma.Decimal(value) } });
        if (updated.count) dealValueSet = value;
      }
      await this.activity.log(
        {
          workspaceId: q.workspaceId,
          contactId: q.contactId,
          dealId: q.dealId,
          companyId: q.companyId,
          type: "quote.accepted",
          summary: `Quote ${label} accepted and signed by ${input.signerName}${input.signerTitle ? `, ${input.signerTitle}` : ""}`,
          data: { quoteId: q.id, signerEmail: input.signerEmail, documentHash: hash, total: totals.total, currency: q.currency, dealValueSet },
          occurredAt: now,
        },
        tx,
      );
      await tx.task.create({
        data: {
          workspaceId: q.workspaceId,
          type: "follow_up",
          title: `Quote ${label} accepted — close the deal`,
          description: `${input.signerName} (${input.signerEmail}) accepted "${q.title}" for ${totals.summary}.`,
          priority: "high",
          dueAt: new Date(now.getTime() + 86_400_000),
          assigneeId: owner,
          contactId: q.contactId,
          dealId: q.dealId,
          source: "system",
        },
      });
      await this.events.emitIn(tx, {
        workspaceId: q.workspaceId,
        type: "quote.accepted",
        subjectType: "quote",
        subjectId: q.id,
        payload: { quoteId: q.id, quoteNumber: label, dealId: q.dealId, contactId: q.contactId, total: totals.total, currency: q.currency },
      });
    });
    await this.events.kick();
    if (owner) {
      await this.notifications.notify(q.workspaceId, [owner], {
        type: "quote.accepted",
        title: `Quote ${label} accepted by ${input.signerName}`,
        body: `${q.title} — ${totals.summary}`,
        link: `/w/${q.workspaceId}/quotes/${q.id}`,
        email: true,
      });
    }
    this.log.log(`quote ${q.id} accepted (workspace ${q.workspaceId})`);
    return this.viewModel(await this.byToken(token));
  }

  async decline(token: string, input: z.infer<typeof QuoteDeclineInput>) {
    const q = await this.byToken(token);
    const status = effectiveQuoteStatus(q);
    if (!OPEN_QUOTE_STATUSES.includes(status)) throw conflict(closedReason(status, q));
    const now = new Date();
    const label = quoteNumberLabel(q.number);
    await this.prisma.db.$transaction(async (tx) => {
      const claimed = await tx.quote.updateMany({ where: { id: q.id, workspaceId: q.workspaceId, status: { in: [...OPEN_QUOTE_STATUSES] } }, data: { status: "declined", declinedAt: now, declineReason: input.reason } });
      if (!claimed.count) throw conflict("This quote changed while you were reading it. Reload the page to see the current version.");
      if (q.contactId || q.dealId) {
        await this.activity.log(
          { workspaceId: q.workspaceId, contactId: q.contactId, dealId: q.dealId, type: "quote.declined", summary: `Quote ${label} declined${input.reason ? `: ${input.reason}` : ""}`, data: { quoteId: q.id, reason: input.reason } },
          tx,
        );
      }
    });
    const owner = this.ownerOf(q);
    if (owner) {
      await this.notifications.notify(q.workspaceId, [owner], { type: "quote.declined", title: `Quote ${label} was declined`, body: input.reason || q.title, link: `/w/${q.workspaceId}/quotes/${q.id}`, email: true });
    }
    return this.viewModel(await this.byToken(token));
  }
}
