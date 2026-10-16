import { addMember, bootApp, createWorkspace, setPlan, signUp, type Agent, type TestApp } from "./helpers.js";

/*
 * The manager's team overview: per person workload and slipping work
 * (overdue tasks, stale leads, replies waiting, deals with no next step),
 * speed to lead, and alerts — including someone paused who still owns work
 * and replies with nobody to answer. Managers see it; members do not.
 */
describe("Team overview", () => {
  let t: TestApp;
  let owner: Agent;
  let w: string;
  const agents: Record<string, Agent> = {};
  const ids: Record<string, string> = {};
  const api = (p: string) => `/v1/workspaces/${w}${p}`;
  const me = async (a: Agent) => (await a.get("/v1/auth/me").expect(200)).body.data.user.id as string;
  const ago = (ms: number) => new Date(Date.now() - ms);
  const H = 3_600_000;
  const lead = async (fullName: string, ownerId: string | null) => (await owner.post(api("/contacts")).send({ fullName, email: `${fullName.replace(/\W/g, "").toLowerCase()}@x.example`, ownerId }).expect(201)).body.data.id as string;
  const backdate = async (contactId: string, at: Date) => {
    await t.prisma.db.contact.update({ where: { id: contactId, workspaceId: w }, data: { createdAt: at } });
    await t.prisma.db.activity.updateMany({ where: { workspaceId: w, contactId }, data: { occurredAt: at } });
  };

  beforeAll(async () => {
    t = await bootApp();
    owner = await signUp(t, "overview-owner@acme.test", "Olga Owner");
    w = await createWorkspace(owner, "Overview Co");
    await setPlan(t, w, "agency");
    for (const [k, role] of [["ana", "member"], ["ben", "member"], ["max", "manager"], ["vic", "viewer"], ["pat", "member"]] as const) {
      agents[k] = await addMember(t, owner, w, `${k}@overview.test`, role);
      ids[k] = await me(agents[k]);
    }

    // Ana: a stale lead (20 days, nothing since), a fresh lead she emailed after 30 minutes, and a reply waiting two days.
    const stale = await lead("Stale Sam", ids.ana!);
    await backdate(stale, ago(20 * 24 * H));
    const quick = await lead("Quick Quinn", ids.ana!);
    await backdate(quick, ago(2 * H));
    await t.prisma.db.activity.create({ data: { workspaceId: w, contactId: quick, actorId: ids.ana, actorType: "user", type: "email.sent", summary: "Email sent: Hi", occurredAt: new Date(Date.now() - 2 * H + 30 * 60_000) } });
    const mailbox = await t.prisma.db.mailbox.findFirst({ where: { workspaceId: w } });
    const convo = (data: Record<string, unknown>) =>
      t.prisma.db.conversation.create({ data: { workspaceId: w, channel: "email", externalKey: `test:${Math.random().toString(36).slice(2)}`, status: "open", unread: true, lastMessageAt: new Date(), mailboxId: mailbox?.id ?? null, ...data } as never });
    await convo({ contactId: stale, peer: "stalesam@x.example", subject: "Still there?", lastInboundAt: ago(48 * H) });
    // Nobody's: no assignee, no contact.
    await convo({ peer: "stranger@x.example", subject: "Who handles this?", lastInboundAt: ago(H) });

    // Ben: an overdue task and an open deal with no next step.
    const benLead = await lead("Ben Buyer", ids.ben!);
    await owner.post(api("/tasks")).send({ title: "Call back", assigneeId: ids.ben, contactId: benLead, dueAt: ago(3 * 24 * H).toISOString() }).expect(201);
    const pipeline = await t.prisma.db.pipeline.findFirstOrThrow({ where: { workspaceId: w }, include: { stages: { orderBy: { position: "asc" } } } });
    await t.prisma.db.deal.create({ data: { workspaceId: w, pipelineId: pipeline.id, stageId: pipeline.stages[0]!.id, name: "Ben's big deal", value: 5000, currency: "USD", ownerId: ids.ben, contactId: benLead } as never });

    // Nobody owns this one.
    await lead("Orphan Olly", null);

    // Pat is paused but still owns a lead.
    await lead("Pat's Lead", ids.pat!);
    await t.prisma.db.membership.update({ where: { workspaceId_userId: { workspaceId: w, userId: ids.pat! } }, data: { deactivatedAt: new Date() } });
  });
  afterAll(async () => t.close());

  it("is for managers, not members", async () => {
    await agents.ana!.get(api("/team-overview")).expect(403);
    await agents.max!.get(api("/team-overview")).expect(200);
  });

  it("shows each person's workload and what is slipping", async () => {
    const o = (await owner.get(api("/team-overview")).expect(200)).body.data;
    const person = (id: string) => o.people.find((p: { userId: string }) => p.userId === id);
    // Viewers and paused people are not in the list.
    expect(person(ids.vic!)).toBeUndefined();
    expect(person(ids.pat!)).toBeUndefined();
    expect(person(ids.ana!)).toMatchObject({ openLeads: 2, staleLeads: 1, waitingReplies: 1, waitingOver24h: 1, speedToLeadMinutes: 30, untouchedLeads: 1 });
    expect(person(ids.ben!)).toMatchObject({ openLeads: 1, openDeals: 1, openDealValue: 5000, overdueTasks: 1, openTasks: 1, dealsNoNextStep: 1 });
    expect(o.totals).toMatchObject({ unownedLeads: 1, unassignedReplies: 1, overdueTasks: 1, staleLeads: 1, dealsNoNextStep: 1 });
    // Ana and Ben have slipping work, so they come first.
    expect([o.people[0].userId, o.people[1].userId].sort()).toEqual([ids.ana, ids.ben].sort());
  });

  it("raises alerts that point at the list to fix", async () => {
    const o = (await owner.get(api("/team-overview")).expect(200)).body.data;
    const keys = o.alerts.map((a: { key: string }) => a.key);
    expect(keys).toEqual(expect.arrayContaining(["unassigned_replies", "waiting_24h", "unowned_leads", "overdue_tasks", "stale_leads", "no_next_step", "paused_with_work"]));
    expect(o.alerts.find((a: { key: string }) => a.key === "paused_with_work")).toMatchObject({ userId: ids.pat, severity: "high", href: "/settings/members" });
    expect(o.alerts.find((a: { key: string }) => a.key === "unowned_leads")).toMatchObject({ count: 1, href: "/leads?owner=none" });
    // High first.
    const rank = { high: 0, medium: 1, low: 2 } as Record<string, number>;
    const ranks = o.alerts.map((a: { severity: string }) => rank[a.severity]);
    expect([...ranks].sort()).toEqual(ranks);
  });

  it("flags someone away who still has work waiting", async () => {
    await t.prisma.db.user.update({ where: { id: ids.ana! }, data: { outOfOfficeUntil: new Date(Date.now() + 48 * H) } });
    const o = (await owner.get(api("/team-overview")).expect(200)).body.data;
    expect(o.totals.away).toBe(1);
    expect(o.alerts.find((a: { key: string }) => a.key === "away_with_work")).toMatchObject({ userId: ids.ana });
    await t.prisma.db.user.update({ where: { id: ids.ana! }, data: { outOfOfficeUntil: null } });
  });

  it("narrows to one team", async () => {
    const team = (await owner.post(api("/teams")).send({ name: "Closers", memberIds: [ids.ben] }).expect(201)).body.data.id;
    const o = (await owner.get(api(`/team-overview?teamId=${team}`)).expect(200)).body.data;
    expect(o.people.map((p: { userId: string }) => p.userId)).toEqual([ids.ben]);
    expect(o.totals.overdueTasks).toBe(1);
    expect(o.totals.staleLeads).toBe(0);
    await owner.get(api("/team-overview?teamId=00000000-0000-4000-8000-000000000000")).expect(404);
  });
});
