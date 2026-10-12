import { Injectable } from "@nestjs/common";
import { emailDomain, type ListMembersAdd, type ListMembersQuery, type MarketingListInput } from "@growthdesk/shared";
import type { z } from "zod";
import type { Prisma } from "../generated/prisma/client.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { EntitlementsService } from "../billing/entitlements.service.js";
import { ConsentService } from "../crm/consent.service.js";
import { ActivityService } from "../crm/activity.service.js";
import { AuditService } from "../core/audit.service.js";
import { AudienceService } from "./audience.service.js";
import { conflict, notFound } from "../common/errors.js";
import { actorId, ws, type RequestContext } from "../common/context.js";

export type AddResult = {
  added: number;
  alreadyMember: number;
  skipped: { not_found: number; no_email: number; do_not_contact: number; no_consent: number; consent_denied: number; suppressed: number; unsubscribed: number };
};

/*
 * Lead lists. Imports and the team put people here; outreach campaigns
 * target them, and so do marketing campaigns. Lists hold anyone, consent or
 * not: for marketing, membership is the second gate after consent (R2) — the
 * marketing audience only takes members with granted consent.
 * Removing someone from a list (a team action) deletes the row; someone
 * unsubscribing keeps it, as `unsubscribed`, so a later re-add by the team
 * cannot silently put them back.
 */
