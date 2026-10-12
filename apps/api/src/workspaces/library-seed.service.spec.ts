import { describe, expect, test } from "vitest";
import { EMAIL_DESIGN_LIBRARY, TEMPLATE_LIBRARY } from "@growthdesk/shared";
import type { PrismaService } from "../prisma/prisma.service.js";
import { LibrarySeedService } from "./library-seed.service.js";

type Row = Record<string, unknown> & { id: string };

/** Just enough of Prisma for the seed: rows in memory, keyed by model. */
function fakePrisma() {
  const tables: Record<"template" | "templateVersion" | "emailDesign" | "librarySeed" | "workspace", Row[]> = { template: [], templateVersion: [], emailDesign: [], librarySeed: [], workspace: [{ id: "w1", deletedAt: null }] };
  let n = 0;
  const model = (name: keyof typeof tables) => ({
    create: async ({ data }: { data: Record<string, unknown> }) => {
      const row = { id: `${name}-${++n}`, ...data };
      tables[name].push(row);
      return row;
    },
    // Paging: one page holds everything, so a request for the page after a cursor is empty.
    findMany: async ({ where, cursor }: { where?: Record<string, unknown>; cursor?: unknown } = {}) =>
      cursor ? [] : tables[name].filter((r) => !where?.workspaceId || r.workspaceId === where.workspaceId).filter((r) => !("deletedAt" in (where ?? {})) || r.deletedAt === null),
  });
  const tx = {
    $executeRaw: async () => 0,
    template: model("template"),
    templateVersion: model("templateVersion"),
    emailDesign: model("emailDesign"),
    librarySeed: model("librarySeed"),
    workspace: model("workspace"),
  };
  const db = { ...tx, $transaction: async <T>(fn: (t: typeof tx) => Promise<T>) => fn(tx) };
  return { tables, prisma: { db } as unknown as PrismaService };
}

describe("LibrarySeedService", () => {
  test("gives a workspace every library item once", async () => {
    const { tables, prisma } = fakePrisma();
    const seeds = new LibrarySeedService(prisma);
    expect(await seeds.seedWorkspace("w1")).toEqual({ templates: TEMPLATE_LIBRARY.length, designs: EMAIL_DESIGN_LIBRARY.length });
    expect(tables.template).toHaveLength(TEMPLATE_LIBRARY.length);
    expect(tables.templateVersion).toHaveLength(TEMPLATE_LIBRARY.length);
    expect(tables.emailDesign).toHaveLength(EMAIL_DESIGN_LIBRARY.length);
    // A second deploy adds nothing.
    expect(await seeds.seedWorkspace("w1")).toEqual({ templates: 0, designs: 0 });
  });

  test("never overwrites an edited item or brings back a deleted one", async () => {
    const { tables, prisma } = fakePrisma();
    const seeds = new LibrarySeedService(prisma);
    await seeds.seedWorkspace("w1");
    tables.template[0]!.body = "Our own wording";
    tables.emailDesign.splice(0, 1);
    tables.template.splice(1, 1);
    await seeds.seedAll();
    expect(tables.template[0]!.body).toBe("Our own wording");
    expect(tables.template).toHaveLength(TEMPLATE_LIBRARY.length - 1);
    expect(tables.emailDesign).toHaveLength(EMAIL_DESIGN_LIBRARY.length - 1);
  });

  test("an item added to the library in a later release still arrives", async () => {
    const { tables, prisma } = fakePrisma();
    const seeds = new LibrarySeedService(prisma);
    await seeds.seedWorkspace("w1");
    // As if this key were new in this release: the workspace was never given it.
    const newest = TEMPLATE_LIBRARY[TEMPLATE_LIBRARY.length - 1]!.key;
    tables.librarySeed = tables.librarySeed.filter((s) => s.key !== newest);
    expect(await seeds.seedWorkspace("w1")).toEqual({ templates: 1, designs: 0 });
    expect(tables.template.filter((t) => t.libraryKey === newest)).toHaveLength(2);
  });
});
