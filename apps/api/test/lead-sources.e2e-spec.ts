import { bootApp, createWorkspace, setPlan, signUp, type Agent, type TestApp } from "./helpers.js";

/*
 * Lead sourcing: the Source filter's choices (GET /contacts/lead-sources),
 * filtering by one source or several (case ignored), and the "Leads by
 * source" report (GET /analytics/sources) — leads, qualified, with a deal,
 * won and revenue won per source.
 */
describe("Lead sources", () => {
  let t: TestApp;
  let owner: Agent;
  let w: string;
  const api = (path: string) => `/v1/workspaces/${w}${path}`;
  const today = new Date().toISOString().slice(0, 10);

  beforeAll(async () => {
    t = await bootApp();
    owner = await signUp(t, "sources-owner@acme.test");
    w = await createWorkspace(owner, "Sources Co");
    await setPlan(t, w, "growth");
    const add = (fullName: string, leadSource: string, qualification?: string) =>
      owner.post(api("/contacts")).send({ fullName, email: `${fullName.toLowerCase().replace(/\s+/g, ".")}@x.test`, leadSource, ...(qualification ? { qualification } : {}) }).expect(201);
    await add("Web One", "Clientdesk · Website", "qualified");
    await add("Web Two", "clientdesk · website");
    await add("Form One", "Clientdesk · Website form");
    await add("Nobody Knows", "");
    const won = (await add("Form Two", "Clientdesk · Website form", "qualified")).body.data;

    // A won deal for Form Two, in the workspace currency.
    const pipeline = await t.prisma.db.pipeline.findFirstOrThrow({ where: { workspaceId: w }, include: { stages: true } });
    const ws = await t.prisma.db.workspace.findUniqueOrThrow({ where: { id: w } });
    await t.prisma.db.deal.create({
      data: { workspaceId: w, name: "Form Two deal", pipelineId: pipeline.id, stageId: pipeline.stages[0]!.id, contactId: won.id, value: 1500, currency: ws.currency, status: "won" },
    });
  });
  afterAll(async () => t.close());

  it("lists each source with a count, case and spacing ignored, most first", async () => {
    const res = await owner.get(api("/contacts/lead-sources")).expect(200);
    expect(res.body.data).toEqual([
      { source: expect.stringMatching(/^clientdesk · website$/i), count: 2 },
      { source: "Clientdesk · Website form", count: 2 },
      { source: "", count: 1 },
    ]);
  });

  it("filters by one source or several", async () => {
    const one = await owner.get(api("/contacts")).query({ filter: JSON.stringify({ leadSource: "CLIENTDESK · WEBSITE" }) }).expect(200);
    expect(one.body.data.total).toBe(2);
    const two = await owner.get(api("/contacts")).query({ filter: JSON.stringify({ leadSource: ["Clientdesk · Website", "Clientdesk · Website form"] }) }).expect(200);
    expect(two.body.data.total).toBe(4);
  });

  it("reports leads, qualified, deals and revenue won per source", async () => {
    const res = await owner.get(api("/analytics/sources")).query({ from: today, to: today }).expect(200);
    const d = res.body.data;
    const form = d.sources.find((x: { source: string }) => x.source === "Clientdesk · Website form");
    expect(form).toMatchObject({ leads: 2, qualified: 1, withDeal: 1, won: 1, wonValue: 1500, winRate: 0.5 });
    const web = d.sources.find((x: { source: string }) => x.source.toLowerCase() === "clientdesk · website");
    expect(web).toMatchObject({ leads: 2, qualified: 1, withDeal: 0, won: 0, wonValue: 0 });
    expect(d.totals).toMatchObject({ leads: 5, won: 1, wonValue: 1500 });
  });
});
