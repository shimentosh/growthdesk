import { Injectable } from "@nestjs/common";
import type { z } from "zod";
import type { ProductInput, ProductListQuery, ProductUpdate } from "@growthdesk/shared";
import type { Prisma, Product } from "../generated/prisma/client.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { conflict, notFound } from "../common/errors.js";
import { actorId, holds, ws, type RequestContext } from "../common/context.js";

/** A product's extra details from its source's metadata, when they are there in a shape worth showing. */
function details(metadata: unknown) {
  const m = (metadata && typeof metadata === "object" && !Array.isArray(metadata) ? metadata : {}) as Record<string, unknown>;
  const turnaround = typeof m.turnaround === "string" || typeof m.turnaround === "number" ? String(m.turnaround).slice(0, 120) : null;
  const features = Array.isArray(m.features) ? m.features.filter((f): f is string => typeof f === "string").slice(0, 30).map((f) => f.slice(0, 200)) : [];
  return { turnaround, features };
}

/**
 * `costPrice` (and so margin) only for people who manage the catalogue: what
 * delivery costs is not something every seller needs to see.
 */
export const productDto = (p: Product, showCost = true) => ({
  id: p.id,
  name: p.name,
  sku: p.sku,
  description: p.description,
  category: p.category,
  groupName: p.groupName,
  unit: p.unit,
  unitPrice: p.unitPrice.toFixed(2),
  costPrice: showCost && p.costPrice ? p.costPrice.toFixed(2) : null,
  currency: p.currency,
  billingPeriod: p.billingPeriod,
  taxRate: p.taxRate.toFixed(2),
  /** "" for a product made here; else the system that owns it ("clientdesk"). */
  source: p.source,
  synced: p.source !== "",
  syncedAt: p.syncedAt,
  details: details(p.metadata),
  archived: Boolean(p.archivedAt),
  archivedAt: p.archivedAt,
  createdAt: p.createdAt,
  updatedAt: p.updatedAt,
});

/** The columns the catalog sync owns on a synced product (apps/api/src/catalog-sync), plus archiving. */
const SYNCED_COLUMNS = ["name", "sku", "description", "category", "groupName", "unit", "unitPrice", "costPrice", "currency", "billingPeriod", "taxRate", "archived"] as const;

const syncedRefusal = () => conflict("This product is synced from the client portal; change it there.");

/**
 * The product catalogue: what a quote line can be picked from. A quote line
 * copies the product's name, price, tax and billing period when it is added,
 * so editing or deleting a product never changes a quote already written.
 * Products synced from another system (source ≠ "") are read-only here: the
 * next sync would overwrite any edit.
 */
@Injectable()
export class ProductsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(ctx: RequestContext, q: z.infer<typeof ProductListQuery>) {
    const w = ws(ctx);
    const where: Prisma.ProductWhereInput = { workspaceId: w.id };
    if (q.state === "active") where.archivedAt = null;
    if (q.state === "archived") where.archivedAt = { not: null };
    const s = q.q?.trim();
    if (s) {
      where.OR = (["name", "sku", "description", "groupName", "category"] as const).map((f) => ({ [f]: { contains: s, mode: "insensitive" } }) as Prisma.ProductWhereInput);
    }
    // Default: grouped the way the page shows them — offering, then category, then name.
    const orderBy: Prisma.ProductOrderByWithRelationInput[] =
      q.sort === "unitPrice"
        ? [{ unitPrice: q.dir }]
        : q.sort === "createdAt"
          ? [{ createdAt: q.dir }]
          : q.sort === "updatedAt"
            ? [{ updatedAt: q.dir }]
            : q.sort === "name"
              ? [{ name: q.dir }]
              : [{ groupName: "asc" }, { category: "asc" }, { unitPrice: "asc" }, { name: "asc" }];
    const [rows, total] = await Promise.all([
      this.prisma.db.product.findMany({ where, orderBy: [...orderBy, { id: "asc" }], skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
      this.prisma.db.product.count({ where }),
    ]);
    const showCost = holds(ctx, "products.manage");
    return { items: rows.map((p) => productDto(p, showCost)), total, page: q.page, pageSize: q.pageSize };
  }

  async find(ctx: RequestContext, id: string) {
    const p = await this.prisma.db.product.findFirst({ where: { id, workspaceId: ws(ctx).id } });
    if (!p) throw notFound("That product");
    return p;
  }

  async get(ctx: RequestContext, id: string) {
    return productDto(await this.find(ctx, id), holds(ctx, "products.manage"));
  }

  async create(ctx: RequestContext, input: z.infer<typeof ProductInput>) {
    const w = ws(ctx);
    const p = await this.prisma.db.product.create({
      data: {
        workspaceId: w.id,
        name: input.name,
        sku: input.sku,
        description: input.description,
        category: input.category,
        groupName: input.groupName,
        unit: input.unit,
        unitPrice: input.unitPrice,
        costPrice: input.costPrice,
        currency: input.currency ?? w.currency,
        billingPeriod: input.billingPeriod,
        taxRate: input.taxRate,
        createdById: actorId(ctx),
      },
    });
    return productDto(p);
  }

  async update(ctx: RequestContext, id: string, input: z.infer<typeof ProductUpdate>) {
    const w = ws(ctx);
    const existing = await this.find(ctx, id);
    if (existing.source && SYNCED_COLUMNS.some((k) => input[k] !== undefined)) throw syncedRefusal();
    const data: Prisma.ProductUpdateInput = {};
    for (const key of ["name", "sku", "description", "category", "groupName", "unit", "unitPrice", "costPrice", "currency", "billingPeriod", "taxRate"] as const) {
      if (input[key] !== undefined) (data as Record<string, unknown>)[key] = input[key];
    }
    if (input.archived !== undefined) data.archivedAt = input.archived ? (existing.archivedAt ?? new Date()) : null;
    const p = await this.prisma.db.product.update({ where: { id, workspaceId: w.id }, data });
    return productDto(p);
  }

  /** Lines that used the product keep their copy of it (QuoteLineItem.productId is set to null). A synced product is removed at its source. */
  async remove(ctx: RequestContext, id: string) {
    const w = ws(ctx);
    const existing = await this.find(ctx, id);
    if (existing.source) throw syncedRefusal();
    await this.prisma.db.product.deleteMany({ where: { id, workspaceId: w.id } });
  }
}
