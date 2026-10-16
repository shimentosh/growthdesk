import { Injectable, Logger } from "@nestjs/common";
import type { z } from "zod";
import { Prisma } from "../generated/prisma/client.js";
import {
  CustomerInput,
  OrderInput,
  isUnlimited,
  type CommerceSyncResult,
  type ContactOrder,
  type CustomerInputT,
  type CustomersSyncInput,
  type OrderInputT,
  type OrdersSyncInput,
  type OrderState,
} from "@growthdesk/shared";
import { PrismaService, type Tx } from "../prisma/prisma.service.js";
import { EntitlementsService } from "../billing/entitlements.service.js";
import { EventsService } from "../core/events.service.js";
import { ContactsService } from "../crm/contacts.service.js";
import { actorId, ws, type RequestContext } from "../common/context.js";
import { isApiError, notFound } from "../common/errors.js";

type Result = CommerceSyncResult["results"][number];

/** Why a record failed its checks, field by field. */
function invalid(error: z.ZodError): string {
  return error.issues
    .slice(0, 3)
    .map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message))
    .join("; ");
}

const rawExternalId = (raw: unknown): string | null => {
  const v = raw && typeof raw === "object" ? (raw as Record<string, unknown>).externalId : undefined;
  return typeof v === "string" && v.trim() ? v.trim().slice(0, 200) : null;
};

const money = (n: number) => new Prisma.Decimal(n.toFixed(2));

/** JSON with sorted keys: Postgres keeps jsonb keys in its own order, so compare by content. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as object)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/** A contact's status once they have paid for something: unless the team put them somewhere on purpose. */
const KEEP_STATUS = new Set(["customer", "not_interested", "do_not_contact"]);

/*
 * Clients and orders from a client portal (Clientdesk), kept in step by the
 * sender (docs/BUSINESS_OS_API.md § Commerce). Each record is upserted by
 * (source, externalId) and checked on its own, so one bad record fails alone.
 *
 * A client is a contact like any other (ContactsService.upsert: matched by its
 * external id, then email, then phone; blanks filled, never overwritten),
 * whose company is the sender's company (Company.externalSource/externalId).
 * Becoming a client moves a lead on to the "contact" stage — never back — and
 * stamps `customerSince`. An order is an Order row; after each batch the
 * totals on the contacts it touched are counted again from their orders
 * (ordersCount, paidOrdersCount, totalSpent, first/last order, last purchase),
 * and a contact with a paid order is a customer.
 *
 * Events for workflows, webhooks and Discord: `client.added` when a contact
 * first becomes a client; `order.created`, `order.paid`, `order.completed` and
 * `order.cancelled` as an order reaches each, once.
 */
@Injectable()
export class CommerceService {
  private readonly log = new Logger("commerce");

  constructor(
    private readonly prisma: PrismaService,
    private readonly entitlements: EntitlementsService,
    private readonly events: EventsService,
    private readonly contacts: ContactsService,
  ) {}

  // ─── Clients ──────────────────────────────────────────────────────────────

