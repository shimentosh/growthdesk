import { Injectable } from "@nestjs/common";
import { Prisma } from "../generated/prisma/client.js";
import type { CatalogItemInputT, CatalogSyncInputT, CatalogSyncResult } from "@growthdesk/shared";
import { PrismaService } from "../prisma/prisma.service.js";
import { AuditService } from "../core/audit.service.js";
import { badRequest } from "../common/errors.js";
import { ws, type RequestContext } from "../common/context.js";

/*
 * Keeps the workspace's Products in step with another system's catalog (the
 * Clientdesk client portal pushes its services here whenever they change, and
 * once a day). Each item is upserted by (workspace, source, externalId); an
 * inactive item is archived, an active one restored; with `complete`, a product
 * from that source that the catalog no longer lists is archived. Nothing is
 * deleted, so quotes that used a product keep it. A product made by hand
 * (source "") is never touched.
 */

type ProductRow = Prisma.ProductGetPayload<object>;

/** The columns a sync owns, as they will be stored. */
function columns(item: CatalogItemInputT) {
  return {
    name: item.name,
    sku: item.sku,
    groupName: item.groupName,
    category: item.category,
    description: item.description,
    unit: item.unit,
    unitPrice: new Prisma.Decimal(item.unitPrice.toFixed(2)),
    costPrice: item.costPrice === null ? null : new Prisma.Decimal(item.costPrice.toFixed(2)),
    currency: item.currency,
    billingPeriod: item.billingPeriod,
    taxRate: new Prisma.Decimal(item.taxRate.toFixed(2)),
    metadata: item.metadata as Prisma.InputJsonValue,
  };
}

/** JSON with sorted keys, so metadata compares by content rather than key order. */
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

const dec = (v: Prisma.Decimal | null) => (v === null ? null : v.toFixed(2));

function differs(row: ProductRow, next: ReturnType<typeof columns>): boolean {
  return (
    row.name !== next.name ||
    row.sku !== next.sku ||
    row.groupName !== next.groupName ||
    row.category !== next.category ||
    row.description !== next.description ||
    row.unit !== next.unit ||
    dec(row.unitPrice) !== dec(next.unitPrice) ||
    dec(row.costPrice) !== dec(next.costPrice) ||
    row.currency !== next.currency ||
    row.billingPeriod !== next.billingPeriod ||
    dec(row.taxRate) !== dec(next.taxRate) ||
    stable(row.metadata) !== stable(next.metadata)
  );
}

@Injectable()
export class CatalogSyncService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async sync(ctx: RequestContext, input: CatalogSyncInputT): Promise<CatalogSyncResult> {
    const w = ws(ctx);
    const seen = new Set<string>();
    for (const item of input.items) {
      if (seen.has(item.externalId)) throw badRequest(`The catalog lists "${item.externalId}" twice; each externalId must be unique.`);
      seen.add(item.externalId);
    }

    const now = new Date();
    const counts = { created: 0, updated: 0, unchanged: 0, archived: 0, restored: 0 };
    await this.prisma.db.$transaction(
      async (tx) => {
        const rows = await tx.product.findMany({ where: { workspaceId: w.id, source: input.source } });
        const byId = new Map(rows.map((r) => [r.externalId ?? "", r]));

        for (const item of input.items) {
          const next = columns(item);
          const row = byId.get(item.externalId);
          if (!row) {
            await tx.product.create({
              data: { workspaceId: w.id, source: input.source, externalId: item.externalId, ...next, archivedAt: item.active ? null : now, syncedAt: now },
            });
            counts.created++;
            continue;
          }
          const archive = !item.active && !row.archivedAt;
          const restore = item.active && Boolean(row.archivedAt);
          const changed = differs(row, next);
          await tx.product.update({
            where: { id: row.id, workspaceId: w.id },
            data: { ...(changed ? next : {}), ...(archive ? { archivedAt: now } : restore ? { archivedAt: null } : {}), syncedAt: now },
          });
          if (archive) counts.archived++;
          if (restore) counts.restored++;
          if (changed) counts.updated++;
          else if (!archive && !restore) counts.unchanged++;
        }

        if (input.complete) {
          const gone = rows.filter((r) => !r.archivedAt && !seen.has(r.externalId ?? ""));
          if (gone.length) {
            await tx.product.updateMany({ where: { workspaceId: w.id, id: { in: gone.map((r) => r.id) } }, data: { archivedAt: now, syncedAt: now } });
            counts.archived += gone.length;
          }
        }
      },
      { timeout: 60_000 },
    );

    const result: CatalogSyncResult = { source: input.source, received: input.items.length, ...counts, syncedAt: now.toISOString() };
    if (counts.created || counts.updated || counts.archived || counts.restored) {
      await this.audit.record(ctx, { action: "products.synced", targetType: "product", metadata: { ...result } });
    }
    return result;
  }

  /** Per source: how many products it owns, how many are live, and when it last synced. */
  async status(ctx: RequestContext) {
    const w = ws(ctx);
    const groups = await this.prisma.db.product.groupBy({
      by: ["source"],
      where: { workspaceId: w.id, source: { not: "" } },
      _count: { _all: true },
      _max: { syncedAt: true },
    });
    const live = await this.prisma.db.product.groupBy({
      by: ["source"],
      where: { workspaceId: w.id, source: { not: "" }, archivedAt: null },
      _count: { _all: true },
    });
    return groups.map((g) => ({
      source: g.source,
      products: g._count._all,
      active: live.find((l) => l.source === g.source)?._count._all ?? 0,
      lastSyncedAt: g._max.syncedAt,
    }));
  }
}
