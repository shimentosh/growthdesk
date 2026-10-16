import { Inject, Injectable } from "@nestjs/common";
import { randomBytes } from "node:crypto";
import type { z } from "zod";
import {
  FROZEN_QUOTE_STATUSES,
  OPEN_QUOTE_STATUSES,
  describeQuoteTotals,
  effectiveQuoteStatus,
  fromUnits,
  quoteNumberLabel,
  quoteTotals,
  quoteTotalsTrouble,
  type QuoteCreateInput,
  type QuoteLineInput,
  type QuoteListQuery,
  type QuoteSendInput,
  type QuoteStatus,
  type QuoteUpdateInput,
  type RecurringPeriod,
} from "@growthdesk/shared";
import { Prisma } from "../generated/prisma/client.js";
import { APP_CONFIG, type AppConfig } from "../config/config.js";
import { PrismaService, type Tx } from "../prisma/prisma.service.js";
import { ActivityService } from "../crm/activity.service.js";
import { OutboundEmailService, type SendEmailResult } from "../messaging/outbound-email.service.js";
import { ApiError, badRequest, conflict, notFound } from "../common/errors.js";
import { actorId, me, ownershipScope, ws, type RequestContext } from "../common/context.js";
import { quoteDocumentHash } from "./quote-document.js";

type LineInputT = z.infer<typeof QuoteLineInput>;

export const quoteInclude = {
  lineItems: { orderBy: { position: "asc" } },
  deal: { select: { id: true, name: true, value: true, currency: true, status: true } },
} satisfies Prisma.QuoteInclude;

export type QuoteRow = Prisma.QuoteGetPayload<{ include: typeof quoteInclude }>;
type QuoteLineRow = QuoteRow["lineItems"][number];

/** People and records a quote points at by id (Quote has no relations to them), looked up in one pass per page. */
type Refs = {
  contacts: Map<string, { id: string; fullName: string; email: string | null; companyId: string | null }>;
  companies: Map<string, { id: string; name: string }>;
  users: Map<string, { id: string; name: string; email: string }>;
};

const QUOTE_SORTS = { number: "number", createdAt: "createdAt", updatedAt: "updatedAt", total: "total", validUntil: "validUntil" } as const;

const sendRefused = (reason: string, details: Record<string, unknown>) => new ApiError(409, "send_failed", reason, undefined, details);
const sendBlocked = (reason: string) => new ApiError(422, "blocked", reason);

/** Today (UTC) plus `days`, as a date-only value. */
export const utcDay = (days = 0, now = new Date()) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + days));
const isoDay = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

/** The stored line rows and cached totals for a list of line inputs. */
export function priceLines(lines: LineInputT[]) {
  const totals = quoteTotals(lines);
  const trouble = quoteTotalsTrouble(totals);
  if (trouble) throw badRequest(trouble, { lineItems: trouble });
  return {
    rows: lines.map((l, i) => ({ ...l, position: i, total: fromUnits(totals.lines[i]!.net) })),
    totals: { subtotal: fromUnits(totals.subtotal), discountTotal: fromUnits(totals.discountTotal), taxTotal: fromUnits(totals.taxTotal), total: fromUnits(totals.total) },
  };
}

/** Totals with the recurring split, read back from a quote's stored lines. */
export function storedTotals(q: Pick<QuoteRow, "lineItems" | "currency">) {
  const t = quoteTotals(q.lineItems.map((l) => ({ quantity: l.quantity.toFixed(2), unitPrice: l.unitPrice.toFixed(2), discountPercent: l.discountPercent.toFixed(2), taxRate: l.taxRate.toFixed(2), billingPeriod: l.billingPeriod })));
  return {
    subtotal: fromUnits(t.subtotal),
    discountTotal: fromUnits(t.discountTotal),
    taxTotal: fromUnits(t.taxTotal),
    total: fromUnits(t.total),
    oneTime: fromUnits(t.oneTime),
    recurring: Object.fromEntries(Object.entries(t.recurring).map(([k, v]) => [k, fromUnits(v)])) as Record<RecurringPeriod, string>,
    summary: describeQuoteTotals(t, q.currency),
    cents: t,
  };
}