  async syncCustomers(ctx: RequestContext, input: z.infer<typeof CustomersSyncInput>): Promise<CommerceSyncResult> {
    const w = ws(ctx);
    await this.entitlements.assertFeature(w.billingAccountId, "apiAccess");
    await this.entitlements.assertFullAccess(w.billingAccountId, "Syncing clients");
    const defaultCountry = await this.contacts.defaultCountry(w.id);
    let remaining = await this.entitlements.remaining(w.billingAccountId, "contacts");
    const results: Result[] = [];

    for (const [index, raw] of input.customers.entries()) {
      const parsed = CustomerInput.safeParse(raw);
      if (!parsed.success) {
        results.push({ index, externalId: rawExternalId(raw), status: "failed", contactId: null, error: { code: "validation_failed", message: invalid(parsed.error) } });
        continue;
      }
      const c = parsed.data;
      try {
        const companyId = c.company ? await this.company(w.id, input.source, c.company, actorId(ctx)) : null;
        const res = await this.contacts.upsert(
          w.id,
          w.billingAccountId,
          {
            ...(c.fullName ? { fullName: c.fullName } : {}),
            ...(c.firstName ? { firstName: c.firstName } : {}),
            ...(c.lastName ? { lastName: c.lastName } : {}),
            ...(c.email ? { email: c.email } : {}),
            ...(c.phone ? { phone: c.phone } : {}),
            ...(c.country ? { country: c.country } : {}),
            ...(companyId ? { companyId } : {}),
            leadSource: "Clientdesk · Client",
            lifecycleStage: "contact",
          },
          {
            source: input.source,
            externalId: c.externalId,
            sourceData: { ...(c.data ?? {}), ...(c.status ? { clientStatus: c.status } : {}) },
            onDuplicate: "update",
            defaultCountry,
            actorId: actorId(ctx),
            capacityChecked: true,
            emitEvent: "contact.created",
            createBlocked: !isUnlimited(remaining) && remaining <= 0 ? "Your plan's contact limit is reached; this client was not added. Upgrade to add more contacts." : undefined,
          },
        );
        if (res.created) remaining -= 1;
        const promoted = await this.becameClient(w.id, res.contactId, c, companyId, actorId(ctx));
        results.push({ index, externalId: c.externalId, status: res.created ? "created" : res.updated || promoted ? "updated" : "unchanged", contactId: res.contactId, error: null });
      } catch (e) {
        if (!isApiError(e)) this.log.warn(`client ${c.externalId}: ${e instanceof Error ? e.message : String(e)}`);
        results.push({ index, externalId: c.externalId, status: "failed", contactId: null, error: isApiError(e) ? { code: e.code, message: e.message } : { code: "server_error", message: "This client could not be saved. Try it again." } });
      }
    }
    await this.events.kick();
    return { summary: summarize(results, input.customers.length), results };
  }

  /** The sender's company, by its id; else matched by domain or name (and claimed); else made. */
  private async company(workspaceId: string, source: string, c: NonNullable<CustomerInputT["company"]>, actor: string | null): Promise<string | null> {
    return this.prisma.db.$transaction(async (tx) => {
      const mine = await tx.company.findFirst({ where: { workspaceId, externalSource: source, externalId: c.externalId, deletedAt: null } });
      if (mine) {
        if (mine.name !== c.name) await tx.company.update({ where: { id: mine.id, workspaceId }, data: { name: c.name } });
        return mine.id;
      }
      const found = await this.contacts.findOrCreateCompany(tx, workspaceId, { name: c.name, domain: c.domain ?? null, country: c.country }, actor);
      if (!found) return null;
      if (!found.externalId) await tx.company.update({ where: { id: found.id, workspaceId }, data: { externalSource: source, externalId: c.externalId } });
      return found.id;
    });
  }

  /**
   * A client is past being a lead: the contact moves to the "contact" stage
   * (never back), takes the company when it has none, and is stamped a client
   * once — which is the `client.added` event. True when anything changed.
   */
  private async becameClient(workspaceId: string, contactId: string, c: CustomerInputT, companyId: string | null, actor: string | null): Promise<boolean> {
    return this.prisma.db.$transaction(async (tx) => {
      const row = await tx.contact.findFirst({ where: { id: contactId, workspaceId }, select: { lifecycleStage: true, customerSince: true, companyId: true } });
      if (!row) return false;
      const data: Prisma.ContactUpdateInput = {};
      if (row.lifecycleStage !== "contact") {
        data.lifecycleStage = "contact";
        data.stageChangedAt = new Date();
      }
      if (!row.companyId && companyId) data.company = { connect: { id: companyId } };
      if (!row.customerSince) data.customerSince = c.since ?? new Date();
      if (!Object.keys(data).length) return false;
      await tx.contact.update({ where: { id: contactId, workspaceId }, data });
      if (!row.customerSince) {
        await this.events.emitIn(tx, { workspaceId, type: "client.added", subjectType: "contact", subjectId: contactId, actorId: actor, payload: { contactId, externalId: c.externalId, since: (c.since ?? new Date()).toISOString() } });
      }
      return true;
    });
  }

