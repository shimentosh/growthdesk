import { Injectable } from "@nestjs/common";
import { normalizeCompanyName, normalizeDomain } from "@growthdesk/shared";
import type { z } from "zod";
import type { CompanyInput } from "@growthdesk/shared";
import { Prisma } from "../generated/prisma/client.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { ActivityService } from "./activity.service.js";
import { ContactsService, contactDto, contactInclude } from "./contacts.service.js";
import { badRequest, conflict, notFound } from "../common/errors.js";
import { actorId, ownershipScope, ws, type RequestContext } from "../common/context.js";

type CompanyInputT = z.infer<typeof CompanyInput>;

@Injectable()
export class CompaniesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly activity: ActivityService,
    private readonly contacts: ContactsService,
  ) {}

  async list(ctx: RequestContext, q: string | undefined, page: number, pageSize: number, sort = "createdAt", dir: "asc" | "desc" = "desc") {
    const w = ws(ctx);
    const where: Prisma.CompanyWhereInput = {
      workspaceId: w.id,
      deletedAt: null,
      ...(q ? { OR: [{ name: { contains: q, mode: "insensitive" } }, { domain: { contains: q.toLowerCase() } }, { industry: { contains: q, mode: "insensitive" } }] } : {}),
      ...(ownershipScope(ctx) as Prisma.CompanyWhereInput),
    };
    const orderField = ["createdAt", "name", "updatedAt"].includes(sort) ? sort : "createdAt";
    const [rows, total] = await Promise.all([
      this.prisma.db.company.findMany({
        where,
        include: {
          owner: { select: { id: true, name: true } },
          tags: { include: { tag: { select: { id: true, name: true, color: true } } } },
          _count: { select: { contacts: { where: { deletedAt: null } }, deals: { where: { deletedAt: null } } } },
        },
        orderBy: { [orderField]: dir },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.db.company.count({ where }),
    ]);
    return {
      items: rows.map((c) => ({
        id: c.id,
        name: c.name,
        domain: c.domain,
        website: c.website,
        industry: c.industry,
        size: c.size,
        country: c.country,
        region: c.region,
        city: c.city,
        owner: c.owner,
        tags: c.tags.map((t) => t.tag),
        contactCount: c._count.contacts,
        dealCount: c._count.deals,
        createdAt: c.createdAt,
      })),
      total,
      page,
      pageSize,
    };
  }

  async get(ctx: RequestContext, id: string) {
    const w = ws(ctx);
    const c = await this.prisma.db.company.findFirst({
      where: { id, workspaceId: w.id, deletedAt: null },
      include: { owner: { select: { id: true, name: true } }, tags: { include: { tag: true } } },
    });
    if (!c) throw notFound("That company");
    const [contacts, deals, notes, activities] = await Promise.all([
      this.prisma.db.contact.findMany({ where: { workspaceId: w.id, companyId: id, deletedAt: null }, include: contactInclude, take: 200, orderBy: { createdAt: "desc" } }),
      this.prisma.db.deal.findMany({ where: { workspaceId: w.id, companyId: id, deletedAt: null }, include: { stage: { select: { id: true, name: true, kind: true } } } }),
      this.prisma.db.note.findMany({ where: { workspaceId: w.id, companyId: id }, orderBy: [{ pinned: "desc" }, { createdAt: "desc" }] }),
      this.prisma.db.activity.findMany({ where: { workspaceId: w.id, companyId: id }, orderBy: { occurredAt: "desc" }, take: 100 }),
    ]);
    return {
      ...c,
      tags: c.tags.map((t) => ({ id: t.tag.id, name: t.tag.name, color: t.tag.color })),
      contacts: contacts.map(contactDto),
      deals: deals.map((d) => ({ id: d.id, name: d.name, value: Number(d.value), currency: d.currency, status: d.status, stage: d.stage })),
      notes,
      activities,
    };
  }

  async create(ctx: RequestContext, input: CompanyInputT) {
    const w = ws(ctx);
    const domain = normalizeDomain(input.domain ?? input.website ?? null);
    if (domain) {
      const existing = await this.prisma.db.company.findFirst({ where: { workspaceId: w.id, domain, deletedAt: null } });
      if (existing) throw conflict(`A company with the domain ${domain} already exists.`, undefined, { companyId: existing.id });
    }
    const company = await this.prisma.db.$transaction(async (tx) => {
      const c = await tx.company.create({
        data: {
          workspaceId: w.id,
          name: input.name,
          normalizedName: normalizeCompanyName(input.name),
          domain,
          website: input.website ?? (domain ? `https://${domain}` : ""),
          industry: input.industry ?? "",
          size: input.size ?? "",
          country: input.country ?? "",
          region: input.region ?? "",
          city: input.city ?? "",
          phone: input.phone ?? "",
          description: input.description ?? "",
          ownerId: input.ownerId ?? null,
          customFields: (input.customFields ?? {}) as never,
          createdById: actorId(ctx),
        },
      });
      if (input.tags?.length) {
        const tagIds = await this.contacts.ensureTags(tx, w.id, input.tags);
        await tx.companyTag.createMany({ data: tagIds.map((tagId) => ({ workspaceId: w.id, companyId: c.id, tagId })), skipDuplicates: true });
      }
      await this.activity.log({ workspaceId: w.id, companyId: c.id, actorId: actorId(ctx), type: "company.created", summary: "Company created" }, tx);
      return c;
    });
    return this.get(ctx, company.id);
  }

  async update(ctx: RequestContext, id: string, input: Partial<CompanyInputT>) {
    const w = ws(ctx);
    const existing = await this.prisma.db.company.findFirst({ where: { id, workspaceId: w.id, deletedAt: null } });
    if (!existing) throw notFound("That company");
    const data: Prisma.CompanyUpdateInput = {};
    for (const key of ["website", "industry", "size", "country", "region", "city", "phone", "description"] as const) {
      if (input[key] !== undefined) data[key] = input[key];
    }
    if (input.name !== undefined) {
      data.name = input.name;
      data.normalizedName = normalizeCompanyName(input.name);
    }
    if (input.domain !== undefined) {
      const domain = normalizeDomain(input.domain);
      if (input.domain && !domain) throw badRequest("That domain is not valid", { domain: "Invalid" });
      if (domain && domain !== existing.domain) {
        const taken = await this.prisma.db.company.findFirst({ where: { workspaceId: w.id, domain, deletedAt: null, id: { not: id } } });
        if (taken) throw conflict(`Another company already uses ${domain}.`, undefined, { companyId: taken.id });
      }
      data.domain = domain;
    }
    if (input.ownerId !== undefined) data.owner = input.ownerId ? { connect: { id: input.ownerId } } : { disconnect: true };
    if (input.customFields !== undefined) data.customFields = { ...((existing.customFields ?? {}) as object), ...input.customFields } as never;
    await this.prisma.db.$transaction(async (tx) => {
      await tx.company.update({ where: { id, workspaceId: w.id }, data });
      if (input.tags) {
        await tx.companyTag.deleteMany({ where: { workspaceId: w.id, companyId: id } });
        const tagIds = await this.contacts.ensureTags(tx, w.id, input.tags);
        await tx.companyTag.createMany({ data: tagIds.map((tagId) => ({ workspaceId: w.id, companyId: id, tagId })), skipDuplicates: true });
      }
    });
    return this.get(ctx, id);
  }

  async remove(ctx: RequestContext, id: string) {
    const w = ws(ctx);
    const res = await this.prisma.db.$transaction(async (tx) => {
      await tx.contact.updateMany({ where: { workspaceId: w.id, companyId: id }, data: { companyId: null } });
      return tx.company.updateMany({ where: { id, workspaceId: w.id, deletedAt: null }, data: { deletedAt: new Date(), domain: null } });
    });
    if (!res.count) throw notFound("That company");
  }
}
