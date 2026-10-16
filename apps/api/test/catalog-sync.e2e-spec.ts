import { bootApp, createWorkspace, setPlan, signUp, type Agent, type TestApp } from "./helpers.js";

/*
 * The client portal keeps its services in step as Products: PUT the whole
 * catalog with a products:write key; new items are created, changed ones
 * updated, missing ones archived, returning ones restored.
 */
describe("Catalog sync (client portal services → products)", () => {
  let t: TestApp;
  let owner: Agent;
  let w: string;
  let secret: string;

  const sync = (body: object, key = secret) =>
    t.http().put(`/v1/workspaces/${w}/catalog/sync`).set({ Authorization: `Bearer ${key}` }).send(body);

  const tier = (id: string, over: Record<string, unknown> = {}) => ({
    externalId: `tier:${id}`,
    name: `Guest Posts · ${id}`,
    groupName: "Guest Posts",
    category: "Link Building",
    unit: "guest post",
    unitPrice: 200,
    costPrice: 90,
    currency: "usd",
    billingPeriod: "one_time",
    metadata: { serviceId: "svc_guest_posts", tierId: id, tatDays: 14, features: ["DR 30+", "Do-follow"] },
    ...over,
  });

  beforeAll(async () => {
    t = await bootApp();
    owner = await signUp(t, "owner@catalog.test");
    w = await createWorkspace(owner, "Catalog Co");
    await setPlan(t, w, "growth");
    secret = (await owner.post(`/v1/workspaces/${w}/api-keys`).send({ name: "Client portal", scopes: ["products:write"] }).expect(201)).body.data.secret;
  });
  afterAll(async () => t.close());

  it("creates every item of the first sync, keeping cost, unit and the source's details", async () => {
    const res = await sync({ source: "clientdesk", items: [tier("dr30"), tier("dr50", { name: "Guest Posts · DR 50+", unitPrice: 350, costPrice: 155 })] }).expect(200);
    expect(res.body.data).toMatchObject({ source: "clientdesk", received: 2, created: 2, updated: 0, archived: 0 });
    const p = await t.prisma.db.product.findFirstOrThrow({ where: { workspaceId: w, externalId: "tier:dr50" } });
    expect(p).toMatchObject({ source: "clientdesk", name: "Guest Posts · DR 50+", groupName: "Guest Posts", category: "Link Building", unit: "guest post", currency: "USD", archivedAt: null });
    expect(p.unitPrice.toFixed(2)).toBe("350.00");
    expect(p.costPrice?.toFixed(2)).toBe("155.00");
    expect(p.metadata).toMatchObject({ tatDays: 14, features: ["DR 30+", "Do-follow"] });
    expect(p.syncedAt).not.toBeNull();
  });

  it("is idempotent: the same catalog again changes nothing", async () => {
    const res = await sync({ source: "clientdesk", items: [tier("dr30"), tier("dr50", { name: "Guest Posts · DR 50+", unitPrice: 350, costPrice: 155 })] }).expect(200);
    expect(res.body.data).toMatchObject({ created: 0, updated: 0, unchanged: 2, archived: 0 });
  });

  it("updates changed items, archives the ones no longer listed, and leaves hand-made products alone", async () => {
    await t.prisma.db.product.create({ data: { workspaceId: w, name: "Hand-made consulting", unitPrice: 100 } });
    const res = await sync({ source: "clientdesk", items: [tier("dr30", { unitPrice: 220, metadata: { tatDays: 10 } })] }).expect(200);
    expect(res.body.data).toMatchObject({ created: 0, updated: 1, archived: 1 });
    const dr30 = await t.prisma.db.product.findFirstOrThrow({ where: { workspaceId: w, externalId: "tier:dr30" } });
    expect(dr30.unitPrice.toFixed(2)).toBe("220.00");
    expect(dr30.metadata).toEqual({ tatDays: 10 });
    expect((await t.prisma.db.product.findFirstOrThrow({ where: { workspaceId: w, externalId: "tier:dr50" } })).archivedAt).not.toBeNull();
    expect((await t.prisma.db.product.findFirstOrThrow({ where: { workspaceId: w, name: "Hand-made consulting" } })).archivedAt).toBeNull();
  });

  it("restores an item that comes back, and archives one marked inactive", async () => {
    const res = await sync({ source: "clientdesk", items: [tier("dr30", { unitPrice: 220, metadata: { tatDays: 10 }, active: false }), tier("dr50", { name: "Guest Posts · DR 50+", unitPrice: 350, costPrice: 155 })] }).expect(200);
    expect(res.body.data).toMatchObject({ restored: 1, archived: 1 });
    const rows = await t.prisma.db.product.findMany({ where: { workspaceId: w, source: "clientdesk" }, orderBy: { externalId: "asc" } });
    expect(rows.map((r) => [r.externalId, r.archivedAt === null])).toEqual([
      ["tier:dr30", false],
      ["tier:dr50", true],
    ]);
  });

  it("a partial sync (complete: false) only touches the items it lists", async () => {
    const res = await sync({ source: "clientdesk", complete: false, items: [tier("dr70", { unitPrice: 600 })] }).expect(200);
    expect(res.body.data).toMatchObject({ created: 1, archived: 0 });
    expect(await t.prisma.db.product.count({ where: { workspaceId: w, source: "clientdesk", archivedAt: null } })).toBe(2);
  });

  it("refuses duplicate ids, bad prices and keys without the scope", async () => {
    await sync({ source: "clientdesk", items: [tier("x"), tier("x")] }).expect(400);
    await sync({ source: "clientdesk", items: [tier("y", { unitPrice: -1 })] }).expect(400);
    await sync({ source: "somewhere-else", items: [] }).expect(400);
    const leadsOnly = (await owner.post(`/v1/workspaces/${w}/api-keys`).send({ name: "Leads", scopes: ["leads:write"] }).expect(201)).body.data.secret;
    await sync({ source: "clientdesk", items: [] }, leadsOnly).expect(403);
  });

  it("reports the sync status to the key and to the team", async () => {
    const viaKey = await t.http().get(`/v1/workspaces/${w}/catalog/sync`).set({ Authorization: `Bearer ${secret}` }).expect(200);
    expect(viaKey.body.data).toEqual([expect.objectContaining({ source: "clientdesk", products: 3, active: 2 })]);
    await owner.get(`/v1/workspaces/${w}/catalog/sync`).expect(200);
  });
});
