import { bootApp, createWorkspace, setPlan, signUp, type Agent, type TestApp } from "./helpers.js";

/*
 * Clients and orders from a client portal (src/commerce): a client becomes a
 * contact past the lead stage, with its company and `customerSince`; orders
 * are upserted by external id and roll up into the contact's totals (placed,
 * paid, spent, first/last, last purchase), a paid one making a customer; each
 * order.* moment is one event, never repeated by a re-send; one bad record
 * fails alone; the scope guards the doors.
 */
describe("Commerce: clients and orders", () => {
  let t: TestApp;
  let owner: Agent;
  let w: string;
  let key: string;
  const api = (path: string) => `/v1/workspaces/${w}${path}`;
  const bearer = (secret: string) => ({ Authorization: `Bearer ${secret}` });
  const post = (path: string, body: unknown, secret = key) => t.http().post(api(path)).set(bearer(secret)).send(body as object);

  beforeAll(async () => {
    t = await bootApp();
    owner = await signUp(t, "commerce-owner@acme.test");
    w = await createWorkspace(owner, "Commerce Co");
    await setPlan(t, w, "growth");
    key = (await owner.post(api("/api-keys")).send({ name: "Clientdesk", scopes: ["contacts:read"], app: "clientdesk" }).expect(201)).body.data.secret;
    // Grace wrote in through the website before she became a client.
    await post("/leads", { source: "clientdesk", leads: [{ externalId: "led_1", fullName: "Grace Hopper", email: "grace@navy.test", leadSource: "Clientdesk · Website form" }] }).expect(200);
    await t.http().put(api("/catalog/sync")).set(bearer(key)).send({ source: "clientdesk", items: [{ externalId: "tier:seo_pro", name: "SEO audit · Pro", unitPrice: 600, currency: "USD" }] }).expect(200);
  });
  afterAll(async () => t.close());

  it("refuses a key without customers:write", async () => {
    const other = (await owner.post(api("/api-keys")).send({ name: "Leads only", scopes: ["leads:write"] }).expect(201)).body.data.secret;
    await post("/commerce/customers", { source: "clientdesk", customers: [{ externalId: "per_x" }] }, other).expect(403);
    await t.http().get(api("/commerce/status")).set(bearer(key)).expect(200);
  });

  it("makes clients contacts past the lead stage, with their company, and lets a bad one fail alone", async () => {
    const res = await post("/commerce/customers", {
      source: "clientdesk",
      customers: [
        { externalId: "per_grace", fullName: "Grace Hopper", email: "grace@navy.test", company: { externalId: "cmp_navy", name: "US Navy", domain: "navy.test" }, since: "2026-01-05T10:00:00Z", status: "VIP" },
        { externalId: "per_alan", fullName: "Alan Turing", email: "alan@bletchley.test", company: { externalId: "cmp_bp", name: "Bletchley Park" } },
        { externalId: "per_bad", email: "not-an-email" },
      ],
    }).expect(200);
    const d = res.body.data;
    expect(d.summary).toMatchObject({ received: 3, created: 1, updated: 1, failed: 1 });
    expect(d.results[2].error.code).toBe("validation_failed");

    const grace = await t.prisma.db.contact.findFirstOrThrow({ where: { workspaceId: w, email: "grace@navy.test" }, include: { company: true } });
    // The lead she was is the client she is: same contact, moved on, first source kept.
    expect(d.results[0].contactId).toBe(grace.id);
    expect(grace).toMatchObject({ lifecycleStage: "contact", leadSource: "Clientdesk · Website form" });
    expect(grace.customerSince?.toISOString()).toBe("2026-01-05T10:00:00.000Z");
    expect(grace.company).toMatchObject({ name: "US Navy", externalSource: "clientdesk", externalId: "cmp_navy" });

    const added = await t.prisma.db.domainEvent.findMany({ where: { workspaceId: w, type: "client.added" } });
    expect(added).toHaveLength(2);

    // Again: nothing new, no second client.added.
    await post("/commerce/customers", { source: "clientdesk", customers: [{ externalId: "per_grace", fullName: "Grace Hopper", email: "grace@navy.test" }] }).expect(200);
    expect(await t.prisma.db.domainEvent.count({ where: { workspaceId: w, type: "client.added" } })).toBe(2);
  });

  it("rolls orders up into the contact's totals and makes a paying client a customer", async () => {
    const order = (o: Record<string, unknown>) => ({ customerExternalId: "per_grace", currency: "usd", placedAt: "2026-02-01T09:00:00Z", items: [], ...o });
    const res = await post("/commerce/orders", {
      source: "clientdesk",
      orders: [
        order({ externalId: "ord_1", number: "ORD-100001", status: "Completed", state: "completed", paid: true, total: 600, placedAt: "2026-02-01T09:00:00Z", items: [{ name: "SEO audit · Pro", quantity: 1, unitPrice: 600, total: 600, productExternalId: "tier:seo_pro" }] }),
        order({ externalId: "ord_2", number: "ORD-100002", status: "In progress", state: "open", paid: true, total: 350.5, placedAt: "2026-03-01T09:00:00Z", items: [{ name: "Guest posts · DR 50+", quantity: 1, unitPrice: 350.5, total: 350.5 }] }),
        order({ externalId: "ord_3", number: "ORD-100003", status: "Cancelled", state: "cancelled", paid: false, total: 99, placedAt: "2026-03-05T09:00:00Z" }),
        order({ externalId: "ord_4", number: "ORD-100004", status: "Awaiting brief", state: "open", paid: false, total: 120, placedAt: "2026-04-01T09:00:00Z", items: [{ name: "Link audit", total: 120 }] }),
        { externalId: "ord_bad", state: "open" },
      ],
    }).expect(200);
    expect(res.body.data.summary).toMatchObject({ received: 5, created: 4, failed: 1 });

    const grace = await t.prisma.db.contact.findFirstOrThrow({ where: { workspaceId: w, email: "grace@navy.test" } });
    expect(grace).toMatchObject({ ordersCount: 3, paidOrdersCount: 2, spentCurrency: "USD", status: "customer", lastPurchase: "Link audit" });
    expect(Number(grace.totalSpent)).toBe(950.5);
    expect(grace.firstOrderAt?.toISOString()).toBe("2026-02-01T09:00:00.000Z");
    expect(grace.lastOrderAt?.toISOString()).toBe("2026-04-01T09:00:00.000Z");

    const first = await t.prisma.db.order.findFirstOrThrow({ where: { workspaceId: w, externalId: "ord_1" } });
    const product = await t.prisma.db.product.findFirstOrThrow({ where: { workspaceId: w, externalId: "tier:seo_pro" } });
    expect((first.items as { productId?: string }[])[0]!.productId).toBe(product.id);

    const types = (await t.prisma.db.domainEvent.findMany({ where: { workspaceId: w, type: { startsWith: "order." } } })).map((e) => e.type).sort();
    expect(types).toEqual(["order.cancelled", "order.completed", "order.created", "order.created", "order.created", "order.created", "order.paid", "order.paid"]);
  });

  it("is idempotent on a re-send, and fires a moment once when an order reaches it", async () => {
    const before = await t.prisma.db.domainEvent.count({ where: { workspaceId: w, type: { startsWith: "order." } } });
    const again = await post("/commerce/orders", {
      source: "clientdesk",
      orders: [{ externalId: "ord_4", number: "ORD-100004", customerExternalId: "per_grace", status: "In progress", state: "open", paid: true, currency: "USD", total: 120, placedAt: "2026-04-01T09:00:00Z", items: [{ name: "Link audit", total: 120 }] }],
    }).expect(200);
    expect(again.body.data.results[0].status).toBe("updated");
    const after = await t.prisma.db.domainEvent.findMany({ where: { workspaceId: w, type: { startsWith: "order." } }, orderBy: { occurredAt: "desc" } });
    expect(after).toHaveLength(before + 1);
    expect(after[0]!.type).toBe("order.paid");

    const same = await post("/commerce/orders", {
      source: "clientdesk",
      orders: [{ externalId: "ord_4", number: "ORD-100004", customerExternalId: "per_grace", status: "In progress", state: "open", paid: true, currency: "USD", total: 120, placedAt: "2026-04-01T09:00:00Z", items: [{ name: "Link audit", total: 120 }] }],
    }).expect(200);
    expect(same.body.data.results[0].status).toBe("unchanged");
    expect(await t.prisma.db.domainEvent.count({ where: { workspaceId: w, type: { startsWith: "order." } } })).toBe(before + 1);

    const grace = await t.prisma.db.contact.findFirstOrThrow({ where: { workspaceId: w, email: "grace@navy.test" } });
    expect(grace.paidOrdersCount).toBe(3);
    expect(Number(grace.totalSpent)).toBe(1070.5);
  });

  it("lists a contact's orders on its page, newest first", async () => {
    const grace = await t.prisma.db.contact.findFirstOrThrow({ where: { workspaceId: w, email: "grace@navy.test" } });
    const res = await owner.get(api(`/contacts/${grace.id}/orders`)).expect(200);
    expect(res.body.data.map((o: { number: string }) => o.number)).toEqual(["ORD-100004", "ORD-100003", "ORD-100002", "ORD-100001"]);
    expect(res.body.data[3]).toMatchObject({ state: "completed", paid: true, total: 600, items: [{ name: "SEO audit · Pro", quantity: 1, total: 600 }] });

    const status = await t.http().get(api("/commerce/status")).set(bearer(key)).expect(200);
    expect(status.body.data).toMatchObject({ clients: 2, orders: 4 });
  });
});