export const lineDto = (l: QuoteLineRow) => ({
  id: l.id,
  productId: l.productId,
  position: l.position,
  name: l.name,
  description: l.description,
  quantity: l.quantity.toFixed(2),
  unitPrice: l.unitPrice.toFixed(2),
  discountPercent: l.discountPercent.toFixed(2),
  taxRate: l.taxRate.toFixed(2),
  billingPeriod: l.billingPeriod,
  total: l.total.toFixed(2),
});

/*
 * Quotes: a header (deal, contact, company, owner, currency, dates, intro and
 * terms) and ordered line items, numbered Q-0001… per workspace.
 *
 *   draft → sent (emailed, or the link copied) → viewed (the buyer opened it)
 *         → accepted (signed) | declined;  expired is computed from validUntil;
 *   void withdraws a quote that was not accepted.
 *
 * Editing a sent, viewed, declined or expired quote turns it back into a
 * draft (send it again to reopen it); an accepted quote is frozen — the
 * signature and documentHash cover exactly what was accepted — and so is a
 * void one. Visibility follows deals: without records.view_all a person sees
 * quotes they own and unowned ones.
 */
@Injectable()
export class QuotesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly activity: ActivityService,
    private readonly outbound: OutboundEmailService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  publicUrl(token: string) {
    return `${this.config.PUBLIC_APP_URL.replace(/\/+$/, "")}/q/${token}`;
  }

  private async refs(workspaceId: string, quotes: Pick<QuoteRow, "contactId" | "companyId" | "ownerId" | "createdById">[]): Promise<Refs> {
    const ids = (pick: (q: (typeof quotes)[number]) => (string | null)[]) => [...new Set(quotes.flatMap(pick).filter((x): x is string => Boolean(x)))];
    const [contacts, companies, users] = await Promise.all([
      this.prisma.db.contact.findMany({ where: { workspaceId, id: { in: ids((q) => [q.contactId]) } }, select: { id: true, fullName: true, email: true, companyId: true } }),
      this.prisma.db.company.findMany({ where: { workspaceId, id: { in: ids((q) => [q.companyId]) } }, select: { id: true, name: true } }),
      this.prisma.db.user.findMany({ where: { id: { in: ids((q) => [q.ownerId, q.createdById]) }, memberships: { some: { workspaceId } } }, select: { id: true, name: true, email: true } }),
    ]);
    return { contacts: new Map(contacts.map((c) => [c.id, c])), companies: new Map(companies.map((c) => [c.id, c])), users: new Map(users.map((u) => [u.id, u])) };
  }

  /** A list row: the header and totals, without the lines and text. */
  private rowDto(q: QuoteRow, refs: Refs) {
    const totals = storedTotals(q);
    const contact = q.contactId ? refs.contacts.get(q.contactId) : undefined;
    const company = q.companyId ? refs.companies.get(q.companyId) : undefined;
    const owner = q.ownerId ? refs.users.get(q.ownerId) : undefined;
    return {
      id: q.id,
      number: q.number,
      numberLabel: quoteNumberLabel(q.number),
      title: q.title,
      status: effectiveQuoteStatus(q),
      currency: q.currency,
      subtotal: q.subtotal.toFixed(2),
      discountTotal: q.discountTotal.toFixed(2),
      taxTotal: q.taxTotal.toFixed(2),
      total: q.total.toFixed(2),
      oneTimeTotal: totals.oneTime,
      recurring: totals.recurring,
      summary: totals.summary,
      validUntil: isoDay(q.validUntil),
      deal: q.deal ? { id: q.deal.id, name: q.deal.name } : null,
      contact: contact ? { id: contact.id, fullName: contact.fullName, email: contact.email } : null,
      company: company ?? null,
      owner: owner ? { id: owner.id, name: owner.name || owner.email } : null,
      lineCount: q.lineItems.length,
      sentAt: q.sentAt,
      firstViewedAt: q.firstViewedAt,
      lastViewedAt: q.lastViewedAt,
      viewCount: q.viewCount,
      acceptedAt: q.acceptedAt,
      declinedAt: q.declinedAt,
      signerName: q.signerName,
      createdAt: q.createdAt,
      updatedAt: q.updatedAt,
    };
  }

  /** The whole quote, as the editor reads it. */
  private dto(q: QuoteRow, refs: Refs) {
    const accepted = q.status === "accepted";
    return {
      ...this.rowDto(q, refs),
      storedStatus: q.status,
      intro: q.intro,
      terms: q.terms,
      publicUrl: this.publicUrl(q.publicToken),
      lineItems: q.lineItems.map(lineDto),
      createdBy: q.createdById ? (refs.users.get(q.createdById) ?? null) : null,
      declineReason: q.declineReason,
      acceptance: accepted
        ? {
            signerName: q.signerName,
            signerEmail: q.signerEmail,
            signerTitle: q.signerTitle,
            signatureType: q.signatureData.startsWith("data:image/") ? "drawn" : "typed",
            signature: q.signatureData,
            signerIp: q.signerIp,
            signerUserAgent: q.signerUserAgent,
            documentHash: q.documentHash,
            // Recomputed from the rows as they are now: false would mean the content changed after signing.
            hashMatches: quoteDocumentHash(q) === q.documentHash,
          }
        : null,
    };
  }

  private scope(ctx: RequestContext): Prisma.QuoteWhereInput {
    return ownershipScope(ctx) as Prisma.QuoteWhereInput;
  }

  async find(ctx: RequestContext, id: string, db: PrismaService["db"] | Tx = this.prisma.db) {
    const q = await db.quote.findFirst({ where: { id, workspaceId: ws(ctx).id, deletedAt: null, AND: [this.scope(ctx)] }, include: quoteInclude });
    if (!q) throw notFound("That quote");
    return q;
  }

  async get(ctx: RequestContext, id: string) {
    const q = await this.find(ctx, id);
    return this.dto(q, await this.refs(q.workspaceId, [q]));
  }

  async list(ctx: RequestContext, query: z.infer<typeof QuoteListQuery>) {
    const w = ws(ctx);
    const today = utcDay();
    const and: Prisma.QuoteWhereInput[] = [this.scope(ctx)];
    if (query.status === "expired") and.push({ OR: [{ status: "expired" }, { status: { in: [...OPEN_QUOTE_STATUSES] }, validUntil: { lt: today } }] });
    else if (query.status && OPEN_QUOTE_STATUSES.includes(query.status)) and.push({ status: query.status, OR: [{ validUntil: null }, { validUntil: { gte: today } }] });
    else if (query.status) and.push({ status: query.status });
    if (query.dealId) and.push({ dealId: query.dealId });
    if (query.contactId) and.push({ contactId: query.contactId });
    if (query.ownerId) and.push({ ownerId: query.ownerId === "me" ? me(ctx).userId : query.ownerId });
    const s = query.q?.trim();
    if (s) {
      const n = /^q?-?0*(\d{1,9})$/i.exec(s);
      const contacts = await this.prisma.db.contact.findMany({
        where: { workspaceId: w.id, deletedAt: null, OR: [{ fullName: { contains: s, mode: "insensitive" } }, { email: { contains: s.toLowerCase() } }] },
        select: { id: true },
        take: 200,
      });
      and.push({
        OR: [
          { title: { contains: s, mode: "insensitive" } },
          ...(n ? [{ number: Number(n[1]) }] : []),
          ...(contacts.length ? [{ contactId: { in: contacts.map((c) => c.id) } }] : []),
          { deal: { name: { contains: s, mode: "insensitive" } } },
        ],
      });
    }
    const where: Prisma.QuoteWhereInput = { workspaceId: w.id, deletedAt: null, AND: and };
    const sortField = QUOTE_SORTS[query.sort as keyof typeof QUOTE_SORTS] ?? "number";
    const [rows, total] = await Promise.all([
      this.prisma.db.quote.findMany({ where, include: quoteInclude, orderBy: [{ [sortField]: query.dir }, { id: "desc" }], skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
      this.prisma.db.quote.count({ where }),
    ]);
    const refs = await this.refs(w.id, rows);
    return { items: rows.map((q) => this.rowDto(q, refs)), total, page: query.page, pageSize: query.pageSize };
  }

  /** Every quote on a deal, newest first (the deal page's panel). Seeing the deal is enough to see its quotes. */
  async forDeal(ctx: RequestContext, dealId: string) {
    const w = ws(ctx);
    const deal = await this.prisma.db.deal.findFirst({ where: { id: dealId, workspaceId: w.id, deletedAt: null, ...(ownershipScope(ctx) as Prisma.DealWhereInput) }, select: { id: true } });
    if (!deal) throw notFound("That deal");
    const rows = await this.prisma.db.quote.findMany({ where: { workspaceId: w.id, dealId, deletedAt: null }, include: quoteInclude, orderBy: { number: "desc" }, take: 100 });
    const refs = await this.refs(w.id, rows);
    return rows.map((q) => this.rowDto(q, refs));
  }

  /** Checks the ids a quote points at belong to this workspace (and that the caller may see the deal). */
  private async assertRefs(ctx: RequestContext, input: { dealId?: string | null; contactId?: string | null; companyId?: string | null; ownerId?: string | null; lineItems?: LineInputT[] }) {
    const w = ws(ctx);
    const db = this.prisma.db;
    if (input.dealId && !(await db.deal.findFirst({ where: { id: input.dealId, workspaceId: w.id, deletedAt: null, ...(ownershipScope(ctx) as Prisma.DealWhereInput) }, select: { id: true } }))) throw notFound("That deal");
    if (input.contactId && !(await db.contact.findFirst({ where: { id: input.contactId, workspaceId: w.id, deletedAt: null }, select: { id: true } }))) throw notFound("That contact");
    if (input.companyId && !(await db.company.findFirst({ where: { id: input.companyId, workspaceId: w.id, deletedAt: null }, select: { id: true } }))) throw notFound("That company");
    if (input.ownerId && !(await db.membership.findUnique({ where: { workspaceId_userId: { workspaceId: w.id, userId: input.ownerId } } }))) {
      throw badRequest("A quote's owner must be a member of this workspace", { ownerId: "Not a member" });
    }
    const productIds = [...new Set((input.lineItems ?? []).map((l) => l.productId).filter((x): x is string => Boolean(x)))];
    if (productIds.length && (await db.product.count({ where: { workspaceId: w.id, id: { in: productIds } } })) !== productIds.length) throw notFound("That product");
  }

  /**
   * Inserts a quote under the next number. Two quotes created at once may pick
   * the same number; the unique (workspaceId, number) refuses the second, which
   * simply tries again with the next one.
   */
  private async insertNumbered(workspaceId: string, build: (tx: Tx, number: number) => Promise<{ id: string }>) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.prisma.db.$transaction(async (tx) => {
          const last = await tx.quote.findFirst({ where: { workspaceId }, orderBy: { number: "desc" }, select: { number: true } });
          return build(tx, (last?.number ?? 0) + 1);
        });
      } catch (e) {
        if ((e as { code?: string }).code === "P2002" && attempt < 8) continue;
        throw e;
      }
    }
  }

  async create(ctx: RequestContext, input: z.infer<typeof QuoteCreateInput>) {
    const w = ws(ctx);
    const self = actorId(ctx);
    const deal = input.dealId
      ? await this.prisma.db.deal.findFirst({ where: { id: input.dealId, workspaceId: w.id, deletedAt: null, ...(ownershipScope(ctx) as Prisma.DealWhereInput) } })
      : null;
    if (input.dealId && !deal) throw notFound("That deal");
    const contactId = input.contactId !== undefined ? input.contactId : (deal?.contactId ?? null);
    const contact = contactId ? await this.prisma.db.contact.findFirst({ where: { id: contactId, workspaceId: w.id, deletedAt: null }, select: { fullName: true, companyId: true } }) : null;
    const companyId = input.companyId !== undefined ? input.companyId : (deal?.companyId ?? contact?.companyId ?? null);
    const ownerId = input.ownerId !== undefined ? input.ownerId : (deal?.ownerId ?? self);
    const lines = input.lineItems ?? [];
    await this.assertRefs(ctx, { contactId, companyId, ownerId, lineItems: lines });
    const priced = priceLines(lines);
    const title = input.title?.trim() || deal?.name || (contact?.fullName ? `Quote for ${contact.fullName}` : "New quote");
    const created = await this.insertNumbered(w.id, async (tx, number) => {
      const q = await tx.quote.create({
        data: {
          workspaceId: w.id,
          number,
          dealId: deal?.id ?? null,
          contactId,
          companyId,
          ownerId,
          title,
          currency: input.currency ?? deal?.currency ?? w.currency,
          validUntil: input.validUntil ? new Date(`${input.validUntil}T00:00:00Z`) : input.validUntil === null ? null : utcDay(30),
          intro: input.intro ?? "",
          terms: input.terms ?? "",
          publicToken: randomBytes(24).toString("hex"),
          createdById: self,
          ...priced.totals,
          lineItems: { create: priced.rows.map((r) => ({ ...r, workspaceId: w.id })) },
        },
      });
      if (contactId || q.dealId) {
        await this.activity.log({ workspaceId: w.id, contactId, dealId: q.dealId, companyId, actorId: self, type: "quote.created", summary: `Quote ${quoteNumberLabel(number)} created: ${title}`, data: { quoteId: q.id } }, tx);
      }
      return q;
    });
    return this.get(ctx, created.id);
  }

  async update(ctx: RequestContext, id: string, input: z.infer<typeof QuoteUpdateInput>) {
    const w = ws(ctx);
    const q = await this.find(ctx, id);
    if (FROZEN_QUOTE_STATUSES.includes(q.status as QuoteStatus)) {
      throw conflict(q.status === "accepted" ? "An accepted quote cannot be changed. Duplicate it to make a new version." : "A void quote cannot be changed. Duplicate it to start again.");
    }
    await this.assertRefs(ctx, input);
    const data: Prisma.QuoteUncheckedUpdateInput = {};
    for (const key of ["dealId", "contactId", "companyId", "ownerId", "title", "currency", "intro", "terms"] as const) {
      if (input[key] !== undefined) (data as Record<string, unknown>)[key] = input[key];
    }
    if (input.validUntil !== undefined) data.validUntil = input.validUntil ? new Date(`${input.validUntil}T00:00:00Z`) : null;
    const priced = input.lineItems ? priceLines(input.lineItems) : null;
    if (priced) Object.assign(data, priced.totals);
    // A quote the buyer has (or had) in front of them goes back to draft while it changes; send it again to reopen it.
    const reopened = q.status !== "draft";
    if (reopened) Object.assign(data, { status: "draft", declinedAt: null, declineReason: "" });
    await this.prisma.db.$transaction(async (tx) => {
      // Accepted in the meantime: refuse rather than edit what was signed.
      const claimed = await tx.quote.updateMany({ where: { id, workspaceId: w.id, status: q.status, deletedAt: null }, data });
      if (!claimed.count) throw conflict("The quote changed while you were editing it (it may have been accepted). Reload it and try again.");
      if (priced) {
        await tx.quoteLineItem.deleteMany({ where: { workspaceId: w.id, quoteId: id } });
        await tx.quoteLineItem.createMany({ data: priced.rows.map((r) => ({ ...r, workspaceId: w.id, quoteId: id })) });
      }
      if (reopened && (q.contactId || q.dealId)) {
        await this.activity.log(
          { workspaceId: w.id, contactId: q.contactId, dealId: q.dealId, actorId: actorId(ctx), type: "quote.revised", summary: `Quote ${quoteNumberLabel(q.number)} reopened for changes (was ${effectiveQuoteStatus(q)})`, data: { quoteId: id } },
          tx,
        );
      }
    });
    return this.get(ctx, id);
  }

  /** A new draft with the same header and lines (the way to change an accepted quote). */
  async duplicate(ctx: RequestContext, id: string) {
    const w = ws(ctx);
    const q = await this.find(ctx, id);
    const self = actorId(ctx);
    const validUntil = q.validUntil && q.validUntil >= utcDay() ? q.validUntil : utcDay(30);
    const created = await this.insertNumbered(w.id, (tx, number) =>
      tx.quote.create({
        data: {
          workspaceId: w.id,
          number,
          dealId: q.dealId,
          contactId: q.contactId,
          companyId: q.companyId,
          ownerId: q.ownerId ?? self,
          title: q.title,
          currency: q.currency,
          validUntil,
          intro: q.intro,
          terms: q.terms,
          subtotal: q.subtotal,
          discountTotal: q.discountTotal,
          taxTotal: q.taxTotal,
          total: q.total,
          publicToken: randomBytes(24).toString("hex"),
          createdById: self,
          lineItems: {
            create: q.lineItems.map((l) => ({
              workspaceId: w.id,
              productId: l.productId,
              position: l.position,
              name: l.name,
              description: l.description,
              quantity: l.quantity,
              unitPrice: l.unitPrice,
              discountPercent: l.discountPercent,
              taxRate: l.taxRate,
              billingPeriod: l.billingPeriod,
              total: l.total,
            })),
          },
        },
      }),
    );
    return this.get(ctx, created.id);
  }

  /** Withdraws a quote: its page says so and it can no longer be accepted. An accepted quote cannot be voided. */
  async void(ctx: RequestContext, id: string) {
    const w = ws(ctx);
    const q = await this.find(ctx, id);
    if (q.status === "accepted") throw conflict("An accepted quote cannot be voided.");
    if (q.status === "void") return this.get(ctx, id);
    await this.prisma.db.$transaction(async (tx) => {
      const claimed = await tx.quote.updateMany({ where: { id, workspaceId: w.id, status: q.status }, data: { status: "void" } });
      if (!claimed.count) throw conflict("The quote changed meanwhile (it may have been accepted). Reload it and try again.");
      if (q.contactId || q.dealId) {
        await this.activity.log({ workspaceId: w.id, contactId: q.contactId, dealId: q.dealId, actorId: actorId(ctx), type: "quote.voided", summary: `Quote ${quoteNumberLabel(q.number)} voided`, data: { quoteId: id } }, tx);
      }
    });
    return this.get(ctx, id);
  }

  /** Only a draft that was never sent… or one reopened for changes: whatever is a draft now. */
  async remove(ctx: RequestContext, id: string) {
    const w = ws(ctx);
    const q = await this.find(ctx, id);
    if (q.status !== "draft") throw conflict("Only a draft quote can be deleted. Void it instead.");
    await this.prisma.db.quote.updateMany({ where: { id, workspaceId: w.id, status: "draft" }, data: { deletedAt: new Date() } });
  }

  // ─── Sending ───────────────────────────────────────────────────────────────

  private sendable(q: QuoteRow) {
    const status = effectiveQuoteStatus(q);
    if (status === "accepted") throw conflict("This quote has already been accepted.");
    if (status === "void") throw conflict("This quote is void. Duplicate it to send it again.");
    if (status === "declined") throw conflict("The buyer declined this quote. Edit it (which reopens it as a draft) before sending it again.");
    if (status === "expired") throw conflict("This quote has expired. Change its valid-until date before sending it again.", { validUntil: "In the past" });
    if (!q.lineItems.length) throw badRequest("Add at least one line before sending the quote.", { lineItems: "Required" });
  }

  /** Marks a draft as sent (the buyer can now open, accept or decline it); a sent or viewed quote keeps its status. */
  private async markSent(tx: Tx, q: QuoteRow, now: Date) {
    const data: Prisma.QuoteUpdateManyMutationInput = { sentAt: now };
    if (q.status === "draft") data.status = "sent";
    const claimed = await tx.quote.updateMany({ where: { id: q.id, workspaceId: q.workspaceId, status: q.status }, data });
    if (!claimed.count) throw conflict("The quote changed meanwhile. Reload it and try again.");
  }

  /** What the send dialog offers: the connected mailboxes, the one used by default, and the default recipient and wording. */
  async sendOptions(ctx: RequestContext, id: string) {
    const w = ws(ctx);
    const q = await this.find(ctx, id);
    const refs = await this.refs(w.id, [q]);
    const mailboxes = await this.prisma.db.mailbox.findMany({
      where: { workspaceId: w.id, deletedAt: null, status: "connected" },
      select: { id: true, email: true, displayName: true, createdById: true },
      orderBy: { createdAt: "asc" },
    });
    const contact = q.contactId ? refs.contacts.get(q.contactId) : undefined;
    const owner = q.ownerId ? refs.users.get(q.ownerId) : undefined;
    const defaultMailbox = (await this.defaultMailbox(w.id, q, mailboxes)) ?? null;
    return {
      mailboxes: mailboxes.map(({ createdById: _c, ...m }) => m),
      defaultMailboxId: defaultMailbox,
      to: contact?.email ?? "",
      toName: contact?.fullName ?? "",
      subject: `Quote ${quoteNumberLabel(q.number)}: ${q.title}`,
      message: `Hi${contact?.fullName ? ` ${contact.fullName.split(/\s+/)[0]}` : ""},\n\nHere is the quote we discussed. You can review it, and accept it online, using the link below.\n\nThanks,\n${owner?.name ?? ""}`.trim(),
      publicUrl: this.publicUrl(q.publicToken),
    };
  }

  /** The owner's own connected mailbox, else the connected one with the most room today. */
  private async defaultMailbox(workspaceId: string, q: Pick<QuoteRow, "ownerId" | "createdById">, boxes?: { id: string; createdById: string | null }[]) {
    const connected = boxes ?? (await this.prisma.db.mailbox.findMany({ where: { workspaceId, deletedAt: null, status: "connected" }, select: { id: true, createdById: true }, orderBy: { createdAt: "asc" } }));
    const own = connected.find((b) => b.createdById && b.createdById === (q.ownerId ?? q.createdById));
    if (own) return own.id;
    return (await this.outbound.pickMailbox(workspaceId, []))?.id ?? connected[0]?.id;
  }

  /**
   * Emails the buyer a link to the quote's public page from one of the
   * workspace's own mailboxes, through OutboundEmailService like any 1:1
   * email: it is filed in the contact's conversations (on the deal too), and
   * a quote sent again is threaded onto the earlier email about it.
   */
  async send(ctx: RequestContext, id: string, input: z.infer<typeof QuoteSendInput>) {
    const w = ws(ctx);
    const author = me(ctx).userId;
    const q = await this.find(ctx, id);
    this.sendable(q);
    const contact = q.contactId ? await this.prisma.db.contact.findFirst({ where: { id: q.contactId, workspaceId: w.id, deletedAt: null }, select: { id: true, email: true, fullName: true } }) : null;
    const to = input.to ?? contact?.email ?? "";
    if (!to) throw badRequest("The quote has no contact with an email address. Choose a contact, or enter the address to send it to.", { to: "Required" });
    let mailboxId = input.mailboxId ?? null;
    if (mailboxId) {
      if (!(await this.prisma.db.mailbox.findFirst({ where: { id: mailboxId, workspaceId: w.id, deletedAt: null }, select: { id: true } }))) throw notFound("That mailbox");
    } else {
      mailboxId = (await this.defaultMailbox(w.id, q)) ?? null;
      if (!mailboxId) throw conflict("Connect a mailbox before sending a quote by email, or copy its link instead.");
    }
    // Only a person on the quote's contact gets threaded into that contact's conversations.
    const toContact = contact && contact.email && contact.email.toLowerCase() === to.toLowerCase() ? contact : null;
    const previous = await this.previousSend(w.id, q.id, mailboxId);
    const url = this.publicUrl(q.publicToken);
    const message = input.message?.trim() ?? "";
    const subject = input.subject?.trim() || `Quote ${quoteNumberLabel(q.number)}: ${q.title}`;
    const body = [message, `View and accept quote ${quoteNumberLabel(q.number)} (${storedTotals(q).summary}): ${url}`].filter(Boolean).join("\n\n");
    const result = await this.outbound.send({
      workspaceId: w.id,
      mailboxId,
      to,
      toName: toContact?.fullName || undefined,
      subject,
      body,
      contactId: toContact?.id ?? null,
      conversationId: previous?.conversationId ?? null,
      inReplyTo: previous?.providerMessageId ?? null,
      authorId: author,
      kind: "manual",
    });
    if (result.status !== "sent") this.refused(result);
    const now = new Date();
    await this.prisma.db.$transaction(async (tx) => {
      await this.markSent(tx, q, now);
      await tx.conversation.updateMany({ where: { id: result.conversationId, workspaceId: w.id, dealId: null }, data: { dealId: q.dealId } });
      await this.activity.log(
        {
          workspaceId: w.id,
          contactId: q.contactId,
          dealId: q.dealId,
          actorId: author,
          type: "quote.sent",
          summary: `Quote ${quoteNumberLabel(q.number)} sent to ${to}`,
          data: { quoteId: q.id, messageId: result.messageRowId, conversationId: result.conversationId, mailboxId, to },
        },
        tx,
      );
    });
    return this.get(ctx, id);
  }

  /** The last email this quote went out in from the same mailbox, to thread a re-send onto. */
  private async previousSend(workspaceId: string, quoteId: string, mailboxId: string) {
    const sent = await this.prisma.db.activity.findMany({
      where: { workspaceId, type: "quote.sent", data: { path: ["quoteId"], equals: quoteId } },
      orderBy: { occurredAt: "desc" },
      take: 5,
      select: { data: true },
    });
    for (const a of sent) {
      const d = a.data as { messageId?: string; mailboxId?: string };
      if (!d.messageId || d.mailboxId !== mailboxId) continue;
      const m = await this.prisma.db.message.findFirst({ where: { id: d.messageId, workspaceId, status: { in: ["sent", "delivered", "read"] } }, select: { conversationId: true, providerMessageId: true } });
      if (m?.providerMessageId) return m;
    }
    return null;
  }

  private refused(result: Exclude<SendEmailResult, { status: "sent" }>): never {
    if (result.status === "blocked") throw sendBlocked(result.reason);
    throw sendRefused(result.reason, { status: result.status, messageId: "messageRowId" in result ? (result.messageRowId ?? null) : null });
  }

  /** "Copy link": the quote is shared some other way. A draft becomes sent so the buyer can act on it. */
  async shareLink(ctx: RequestContext, id: string) {
    const w = ws(ctx);
    const q = await this.find(ctx, id);
    this.sendable(q);
    await this.prisma.db.$transaction(async (tx) => {
      await this.markSent(tx, q, q.sentAt && q.status !== "draft" ? q.sentAt : new Date());
      if (q.status === "draft" && (q.contactId || q.dealId)) {
        await this.activity.log({ workspaceId: w.id, contactId: q.contactId, dealId: q.dealId, actorId: actorId(ctx), type: "quote.shared", summary: `Quote ${quoteNumberLabel(q.number)} link shared`, data: { quoteId: q.id } }, tx);
      }
    });
    return { url: this.publicUrl(q.publicToken), quote: await this.get(ctx, id) };
  }
}