@Injectable()
export class ListsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly entitlements: EntitlementsService,
    private readonly consent: ConsentService,
    private readonly activity: ActivityService,
    private readonly audit: AuditService,
    private readonly audience: AudienceService,
  ) {}

  private async find(ctx: RequestContext, id: string) {
    const list = await this.prisma.db.marketingList.findFirst({ where: { id, workspaceId: ws(ctx).id } });
    if (!list) throw notFound("That list");
    return list;
  }

  private async counts(workspaceId: string, listIds: string[]) {
    const rows = listIds.length
      ? await this.prisma.db.listMembership.groupBy({ by: ["listId", "status"], where: { workspaceId, listId: { in: listIds } }, _count: { _all: true } })
      : [];
    const out = new Map<string, { subscribed: number; unsubscribed: number; pending: number }>();
    for (const id of listIds) out.set(id, { subscribed: 0, unsubscribed: 0, pending: 0 });
    for (const r of rows) out.get(r.listId)![r.status] = r._count._all;
    return out;
  }

  async list(ctx: RequestContext, includeArchived = false) {
    const w = ws(ctx);
    const rows = await this.prisma.db.marketingList.findMany({
      where: { workspaceId: w.id, ...(includeArchived ? {} : { archivedAt: null }) },
      orderBy: { createdAt: "desc" },
    });
    const counts = await this.counts(w.id, rows.map((r) => r.id));
    return rows.map((r) => ({ ...dto(r), counts: counts.get(r.id)! }));
  }

  async get(ctx: RequestContext, id: string) {
    const list = await this.find(ctx, id);
    const counts = await this.counts(list.workspaceId, [id]);
    return { ...dto(list), counts: counts.get(id)! };
  }

  async create(ctx: RequestContext, input: z.infer<typeof MarketingListInput>) {
    const w = ws(ctx);
    const row = await this.prisma.db.marketingList.create({ data: { workspaceId: w.id, name: input.name, description: input.description ?? "", createdById: actorId(ctx) } });
    await this.audit.record(ctx, { action: "marketing.list_created", targetType: "marketing_list", targetId: row.id, metadata: { name: row.name } });
    return this.get(ctx, row.id);
  }

  async update(ctx: RequestContext, id: string, input: Partial<z.infer<typeof MarketingListInput>>) {
    await this.find(ctx, id);
    await this.prisma.db.marketingList.update({
      where: { id, workspaceId: ws(ctx).id },
      data: { ...(input.name !== undefined ? { name: input.name } : {}), ...(input.description !== undefined ? { description: input.description } : {}) },
    });
    return this.get(ctx, id);
  }

  /** Archived lists keep their members and history but can no longer be sent to. */
  async archive(ctx: RequestContext, id: string, archived: boolean) {
    const list = await this.find(ctx, id);
    if (archived) {
      const active = await this.prisma.db.marketingCampaign.findMany({ where: { workspaceId: list.workspaceId, status: { in: ["scheduled", "sending", "paused"] }, deletedAt: null }, select: { name: true, audience: true } });
      const using = active.filter((c) => {
        const a = (c.audience ?? {}) as { listIds?: string[] };
        return a.listIds?.includes(id);
      });
      if (using.length) throw conflict(`"${using[0]!.name}" is sending to this list. Finish or cancel it first.`);
    }
    await this.prisma.db.marketingList.update({ where: { id, workspaceId: list.workspaceId }, data: { archivedAt: archived ? new Date() : null } });
    await this.audit.record(ctx, { action: archived ? "marketing.list_archived" : "marketing.list_restored", targetType: "marketing_list", targetId: id });
    return this.get(ctx, id);
  }

  async members(ctx: RequestContext, id: string, q: z.infer<typeof ListMembersQuery>) {
    const list = await this.find(ctx, id);
    const where: Prisma.ListMembershipWhereInput = {
      workspaceId: list.workspaceId,
      listId: id,
      ...(q.status ? { status: q.status } : {}),
      contact: {
        deletedAt: null,
        ...(q.q ? { OR: [{ fullName: { contains: q.q, mode: "insensitive" } }, { email: { contains: q.q.toLowerCase() } }] } : {}),
      },
    };
    const [rows, total] = await Promise.all([
      this.prisma.db.listMembership.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
        include: { contact: { select: { id: true, fullName: true, email: true, consentStatus: true } } },
      }),
      this.prisma.db.listMembership.count({ where }),
    ]);
    return {
      items: rows.map((m) => ({ id: m.id, status: m.status, source: m.source, subscribedAt: m.subscribedAt, unsubscribedAt: m.unsubscribedAt, createdAt: m.createdAt, contact: m.contact })),
      total,
      page: q.page,
      pageSize: q.pageSize,
    };
  }

  /**
   * Adds people to a list. With `consent`, the person adding confirms
   * marketing consent was given (and where), which is recorded for each
   * contact that lacked it; without it, people are added as leads and the
   * marketing engine leaves out anyone without consent. Never re-adds someone
   * who unsubscribed from this list or refused consent.
   */
  async addMembers(ctx: RequestContext, id: string, input: z.infer<typeof ListMembersAdd>): Promise<AddResult> {
    const w = ws(ctx);
    const list = await this.find(ctx, id);
    if (list.archivedAt) throw conflict("This list is archived. Restore it before adding people.");
    await this.entitlements.assertFullAccess(w.billingAccountId, "Adding subscribers");

    const ids = [...new Set(input.contactIds)];
    const contacts = await this.prisma.db.contact.findMany({
      where: { workspaceId: w.id, id: { in: ids }, deletedAt: null },
      select: { id: true, email: true, doNotContact: true, bouncedAt: true, consentStatus: true },
    });
    const existing = await this.prisma.db.listMembership.findMany({ where: { workspaceId: w.id, listId: id, contactId: { in: ids } }, select: { contactId: true, status: true } });
    const memberStatus = new Map(existing.map((m) => [m.contactId, m.status]));
    const sup = await this.audience.suppressed(w.id);

    const result: AddResult = { added: 0, alreadyMember: 0, skipped: { not_found: ids.length - contacts.length, no_email: 0, do_not_contact: 0, no_consent: 0, consent_denied: 0, suppressed: 0, unsubscribed: 0 } };
    const toAdd: typeof contacts = [];
    for (const c of contacts) {
      const status = memberStatus.get(c.id);
      if (status === "subscribed") result.alreadyMember++;
      else if (status === "unsubscribed") result.skipped.unsubscribed++;
      else if (c.doNotContact) result.skipped.do_not_contact++;
      else if (c.email && (sup.emails.has(c.email) || sup.domains.has(emailDomain(c.email)))) result.skipped.suppressed++;
      else if (c.consentStatus === "denied") result.skipped.consent_denied++;
      else toAdd.push(c);
    }

    // Only people the marketing engine could mail (consent granted, or confirmed now)
    // and not already on another list count against the subscriber allowance.
    const mailable = toAdd.filter((c) => c.email && (c.consentStatus === "granted" || input.consent));
    if (mailable.length) {
      const alreadyCounted = await this.prisma.db.listMembership.findMany({
        where: { workspaceId: w.id, contactId: { in: mailable.map((c) => c.id) }, status: "subscribed", contact: { consentStatus: "granted" } },
        distinct: ["contactId"],
        select: { contactId: true },
      });
      const fresh = mailable.length - alreadyCounted.length;
      if (fresh > 0) await this.entitlements.assertCapacity(w.billingAccountId, "marketingContacts", fresh);
    }

    const now = new Date();
    const source = input.consent ? `Added by a team member (${input.consent.source})` : "Added by a team member";
    for (const c of toAdd) {
      await this.prisma.db.$transaction(async (tx) => {
        if (c.consentStatus !== "granted" && input.consent && c.email) {
          await this.consent.setIn(tx, {
            workspaceId: w.id,
            contactId: c.id,
            status: "granted",
            source: input.consent.source,
            ip: ctx.ip,
            userAgent: ctx.userAgent,
            detail: { via: "list_add", listId: id },
            actorId: actorId(ctx),
          });
        }
        const held = await tx.listMembership.findFirst({ where: { workspaceId: w.id, listId: id, contactId: c.id }, select: { id: true } });
        if (held) await tx.listMembership.update({ where: { id: held.id, workspaceId: w.id }, data: { status: "subscribed", source, subscribedAt: now, unsubscribedAt: null } });
        else await tx.listMembership.create({ data: { workspaceId: w.id, listId: id, contactId: c.id, status: "subscribed", source, subscribedAt: now } });
        await this.activity.log({ workspaceId: w.id, contactId: c.id, actorId: actorId(ctx), type: "marketing.subscribed", summary: `Added to the list ${list.name}`, data: { listId: id } }, tx);
      });
      result.added++;
    }
    await this.audit.record(ctx, { action: "marketing.members_added", targetType: "marketing_list", targetId: id, metadata: { added: result.added, consentConfirmed: Boolean(input.consent) } });
    return result;
  }

  /**
   * Takes contacts off a list. An `unsubscribed` row is the person's own
   * opt-out and is kept: deleting it would let a later re-add bypass it.
   */
  async removeMembers(ctx: RequestContext, id: string, contactIds: string[]) {
    const list = await this.find(ctx, id);
    const where = { workspaceId: list.workspaceId, listId: id, contactId: { in: contactIds } };
    const [res, keptUnsubscribed] = await this.prisma.db.$transaction([
      this.prisma.db.listMembership.deleteMany({ where: { ...where, status: { not: "unsubscribed" } } }),
      this.prisma.db.listMembership.count({ where: { ...where, status: "unsubscribed" } }),
    ]);
    await this.audit.record(ctx, { action: "marketing.members_removed", targetType: "marketing_list", targetId: id, metadata: { removed: res.count, keptUnsubscribed } });
    return { removed: res.count, keptUnsubscribed };
  }

  /** A contact's list memberships, for the contact page. */
  async forContact(ctx: RequestContext, contactId: string) {
    const rows = await this.prisma.db.listMembership.findMany({
      where: { workspaceId: ws(ctx).id, contactId },
      include: { list: { select: { id: true, name: true, archivedAt: true } } },
      orderBy: { createdAt: "asc" },
    });
    return rows.map((m) => ({ id: m.id, status: m.status, source: m.source, subscribedAt: m.subscribedAt, unsubscribedAt: m.unsubscribedAt, list: m.list }));
  }
}

function dto(r: { id: string; name: string; description: string; archivedAt: Date | null; createdAt: Date; updatedAt: Date }) {
  return { id: r.id, name: r.name, description: r.description, archivedAt: r.archivedAt, createdAt: r.createdAt, updatedAt: r.updatedAt };
}
