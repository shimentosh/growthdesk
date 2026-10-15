import { describe, expect, test } from "vitest";
import { EMAIL_DESIGN_LIBRARY } from "@growthdesk/shared";
import { ensureBuiltInDesigns, seedableBuiltInDesigns } from "./builtins.js";

type Row = { key: string; name: string; status: string; deletedAt: Date | null } & Record<string, unknown>;

/** The library table in memory: createMany honours the unique key the way skipDuplicates does. */
function fakeDb() {
  const rows: Row[] = [];
  const db = {
    platformEmailDesign: {
      createMany: async ({ data, skipDuplicates }: { data: Row[]; skipDuplicates?: boolean }) => {
        let count = 0;
        for (const d of data) {
          if (rows.some((r) => r.key === d.key)) {
            if (!skipDuplicates) throw new Error("unique violation");
            continue;
          }
          rows.push({ ...d, deletedAt: d.deletedAt ?? null });
          count++;
        }
        return { count };
      },
      findMany: async ({ where }: { where: { key: { in: string[] } } }) => rows.filter((r) => where.key.in.includes(r.key)),
    },
  };
  return { rows, db: db as never };
}

describe("design library bootstrap", () => {
  test("inserts every built-in once, published, in library order", async () => {
    const { rows, db } = fakeDb();
    expect(await ensureBuiltInDesigns(db)).toBe(EMAIL_DESIGN_LIBRARY.length);
    expect(rows.map((r) => r.key)).toEqual(EMAIL_DESIGN_LIBRARY.map((d) => d.key));
    expect(rows.every((r) => r.status === "published" && r.publishedAt instanceof Date)).toBe(true);
    expect(rows.map((r) => r.sortOrder)).toEqual(EMAIL_DESIGN_LIBRARY.map((_, i) => (i + 1) * 10));
    // The next start adds nothing.
    expect(await ensureBuiltInDesigns(db)).toBe(0);
    expect(rows).toHaveLength(EMAIL_DESIGN_LIBRARY.length);
  });

  test("never overwrites an admin's edit or brings back a deleted built-in", async () => {
    const { rows, db } = fakeDb();
    await ensureBuiltInDesigns(db);
    rows[0]!.name = "Our launch email";
    rows[1]!.deletedAt = new Date();
    rows[2]!.status = "draft";
    expect(await ensureBuiltInDesigns(db)).toBe(0);
    expect(rows[0]!.name).toBe("Our launch email");
    expect(rows[1]!.deletedAt).toBeInstanceOf(Date);
    expect(rows[2]!.status).toBe("draft");
  });

  test("workspaces are seeded from published, live built-in rows, or the shipped design before the bootstrap", async () => {
    const { rows, db } = fakeDb();
    // Not bootstrapped yet: the shipped designs.
    expect((await seedableBuiltInDesigns(db)).map((d) => d.name)).toEqual(EMAIL_DESIGN_LIBRARY.map((d) => d.name));
    await ensureBuiltInDesigns(db);
    rows[0]!.name = "Edited";
    rows[1]!.deletedAt = new Date();
    rows[2]!.status = "draft";
    rows.push({ key: "admin-made", name: "Admin made", status: "published", deletedAt: null });
    const seedable = await seedableBuiltInDesigns(db);
    expect(seedable).toHaveLength(EMAIL_DESIGN_LIBRARY.length - 2);
    expect(seedable[0]!.name).toBe("Edited");
    expect(seedable.map((d) => d.key)).not.toContain(EMAIL_DESIGN_LIBRARY[1]!.key);
    expect(seedable.map((d) => d.key)).not.toContain(EMAIL_DESIGN_LIBRARY[2]!.key);
    expect(seedable.map((d) => d.key)).not.toContain("admin-made");
  });
});