  // ─── Orders ───────────────────────────────────────────────────────────────

  async syncOrders(ctx: RequestContext, input: z.infer<typeof OrdersSyncInput>): Promise<CommerceSyncResult> {
    const w = ws(ctx);
    await this.entitlements.assertFeature(w.billingAccountId, "apiAccess");
    await this.entitlements.assertFullAccess(w.billingAccountId, "Syncing orders");
    const results: Result[] = [];
    const touched = new Set<string>();

    for (const [index, raw] of input.orders.entries()) {
      const parsed = OrderInput.safeParse(raw);
      if (!parsed.success) {
        results.push({ index, externalId: rawExternalId(raw), status: "failed", contactId: null, error: { code: "validation_failed", message: invalid(parsed.error) } });
        continue;
      }
      const o = parsed.data;
      try {
        const { status, contactId, previousContactId } = await this.upsertOrder(w.id, input.source, o, actorId(ctx));
        if (contactId) touched.add(contactId);
        if (previousContactId) touched.add(previousContactId);
        results.push({ index, externalId: o.externalId, status, contactId, error: null });
      } catch (e) {
        if (!isApiError(e)) this.log.warn(`order ${o.externalId}: ${e instanceof Error ? e.message : String(e)}`);
        results.push({ index, externalId: o.externalId, status: "failed", contactId: null, error: isApiError(e) ? { code: e.code, message: e.message } : { code: "server_error", message: "This order could not be saved. Try it again." } });
      }
    }
    for (const id of touched) await this.recount(w.id, id);
    await this.events.kick();
    return { summary: summarize(results, input.orders.length), results };
  }

  /** The contact a client's id names (forwarding a merged contact; a deleted one is nobody). */
  private async contactOf(tx: Tx, workspaceId: string, source: string, externalId: string | undefined): Promise<{ id: string; companyId: string | null } | null> {
    if (!externalId) return null;
    const src = await tx.contactSource.findFirst({ where: { workspaceId, source, externalId }, select: { contactId: true } });
    if (!src) return null;
    let c = await tx.contact.findFirst({ where: { id: src.contactId, workspaceId }, select: { id: true, companyId: true, mergedIntoId: true, deletedAt: true } });
    if (c?.mergedIntoId) c = await tx.contact.findFirst({ where: { id: c.mergedIntoId, workspaceId }, select: { id: true, companyId: true, mergedIntoId: true, deletedAt: true } });
    return c && !c.deletedAt ? { id: c.id, companyId: c.companyId } : null;
  }

