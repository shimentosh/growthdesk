import { addMember, bootApp, createWorkspace, setPlan, signUp, type Agent, type TestApp } from "./helpers.js";

/*
 * Global search (GET /workspaces/:id/search): one query across contacts,
 * companies, deals, conversations, campaigns, lists, templates, workflows and
 * tasks — each group with its list endpoint's permission and ownership scope,
 * best matches first.
 */
describe("Global search", () => {
  let t: TestApp;
  let owner: Agent;
  let w: string;
  const api = (p: string) => `/v1/workspaces/${w}${p}`;
  type Hit = { id: string; title: string; subtitle: string | null; badge: string | null; kind?: string; value?: number };
  type Groups = Record<string, { items: Hit[]; more: boolean }>;
  const search = async (a: Agent, q: string, limit?: number) =>
    (await a.get(api(`/search?q=${encodeURIComponent(q)}${limit ? `&limit=${limit}` : ""}`)).expect(200)).body.data.groups as Groups;
  const titles = (g: Groups, key: string) => (g[key]?.items ?? []).map((i) => i.title);
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    t = await bootApp();
    owner = await signUp(t, "search-owner@acme.test", "Sara Owner");
    w = await createWorkspace(owner, "Search Co");
    await setPlan(t, w, "agency");

    const company = (await owner.post(api("/companies")).send({ name: "Zephyr Corp", domain: "zephyr.example" }).expect(201)).body.data.id;
    ids.company = company;
    ids.lead = (await owner.post(api("/contacts")).send({ fullName: "Zephyr Adams", email: "zadams@lead.example", lifecycleStage: "lead" }).expect(201)).body.data.id;
    // Matches only through the company name: ranks after the name match.
    ids.viaCompany = (await owner.post(api("/contacts")).send({ fullName: "Ana Smith", email: "ana@corp.example", companyId: company }).expect(201)).body.data.id;
    const pipeline = (await owner.get(api("/pipelines")).expect(200)).body.data[0];
    ids.deal = (await owner.post(api("/deals")).send({ name: "Zephyr renewal", pipelineId: pipeline.id, value: 5000, companyId: company }).expect(201)).body.data.id;
    ids.campaign = (await owner.post(api("/campaigns")).send({ name: "Zephyr outbound" }).expect(201)).body.data.id;
    ids.marketing = (await t.prisma.db.marketingCampaign.create({ data: { workspaceId: w, name: "Zephyr newsletter", subject: "News" } })).id;
    ids.list = (await owner.post(api("/marketing/lists")).send({ name: "Zephyr webinar" }).expect(201)).body.data.id;
    ids.template = (await owner.post(api("/templates")).send({ name: "Zephyr intro", subject: "Hello", body: "Hi there" }).expect(201)).body.data.id;
    ids.design = (await t.prisma.db.emailDesign.create({ data: { workspaceId: w, name: "Zephyr design" } })).id;
    ids.workflow = (
      await owner
        .post(api("/workflows"))
        .send({ name: "Zephyr routing", trigger: "contact.created", conditions: [], actions: [{ type: "create_task", config: { title: "Call them" } }] })
        .expect(201)
    ).body.data.id;
    ids.task = (await owner.post(api("/tasks")).send({ title: "Call Zephyr", contactId: ids.lead }).expect(201)).body.data.id;
    ids.conversation = (
      await t.prisma.db.conversation.create({
        data: { workspaceId: w, channel: "email", contactId: ids.lead, subject: "Zephyr pricing question", externalKey: `seed:search:${Math.random()}`, handle: "zadams@lead.example" },
      })
    ).id;
  });
  afterAll(async () => t.close());

  it("finds every kind of record, grouped, with the details the palette shows", async () => {
    const g = await search(owner, "zephyr");
    expect(Object.keys(g).sort()).toEqual(["campaigns", "companies", "contacts", "conversations", "deals", "lists", "tasks", "templates", "workflows"]);

    // Name and email prefix matches before a match through the company.
    expect(titles(g, "contacts")).toEqual(["Zephyr Adams", "Ana Smith"]);
    expect(g.contacts!.items[0]).toMatchObject({ id: ids.lead, badge: "lead", subtitle: "zadams@lead.example" });
    expect(g.contacts!.items[1]).toMatchObject({ subtitle: "ana@corp.example · Zephyr Corp" });

    expect(g.companies!.items).toEqual([expect.objectContaining({ id: ids.company, title: "Zephyr Corp", subtitle: "zephyr.example" })]);
    expect(g.deals!.items).toEqual([expect.objectContaining({ id: ids.deal, title: "Zephyr renewal", value: 5000, currency: expect.any(String), badge: expect.any(String) })]);
    expect(g.conversations!.items).toEqual([expect.objectContaining({ id: ids.conversation, title: "Zephyr pricing question", subtitle: "Zephyr Adams", kind: "email" })]);
    expect(g.campaigns!.items.map((c) => [c.id, c.kind]).sort()).toEqual([[ids.campaign, "outreach"], [ids.marketing, "marketing"]].sort());
    expect(g.lists!.items.map((l) => l.id)).toEqual([ids.list]);
    expect(g.templates!.items.map((x) => [x.id, x.kind]).sort()).toEqual([[ids.template, "template"], [ids.design, "design"]].sort());
    expect(g.workflows!.items).toEqual([expect.objectContaining({ id: ids.workflow, title: "Zephyr routing" })]);
    expect(g.tasks!.items).toEqual([expect.objectContaining({ id: ids.task, title: "Call Zephyr", badge: "open", subtitle: "Zephyr Adams" })]);
  });

  it("puts exact and prefix matches first, is case-insensitive, and caps each group", async () => {
    for (const n of ["Quasar Three", "Big Quasar", "Quasar", "Quasar Two"]) {
      await owner.post(api("/companies")).send({ name: n }).expect(201);
    }
    const g = await search(owner, "QUASAR", 3);
    expect(titles(g, "companies")[0]).toBe("Quasar");
    expect(titles(g, "companies").slice(1).sort()).toEqual(["Quasar Three", "Quasar Two"]);
    expect(g.companies!.more).toBe(true);

    const all = await search(owner, "quasar", 10);
    expect(titles(all, "companies").at(-1)).toBe("Big Quasar");
    expect(all.companies!.more).toBe(false);
  });

  it("answers an empty query with no groups and refuses a silly limit", async () => {
    expect(await search(owner, "   ")).toEqual({});
    await owner.get(api("/search?q=zephyr&limit=500")).expect(400);
  });

  it("leaves out groups the role cannot read and keeps other people's records hidden", async () => {
    const member = await addMember(t, owner, w, "search-member@acme.test", "member");
    // A narrowed member: no deals, campaigns, marketing or automation, and no records.view_all.
    await owner
      .put(api("/role-permissions"))
      .send({ role: "member", permissions: ["contacts.read", "contacts.write", "tasks.read", "tasks.write", "inbox.read", "templates.read"] })
      .expect(200);

    // Owned by the owner: hidden. Owned by the member, or by nobody: visible.
    await t.prisma.db.contact.update({ where: { id: ids.lead, workspaceId: w }, data: { ownerId: owner.userId } });
    await t.prisma.db.contact.update({ where: { id: ids.viaCompany, workspaceId: w }, data: { ownerId: null } });
    const mine = (await owner.post(api("/contacts")).send({ fullName: "Zephyr Mine", email: "mine@lead.example", ownerId: member.userId }).expect(201)).body.data.id;
    await t.prisma.db.company.update({ where: { id: ids.company, workspaceId: w }, data: { ownerId: owner.userId } });
    await t.prisma.db.task.update({ where: { id: ids.task, workspaceId: w }, data: { assigneeId: owner.userId } });
    await t.prisma.db.conversation.update({ where: { id: ids.conversation, workspaceId: w }, data: { assigneeId: owner.userId } });
    const openConvo = await t.prisma.db.conversation.create({
      data: { workspaceId: w, channel: "email", subject: "Zephyr unassigned thread", externalKey: `seed:search:${Math.random()}` },
    });

    const g = await search(member, "zephyr");
    expect(Object.keys(g).sort()).toEqual(["companies", "contacts", "conversations", "lists", "tasks", "templates"]);
    expect(g.deals).toBeUndefined();
    expect(g.campaigns).toBeUndefined();
    expect(g.workflows).toBeUndefined();

    expect(g.contacts!.items.map((c) => c.id).sort()).toEqual([mine, ids.viaCompany].sort());
    expect(g.companies!.items).toEqual([]);
    expect(g.tasks!.items).toEqual([]);
    expect(g.conversations!.items.map((c) => c.id)).toEqual([openConvo.id]);
    // Templates without marketing.read: message templates only, no email designs.
    expect(g.templates!.items.map((x) => x.kind)).toEqual(["template"]);

    // The owner still sees everything.
    const o = await search(owner, "zephyr");
    expect(o.contacts!.items.map((c) => c.id)).toEqual(expect.arrayContaining([ids.lead, ids.viaCompany, mine]));
    expect(o.deals!.items).toHaveLength(1);
  });

  it("is not reachable from another workspace", async () => {
    const stranger = await signUp(t, "search-stranger@acme.test");
    // The guard does not confirm that someone else's workspace exists.
    await stranger.get(api("/search?q=zephyr")).expect(404);
  });
});
