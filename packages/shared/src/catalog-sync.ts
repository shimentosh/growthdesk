import { z } from "zod";
import { BILLING_PERIODS } from "./quotes.js";

/*
 * Catalog sync: another system (the Clientdesk client portal) keeps the
 * workspace's Products in step with its own catalog. It sends the whole
 * catalog each time (PUT /workspaces/:id/catalog/sync, API key with
 * products:write); each item is upserted by (source, externalId), and with
 * `complete` a product from that source missing from the list is archived.
 * Synced products belong to the source: edit them there.
 */

/** Systems a catalog may be synced from (recorded on Product.source). */
export const CATALOG_SOURCES = ["clientdesk"] as const;

/** Items per sync request; a catalog is a few hundred rows at most. */
export const MAX_CATALOG_ITEMS = 5000;

const money = z.number().min(0).max(999_999_999_999.99).multipleOf(0.01);

export const CatalogItemInput = z.object({
  /** The item's id in the source, stable across renames (e.g. "tier:tr_gp_50"). */
  externalId: z.string().trim().min(1).max(200),
  name: z.string().trim().min(1).max(300),
  sku: z.string().trim().max(120).default(""),
  /** Offering the item is a package of ("Guest Posts"); "" for a standalone item. */
  groupName: z.string().trim().max(300).default(""),
  category: z.string().trim().max(120).default(""),
  description: z.string().max(20_000).default(""),
  unit: z.string().trim().max(60).default(""),
  unitPrice: money,
  costPrice: money.nullable().default(null),
  /** ISO 4217. */
  currency: z.string().trim().length(3).toUpperCase(),
  billingPeriod: z.enum(BILLING_PERIODS).default("one_time"),
  /** Percent, e.g. 7.5. */
  taxRate: z.number().min(0).max(100).default(0),
  /** False: archived (or a draft) in the source. */
  active: z.boolean().default(true),
  /** Everything else the source knows about the item, kept verbatim. */
  metadata: z.record(z.string(), z.unknown()).default({}),
});
export type CatalogItemInputT = z.infer<typeof CatalogItemInput>;

export const CatalogSyncInput = z.object({
  source: z.enum(CATALOG_SOURCES),
  /** True: `items` is the whole catalog, so this source's products not in it are archived. */
  complete: z.boolean().default(true),
  items: z.array(CatalogItemInput).max(MAX_CATALOG_ITEMS),
});
export type CatalogSyncInputT = z.infer<typeof CatalogSyncInput>;

export type CatalogSyncResult = {
  source: string;
  received: number;
  created: number;
  updated: number;
  unchanged: number;
  archived: number;
  restored: number;
  syncedAt: string;
};
