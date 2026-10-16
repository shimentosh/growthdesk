import { addMember, bootApp, createWorkspace, setPlan, signUp, type Agent, type TestApp } from "./helpers.js";
import { DispatcherService } from "../src/automation/dispatcher.service.js";
import { LeadRoutingService } from "../src/automation/lead-routing.service.js";

/*
 * Teams: who is in which team (and leads it), each team's workload, record
 * visibility (everyone vs team: members see their own, their teams' and
 * unowned records; managers still see all), teams as lead-routing pools,
 * the activity feed by team, and teams kept tidy when someone leaves.
 */
describe("Teams and record visibility", () => {
  let t: TestApp;
  let owner: Agent;
  let w: string;
  const agents: Record<string, Agent> = {};
  const ids: Record<string, string> = {};
  const team: Record<string, string> = {};
  const api = (p: string) => `/v1/workspaces/${w}${p}`;
  const me = async (a: Agent) => (await a.get("/v1/auth/me").expect(200)).body.data.user.id as string;
  const contactOf = async (fullName: string, ownerId: string | null) => (await owner.post(api("/contacts")).send({ fullName, email: `${fullName.replace(/\W/g, "").toLowerCase()}@x.example`, ownerId }).expect(201)).body.data.id as string;
  const visible = async (a: Agent) => ((await a.get(api("/contacts?pageSize=100&filter=%7B%7D")).expect(200)).body.data.items as { fullName: string }[]).map((c) => c.fullName).sort();

  beforeAll(async () => {
    t = await bootApp();
    owner = await signUp(t, "teams-owner@acme.test", "Tess Owner");
    w = await createWorkspace(owner, "Teams Co");
    await setPlan(t, w, "agency");
    for (const [n, role] of [["ana", "member"], ["ben", "member"], ["cat", "member"], ["max", "manager"]] as const) {
      agents[n] = await addMember(t, owner, w, `${n}@teams.test`, role);
      ids[n] = await me(agents[n]);
    }
  });
  afterAll(async () => t.close());

  it("creates teams with a lead from among their members, one name each", async () => {
    await owner.post(api("/teams")).send({ name: "Sales", memberIds: [ids.ana], leadUserId: ids.ben }).expect(400);
    team.sales = (await owner.post(api("/teams")).send({ name: "Sales", color: "green", memberIds: [ids.ana, ids.ben], leadUserId: ids.ben }).expect(201)).body.data.id;
    team.marketing = (await owner.post(api("/teams")).send({ name: "Marketing", color: "purple", memberIds: [ids.cat] }).expect(201)).body.data.id;
    await owner.post(api("/teams")).send({ name: "sales" }).expect(409);
    await agents.ana!.post(api("/teams")).send({ name: "Rogue" }).expect(403);
  });

  it("lists teams with their workload", async () => {
    await contactOf("Ana Lead", ids.ana!);
    await contactOf("Ben Lead", ids.ben!);
    await contactOf("Cat Lead", ids.cat!);
    await contactOf("Max Lead", ids.max!);
    await contactOf("Nobody Lead", null);
    const list = (await agents.ana!.get(api("/teams")).expect(200)).body.data;
    expect(list.recordVisibility).toBe("everyone");
    const sales = list.teams.find((x: { name: string }) => x.name === "Sales");
    expect(sales).toMatchObject({ lead: { id: ids.ben }, workload: { openLeads: 2 } });
    expect(sales.members.map((m: { userId: string }) => m.userId).sort()).toEqual([ids.ana, ids.ben].sort());
  });

  it("narrows members to their own, their teams' and unowned records in team visibility", async () => {
    const all = ["Ana Lead", "Ben Lead", "Cat Lead", "Max Lead", "Nobody Lead"];
    expect(await visible(agents.cat!)).toEqual(all);
    await agents.max!.put(api("/record-visibility")).send({ recordVisibility: "team" }).expect(403);
    await owner.put(api("/record-visibility")).send({ recordVisibility: "team" }).expect(200);
    expect(await visible(agents.ana!)).toEqual(["Ana Lead", "Ben Lead", "Nobody Lead"]);
    expect(await visible(agents.cat!)).toEqual(["Cat Lead", "Nobody Lead"]);
    // A manager still sees everything; so does the owner.
    expect(await visible(agents.max!)).toEqual(all);
    // A record outside their teams is not reachable by id either.
    const maxLead = (await t.prisma.db.contact.findFirstOrThrow({ where: { workspaceId: w, fullName: "Max Lead" } })).id;
    await agents.ana!.get(api(`/contacts/${maxLead}`)).expect(404);
    await owner.put(api("/record-visibility")).send({ recordVisibility: "everyone" }).expect(200);
    expect(await visible(agents.cat!)).toEqual(all);
  });

  it("routes leads round robin across a team, as the team is when they arrive", async () => {
    await owner.put(api("/lead-routing")).send({ enabled: true, rules: [], fallback: { mode: "round_robin", teamId: team.sales } }).expect(200);
    await owner.put(api("/lead-routing")).send({ enabled: true, rules: [], fallback: { mode: "round_robin", teamId: "00000000-0000-4000-8000-000000000000" } }).expect(400);
    const created = [await contactOf("R1", null), await contactOf("R2", null)];
    const routing = t.app.get(LeadRoutingService);
    for (let i = 0; i < 3; i++) {
      const res = await t.app.get(DispatcherService).dispatchBatch();
      for (const r of res.routes) await routing.route(r.workspaceId, r.contactIds);
      if (!res.events) break;
    }
    const owners = await Promise.all(created.map(async (id) => (await t.prisma.db.contact.findFirstOrThrow({ where: { workspaceId: w, id } })).ownerId));
    expect(owners.sort()).toEqual([ids.ana, ids.ben].sort());
  });

  it("filters the activity feed by team", async () => {
    await agents.cat!.patch(api(`/contacts/${(await t.prisma.db.contact.findFirstOrThrow({ where: { workspaceId: w, fullName: "Cat Lead" } })).id}`)).send({ jobTitle: "Buyer" }).expect(200);
    await agents.ana!.patch(api(`/contacts/${(await t.prisma.db.contact.findFirstOrThrow({ where: { workspaceId: w, fullName: "Ana Lead" } })).id}`)).send({ ownerId: ids.ben }).expect(200);
    const items = (await owner.get(api(`/activity?teamId=${team.marketing}`)).expect(200)).body.data.items as { actor: { id: string | null } }[];
    expect(items.every((i) => i.actor.id === ids.cat)).toBe(true);
    const sales = (await owner.get(api(`/activity?teamId=${team.sales}`)).expect(200)).body.data.items as { actor: { id: string | null } }[];
    expect(sales.some((i) => i.actor.id === ids.ana)).toBe(true);
  });

  it("takes someone out of their teams when they leave, passing a team they led to the heir", async () => {
    const membership = (await owner.get(api("/members")).expect(200)).body.data.members.find((m: { userId: string }) => m.userId === ids.ben);
    await owner.delete(api(`/members/${membership.id}?handoverTo=${ids.max}`)).expect(200);
    const sales = (await owner.get(api("/teams")).expect(200)).body.data.teams.find((x: { name: string }) => x.name === "Sales");
    expect(sales.lead).toMatchObject({ id: ids.max });
    expect(sales.members.map((m: { userId: string }) => m.userId).sort()).toEqual([ids.ana, ids.max].sort());
  });
});