  private async upsertOrder(workspaceId: string, source: string, o: OrderInputT, actor: string | null) {
    // The company first, in its own transaction, like a client's.
    const ownCompanyId = o.company ? await this.company(workspaceId, source, o.company, actor) : null;
    return this.prisma.db.$transaction(async (tx) => {
      const contact = await this.contactOf(tx, workspaceId, source, o.customerExternalId);
      const companyId = ownCompanyId ?? contact?.companyId ?? null;
      const productIds = await this.productIds(tx, workspaceId, source, o.items.map((i) => i.productExternalId).filter((x): x is string => Boolean(x)));
      const items = o.items.map((i) => ({ ...i, ...(i.productExternalId && productIds.get(i.productExternalId) ? { productId: productIds.get(i.productExternalId) } : {}) }));
      const at = (d: Date | null | undefined) => d ?? null;
      const fields = {
        number: o.number,
        contactId: contact?.id ?? null,
        companyId,
        status: o.status,
        state: o.state,
        paid: o.paid,
        currency: o.currency,
        total: money(o.total),
        items: items as unknown as Prisma.InputJsonValue,
        placedAt: o.placedAt,
        paidAt: o.paid ? (at(o.paidAt) ?? o.placedAt) : null,
        completedAt: at(o.completedAt) ?? (o.state === "completed" ? new Date() : null),
        cancelledAt: at(o.cancelledAt) ?? (o.state === "cancelled" ? new Date() : null),
        data: (o.data ?? {}) as Prisma.InputJsonValue,
      };

      const existing = await tx.order.findUnique({ where: { workspaceId_source_externalId: { workspaceId, source, externalId: o.externalId } } });
      // Events name the contact when there is one (workflows and Discord read the contact); else the order.
      const event = (type: string, orderId: string) =>
        this.events.emitIn(tx, {
          workspaceId,
          type,
          subjectType: contact ? "contact" : "order",
          subjectId: contact?.id ?? orderId,
          actorId: actor,
          payload: { orderId, contactId: contact?.id ?? null, orderNumber: o.number, total: o.total, currency: o.currency, status: o.status, items: o.items.map((i) => i.name).slice(0, 10) },
        });

      if (!existing) {
        const row = await tx.order.create({ data: { workspaceId, source, externalId: o.externalId, ...fields, syncedAt: new Date() } });
        await event("order.created", row.id);
        for (const [reached, type] of transitions(null, row)) if (reached) await event(type, row.id);
        return { status: "created" as const, contactId: contact?.id ?? null, previousContactId: null };
      }

      const changed =
        existing.number !== fields.number ||
        existing.contactId !== fields.contactId ||
        existing.companyId !== fields.companyId ||
        existing.status !== fields.status ||
        existing.state !== fields.state ||
        existing.paid !== fields.paid ||
        existing.currency !== fields.currency ||
        existing.total.toFixed(2) !== fields.total.toFixed(2) ||
        existing.placedAt.getTime() !== fields.placedAt.getTime() ||
        stable(existing.items) !== stable(items) ||
        stable(existing.data) !== stable(fields.data);
      // Once stamped, a moment stays what it was: a re-send without it does not move it.
      const keep = {
        paidAt: fields.paid ? (existing.paidAt ?? fields.paidAt) : null,
        completedAt: fields.state === "completed" ? (existing.completedAt ?? fields.completedAt) : fields.completedAt,
        cancelledAt: fields.state === "cancelled" ? (existing.cancelledAt ?? fields.cancelledAt) : null,
      };
      const row = await tx.order.update({ where: { id: existing.id, workspaceId }, data: { ...fields, ...keep, syncedAt: new Date() } });
      for (const [reached, type] of transitions(existing, row)) if (reached) await event(type, row.id);
      return { status: changed ? ("updated" as const) : ("unchanged" as const), contactId: contact?.id ?? null, previousContactId: existing.contactId !== row.contactId ? existing.contactId : null };
    });
  }

  /** Products the catalog sync made from the same source, by their external ids. */
  private async productIds(tx: Tx, workspaceId: string, source: string, externalIds: string[]): Promise<Map<string, string>> {
    if (!externalIds.length) return new Map();
    const rows = await tx.product.findMany({ where: { workspaceId, source, externalId: { in: [...new Set(externalIds)] } }, select: { id: true, externalId: true } });
    return new Map(rows.map((r) => [r.externalId ?? "", r.id]));
  }

