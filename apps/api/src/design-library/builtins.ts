import { EMAIL_DESIGN_LIBRARY } from "@growthdesk/shared";
import type { Db as ScopedDb } from "../prisma/prisma.service.js";

/*
 * The built-in email designs (packages/shared/src/email-library.ts) as rows
 * of the admin-managed library (PlatformEmailDesign).
 *
 *   - Inserted once per key, published, on every API/worker start. A key that
 *     already has a row is skipped, so an admin's edits are never overwritten
 *     and a deleted entry (a tombstone row, deletedAt set) never comes back.
 *   - Workspace seeding (LibrarySeedService) copies the built-ins from these
 *     rows, so an admin's edit to a built-in reaches new workspaces. Entries
 *     admins create are only offered in the gallery, never auto-copied.
 */

type Db = Pick<ScopedDb, "platformEmailDesign">;

export const BUILT_IN_DESIGN_KEYS: readonly string[] = EMAIL_DESIGN_LIBRARY.map((d) => d.key);

/** Built-ins sort first, in library order, ten apart so admins can slot entries between them. */
export const builtInSortOrder = (index: number) => (index + 1) * 10;

/** Inserts the built-ins whose key has no row yet (live or deleted). Returns how many were added. */
export async function ensureBuiltInDesigns(db: Db): Promise<number> {
  const now = new Date();
  const res = await db.platformEmailDesign.createMany({
    data: EMAIL_DESIGN_LIBRARY.map((d, i) => ({
      key: d.key,
      name: d.name,
      description: d.description,
      category: d.category,
      theme: d.theme as never,
      blocks: d.blocks as never,
      status: "published" as const,
      sortOrder: builtInSortOrder(i),
      publishedAt: now,
    })),
    // The unique key makes this safe when the API and workers start together.
    skipDuplicates: true,
  });
  return res.count;
}

export type SeedableDesign = { key: string; name: string; theme: unknown; blocks: unknown };

/**
 * The built-in designs a workspace should be given: each built-in key's
 * library row when it is published and not deleted. A key with no row yet
 * (the library has not been bootstrapped, e.g. a first start racing a new
 * workspace) falls back to the shipped design.
 */
export async function seedableBuiltInDesigns(db: Db): Promise<SeedableDesign[]> {
  const rows = await db.platformEmailDesign.findMany({
    where: { key: { in: [...BUILT_IN_DESIGN_KEYS] } },
    select: { key: true, name: true, theme: true, blocks: true, status: true, deletedAt: true },
  });
  const byKey = new Map(rows.map((r) => [r.key, r]));
  return EMAIL_DESIGN_LIBRARY.flatMap((d) => {
    const row = byKey.get(d.key);
    if (!row) return [{ key: d.key, name: d.name, theme: d.theme, blocks: d.blocks }];
    if (row.deletedAt || row.status !== "published") return [];
    return [{ key: row.key, name: row.name, theme: row.theme, blocks: row.blocks }];
  });
}
