import { ApiError } from "../common/errors.js";
import type { PrismaService } from "../prisma/prisma.service.js";
import { McpConfirmationsService, pendingTrouble } from "./confirmations.service.js";
import type { McpCtx } from "./tool.js";

/** Just enough of prisma.db.mcpPendingAction for the lifecycle: equality, nulls and `{ gt }` in `where`. */
type Row = Record<string, unknown> & { id: string };
function fakePrisma() {
  const rows: Row[] = [];
  let n = 0;
  const matches = (row: Row, where: Record<string, unknown>) =>
    Object.entries(where).every(([k, v]) => {
      if (v && typeof v === "object" && "gt" in v) return (row[k] as Date).getTime() > ((v as { gt: Date }).gt as Date).getTime();
      return (row[k] ?? null) === v;
    });
  const table = {
    create: async ({ data }: { data: Record<string, unknown> }) => {
      const row = { id: `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`, confirmedAt: null, canceledAt: null, result: null, createdAt: new Date(), ...data };
      rows.push(row);
      return row;
    },
    findFirst: async ({ where }: { where: Record<string, unknown> }) => rows.find((r) => matches(r, where)) ?? null,
    findMany: async ({ where }: { where: Record<string, unknown> }) => rows.filter((r) => matches(r, where)),
    updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      const hit = rows.filter((r) => matches(r, where));
      for (const r of hit) Object.assign(r, data);
      return { count: hit.length };
    },
  };
  return { rows, prisma: { db: { mcpPendingAction: table } } as unknown as PrismaService };
}

const ctxFor = (tokenId: string, access: "read" | "build" | "send" = "send") =>
  ({
    requestId: "r",
    ip: "",
    userAgent: "",
    identity: { userId: "u1", email: "a@b.c", name: "A", platformRole: "none", emailVerified: true, twoFactor: false, sessionId: "mcp" },
    workspace: { id: "w1", name: "Acme", role: "owner", permissions: [], billingAccountId: "b", status: "active", timezone: "UTC", currency: "USD" },
    mcp: { tokenId, tokenName: "Claude", access, clientName: null, rolePermissions: [] },
  }) as McpCtx;

const message = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e instanceof ApiError ? e.message : String(e);
  }
  return null;
};

describe("pendingTrouble", () => {
  const now = new Date("2026-10-16T12:00:00Z");
  const base = { tokenId: "t1", expiresAt: new Date(now.getTime() + 60_000), confirmedAt: null, canceledAt: null };

  it("accepts a fresh action from its own token", () => {
    expect(pendingTrouble(base, "t1", now)).toBeNull();
  });
  it("is bound to the token that prepared it", () => {
    expect(pendingTrouble(base, "t2", now)).toMatch(/different connection/);
  });
  it("runs once", () => {
    expect(pendingTrouble({ ...base, confirmedAt: now }, "t1", now)).toMatch(/already confirmed/);
  });
  it("stops after cancel", () => {
    expect(pendingTrouble({ ...base, canceledAt: now }, "t1", now)).toMatch(/canceled/);
  });
  it("expires", () => {
    expect(pendingTrouble({ ...base, expiresAt: now }, "t1", now)).toMatch(/expired/);
  });
});

describe("McpConfirmationsService lifecycle", () => {
  it("creates a pending action that lapses after 10 minutes", async () => {
    const { prisma } = fakePrisma();
    const svc = new McpConfirmationsService(prisma);
    const now = new Date("2026-10-16T12:00:00Z");
    const row = await svc.create(ctxFor("t1"), "send_campaign", { id: "c1" }, { summary: "Send to 120 people", details: { recipients: 120 } }, now);
    expect(row.expiresAt.getTime() - now.getTime()).toBe(10 * 60_000);
    expect(row).toMatchObject({ tool: "send_campaign", tokenId: "t1", workspaceId: "w1", userId: "u1", preview: { recipients: 120 } });

    expect((await svc.open(ctxFor("t1"), row.id, new Date(now.getTime() + 9 * 60_000))).id).toBe(row.id);
    expect(await message(svc.open(ctxFor("t1"), row.id, new Date(now.getTime() + 10 * 60_000)))).toMatch(/expired/);
    expect(await message(svc.claim(ctxFor("t1"), row.id, new Date(now.getTime() + 11 * 60_000)))).toMatch(/runs only once|already/);
  });

  it("claims exactly once", async () => {
    const { prisma } = fakePrisma();
    const svc = new McpConfirmationsService(prisma);
    const row = await svc.create(ctxFor("t1"), "x", {}, { summary: "s" });
    await svc.claim(ctxFor("t1"), row.id);
    expect(await message(svc.claim(ctxFor("t1"), row.id))).toMatch(/only once/);
    expect(await message(svc.open(ctxFor("t1"), row.id))).toMatch(/already confirmed/);
  });

  it("is bound to its token: another token can neither open, claim nor cancel it", async () => {
    const { prisma, rows } = fakePrisma();
    const svc = new McpConfirmationsService(prisma);
    const row = await svc.create(ctxFor("t1"), "x", {}, { summary: "s" });
    expect(await message(svc.open(ctxFor("t2"), row.id))).toMatch(/different connection/);
    expect(await message(svc.claim(ctxFor("t2"), row.id))).toMatch(/only once/);
    expect(await message(svc.cancel(ctxFor("t2"), row.id))).toMatch(/different connection/);
    expect(rows[0]).toMatchObject({ confirmedAt: null, canceledAt: null });
  });

  it("cancel stops a later confirmation and hides it from the pending list", async () => {
    const { prisma } = fakePrisma();
    const svc = new McpConfirmationsService(prisma);
    const a = await svc.create(ctxFor("t1"), "x", {}, { summary: "a" });
    await svc.create(ctxFor("t1"), "x", {}, { summary: "b" });
    await svc.create(ctxFor("t2"), "x", {}, { summary: "other token" });
    expect((await svc.pending(ctxFor("t1"))).map((r) => r.summary).sort()).toEqual(["a", "b"]);
    await svc.cancel(ctxFor("t1"), a.id);
    expect((await svc.pending(ctxFor("t1"))).map((r) => r.summary)).toEqual(["b"]);
    expect(await message(svc.claim(ctxFor("t1"), a.id))).toMatch(/only once/);
  });

  it("answers not found for ids that are not uuids or not in the workspace", async () => {
    const { prisma } = fakePrisma();
    const svc = new McpConfirmationsService(prisma);
    expect(await message(svc.open(ctxFor("t1"), "nope"))).toMatch(/does not exist/);
    expect(await message(svc.open(ctxFor("t1"), "00000000-0000-4000-8000-000000000999"))).toMatch(/does not exist/);
  });
});