  /**
   * A contact's order totals, counted again from its orders: placed (not
   * cancelled), paid, what the paid ones came to — in the currency of the
   * latest paid order, the others left out rather than added at an invented
   * rate — first and last order, and what the latest was for. A paid order
   * makes them a customer (unless the team marked them otherwise) and a client.
   */
  async recount(workspaceId: string, contactId: string) {
    await this.prisma.db.$transaction(async (tx) => {
      const contact = await tx.contact.findFirst({ where: { id: contactId, workspaceId }, select: { status: true, lifecycleStage: true, customerSince: true } });
      if (!contact) return;
      const orders = await tx.order.findMany({
        where: { workspaceId, contactId, state: { not: "cancelled" } },
        select: { paid: true, currency: true, total: true, placedAt: true, paidAt: true, items: true },
        orderBy: { placedAt: "asc" },
      });
      const paid = orders.filter((o) => o.paid);
      const latestPaid = [...paid].sort((a, b) => (b.paidAt ?? b.placedAt).getTime() - (a.paidAt ?? a.placedAt).getTime())[0];
      const currency = latestPaid?.currency ?? "";
      const spent = paid.filter((o) => o.currency === currency).reduce((sum, o) => sum.add(o.total), new Prisma.Decimal(0));
      const last = orders.at(-1);
      const lastItems = Array.isArray(last?.items) ? (last.items as { name?: unknown }[]) : [];
      const data: Prisma.ContactUpdateInput = {
        ordersCount: orders.length,
        paidOrdersCount: paid.length,
        totalSpent: spent,
        spentCurrency: currency,
        firstOrderAt: orders[0]?.placedAt ?? null,
        lastOrderAt: last?.placedAt ?? null,
        lastPurchase: lastItems.map((i) => String(i.name ?? "")).filter(Boolean).join(", ").slice(0, 200),
      };
      if (paid.length > 0) {
        if (!KEEP_STATUS.has(contact.status)) data.status = "customer";
        if (contact.lifecycleStage !== "contact") {
          data.lifecycleStage = "contact";
          data.stageChangedAt = new Date();
        }
        if (!contact.customerSince) data.customerSince = orders[0]?.placedAt ?? new Date();
      }
      await tx.contact.update({ where: { id: contactId, workspaceId }, data });
    });
  }

  // ─── Reads ────────────────────────────────────────────────────────────────

  /** A contact's orders, newest first, for its page. */
  async contactOrders(ctx: RequestContext, contactId: string): Promise<ContactOrder[]> {
    const w = ws(ctx);
    // Visibility is the contact's: only a contact the caller may see (ownership scope included).
    const visible = await this.prisma.db.contact.findFirst({ where: { ...this.contacts.where(ctx, { archived: "include" }), id: contactId }, select: { id: true } });
    if (!visible) throw notFound("That contact");
    const rows = await this.prisma.db.order.findMany({ where: { workspaceId: w.id, contactId }, orderBy: { placedAt: "desc" }, take: 200 });
    return rows.map((r) => ({
      id: r.id,
      number: r.number,
      status: r.status,
      state: r.state as OrderState,
      paid: r.paid,
      currency: r.currency,
      total: Number(r.total),
      items: (Array.isArray(r.items) ? (r.items as { name?: unknown; quantity?: unknown; total?: unknown }[]) : []).map((i) => ({ name: String(i.name ?? ""), quantity: Number(i.quantity ?? 1), total: Number(i.total ?? 0) })),
      placedAt: r.placedAt.toISOString(),
      paidAt: r.paidAt?.toISOString() ?? null,
      completedAt: r.completedAt?.toISOString() ?? null,
      cancelledAt: r.cancelledAt?.toISOString() ?? null,
    }));
  }

  /** The connection check for a sync key, and what has come in so far. */
  async status(ctx: RequestContext) {
    const w = ws(ctx);
    const [clients, orders, last] = await Promise.all([
      this.prisma.db.contact.count({ where: { workspaceId: w.id, deletedAt: null, customerSince: { not: null } } }),
      this.prisma.db.order.count({ where: { workspaceId: w.id } }),
      this.prisma.db.order.aggregate({ where: { workspaceId: w.id }, _max: { syncedAt: true } }),
    ]);
    return { clients, orders, lastSyncedAt: last._max.syncedAt };
  }
}

/** The order.* moments an order reached since it was last seen: paid, completed, cancelled — each once. */
function transitions(before: { paid: boolean; state: string } | null, after: { paid: boolean; state: string }): [boolean, string][] {
  return [
    [after.paid && !before?.paid, "order.paid"],
    [after.state === "completed" && before?.state !== "completed", "order.completed"],
    [after.state === "cancelled" && before?.state !== "cancelled", "order.cancelled"],
  ];
}

function summarize(results: Result[], received: number): CommerceSyncResult["summary"] {
  const n = (s: Result["status"]) => results.filter((r) => r.status === s).length;
  return { received, created: n("created"), updated: n("updated"), unchanged: n("unchanged"), failed: n("failed") };
}
