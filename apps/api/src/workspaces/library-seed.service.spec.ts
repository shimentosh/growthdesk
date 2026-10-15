import { describe, expect, test } from "vitest";
import { EMAIL_DESIGN_LIBRARY, TEMPLATE_LIBRARY } from "@growthdesk/shared";
import type { PrismaService } from "../prisma/prisma.service.js";
import { LibrarySeedService } from "./library-seed.service.js";

type Row = Record<string, unknown> & { id: string };

/** Just enough of Prisma for the seed: rows in memory, keyed by model. */
function fakePrisma() {
  const tables: Record<"template" | "templateVersion" | "emailDesign" | "librarySeed" | "workspace" | "platformEmailDesign", Row[]> = {
    template: [],
    templateVersion: [],
    emailDesign: [],
    librarySeed: [],
    workspace: [{ id: "w1", deletedAt: null }],
    platformEmailDesign: [],
  };
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
  // The admin-managed library: looked up by key.
  const platformEmailDesign = {
    findMany: async ({ where }: { where: { key: { in: string[] } } }) => tables.platformEmailDesign.filter((r) => where.key.in.includes(r.key as string)),
  };
  const db = { ...tx, platformEmailDesign, $transaction: async <T>(fn: (t: typeof tx) => Promise<T>) => fn(tx) };
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

  test("copies the built-in designs from the admin-managed library when it has them", async () => {
    const { tables, prisma } = fakePrisma();
    const [first, second, third] = EMAIL_DESIGN_LIBRARY;
    tables.platformEmailDesign.push(
      // Edited by an admin: the edit is what new workspaces get.
      { id: "p1", key: first!.key, name: "Launch (edited)", theme: { accent: "#ff0000" }, blocks: first!.blocks, status: "published", deletedAt: null },
      // Unpublished and deleted built-ins are not given out.
      { id: "p2", key: second!.key, name: second!.name, theme: {}, blocks: second!.blocks, status: "draft", deletedAt: null },
      { id: "p3", key: third!.key, name: third!.name, theme: {}, blocks: third!.blocks, status: "published", deletedAt: new Date() },
      // An entry an admin added is only offered in the gallery, never copied into every workspace.
      { id: "p4", key: "admin-made", name: "Admin made", theme: {}, blocks: [], status: "published", deletedAt: null },
    );
    const seeds = new LibrarySeedService(prisma);
    // Built-ins with no library row yet still arrive (the library is filled on start).
    expect((await seeds.seedWorkspace("w1")).designs).toBe(EMAIL_DESIGN_LIBRARY.length - 2);
    const edited = tables.emailDesign.find((d) => d.libraryKey === first!.key);
    expect(edited).toMatchObject({ name: "Launch (edited)", theme: { accent: "#ff0000" } });
    const keys = tables.emailDesign.map((d) => d.libraryKey);
    expect(keys).not.toContain(second!.key);
    expect(keys).not.toContain(third!.key);
    expect(keys).not.toContain("admin-made");
  });
});
