import { addMember, bootApp, createWorkspace, setPlan, signUp, type Agent, type TestApp } from "./helpers.js";
import { ScoringService } from "../src/scoring/scoring.service.js";
import { Queues } from "../src/queues/queues.js";

/*
 * Lead scoring: rules CRUD behind settings.manage, the recommended set,
 * turning it on scores everyone, events (opens, meetings, calls,
 * unsubscribes) raise and lower scores and age out of their windows, the
 * first hot crossing is logged and told to the owner once, scoring off
 * leaves hand-set scores alone, and nothing crosses workspaces.
 */
describe("Lead scoring", () => {
  let t: TestApp;
  let owner: Agent;
  let member: Agent;
  let viewer: Agent;
  let other: Agent;
  let w: string;
  let w2: string;
  let scoring: ScoringService;
  const api = (p: string, ws = w) => `/v1/workspaces/${ws}${p}`;
  const ids: Record<string, string> = {};
  const DAY = 86_400_000;

  const contact = (id: string) => t.prisma.db.contact.findFirstOrThrow({ where: { workspaceId: w, id } });
  /** What the worker does for one contact. */
  const rescore = (id: string, ws = w) => scoring.recomputeContacts(ws, [id]);

  beforeAll(async () => {
    t = await bootApp();
    scoring = t.app.get(ScoringService);
    owner = await signUp(t, "score-owner@acme.test", "Sara Owner");
    w = await createWorkspace(owner, "Scoring Co");
    await setPlan(t, w, "agency");
    member = await addMember(t, owner, w, "score-member@acme.test", "member");
    viewer = await addMember(t, owner, w, "score-viewer@acme.test", "viewer");
    other = await signUp(t, "score-other@else.test", "Otto Other");
    w2 = await createWorkspace(other, "Elsewhere");

    const company = (await owner.post(api("/companies")).send({ name: "Acme Ltd" }).expect(201)).body.data.id;
    ids.ceo = (
      await owner
        .post(api("/contacts"))
        .send({ fullName: "Cleo Chief", email: "cleo@acme.example", phone: "+447700900123", jobTitle: "Co-founder & CEO", leadSource: "Referral", companyId: company, ownerId: member.userId })
        .expect(201)
    ).body.data.id;
    ids.plain = (await owner.post(api("/contacts")).send({ fullName: "Pat Plain", email: "pat@plain.example", score: 55 }).expect(201)).body.data.id;
    ids.foreign = (await other.post(api("/contacts", w2)).send({ fullName: "Fay Foreign", email: "fay@else.example", score: 12 }).expect(201)).body.data.id;
  });
  afterAll(async () => t.close());

  it("reads rules with contacts.read and changes them only with settings.manage", async () => {
    const empty = (await viewer.get(api("/scoring")).expect(200)).body.data;
    expect(empty).toMatchObject({ settings: { enabled: false, hot: 70, warm: 40 }, rules: [] });

    const rule = { name: "Has a phone", category: "fit", field: "phone", op: "exists", points: 5 };
    await member.post(api("/scoring/rules")).send(rule).expect(403);
    await member.put(api("/scoring/settings")).send({ enabled: true }).expect(403);
    await owner.post(api("/scoring/rules")).send({ ...rule, field: "shoeSize" }).expect(400);
    await owner.post(api("/scoring/rules")).send({ name: "Bad", category: "engagement", event: "email.teleported", points: 5 }).expect(400);
    await owner.put(api("/scoring/settings")).send({ enabled: false, hot: 40, warm: 40 }).expect(400);

    const a = (await owner.post(api("/scoring/rules")).send(rule).expect(201)).body.data;
    const b = (await owner.post(api("/scoring/rules")).send({ name: "Opens", category: "engagement", event: "email.opened", points: 3, maxPoints: 9, decayDays: 30 }).expect(201)).body.data;
    expect([a.position, b.position]).toEqual([0, 1]);

    expect((await owner.patch(api(`/scoring/rules/${a.id}`)).send({ points: 7 }).expect(200)).body.data).toMatchObject({ points: 7, field: "phone" });
    await owner.patch(api(`/scoring/rules/${a.id}`)).send({ op: "gt", value: "lots" }).expect(400);
    await member.patch(api(`/scoring/rules/${a.id}`)).send({ points: 1 }).expect(403);

    const order = (await owner.post(api("/scoring/rules/reorder")).send({ ids: [b.id, a.id] }).expect(200)).body.data;
    expect(order.map((r: { id: string }) => r.id)).toEqual([b.id, a.id]);

    await member.delete(api(`/scoring/rules/${a.id}`)).expect(403);
    await owner.delete(api(`/scoring/rules/${a.id}`)).expect(200);
    await owner.delete(api(`/scoring/rules/${a.id}`)).expect(404);
    await owner.delete(api(`/scoring/rules/${b.id}`)).expect(200);
  });

  it("adds the recommended rules, without duplicates, or replaces with them", async () => {
    await owner.post(api("/scoring/rules")).send({ name: "Custom: big company", category: "fit", field: "custom.employees", op: "gt", value: "500", points: 10 }).expect(201);
    const added = (await owner.post(api("/scoring/recommended")).send({}).expect(200)).body.data;
    expect(added.length).toBe(20);
    expect(added[0].name).toBe("Custom: big company");
    expect((await owner.post(api("/scoring/recommended")).send({}).expect(200)).body.data.length).toBe(20);
    const replaced = (await owner.post(api("/scoring/recommended")).send({ replace: true }).expect(200)).body.data;
    expect(replaced.length).toBe(19);
    expect(replaced.find((r: { name: string }) => r.name === "Call: do not call")).toMatchObject({ points: -50, event: "call.outcome:do_not_call" });
    await member.post(api("/scoring/recommended")).send({}).expect(403);
  });

  it("leaves hand-set scores alone while scoring is off", async () => {
    await scoring.recomputeContacts(w, [ids.plain!, ids.ceo!]);
    await scoring.recomputeWorkspace(w, "all");
    expect((await contact(ids.plain!)).score).toBe(55);
    expect((await contact(ids.ceo!)).scoreUpdatedAt).toBeNull();
    await owner.post(api("/scoring/recalculate")).expect(400);
    expect((await scoring.sweep()).workspaces).toBe(0);
  });

  it("scores everyone when turned on: fit rules and the breakdown", async () => {
    const before = (await contact(ids.ceo!)).updatedAt;
    await owner.put(api("/scoring/settings")).send({ enabled: true, hot: 60, warm: 30 }).expect(200);
    const waiting = await t.app.get(Queues).queue("scoring").getJobs(["delayed", "waiting"]);
    expect(waiting.some((j) => j.name === "workspace" && j.data.workspaceId === w)).toBe(true);

    await scoring.recomputeWorkspace(w, "all");
    const ceo = await contact(ids.ceo!);
    // Decision-maker title 15 + phone 5 + company 5 + referral 10.
    expect(ceo).toMatchObject({ score: 35, scoreFit: 35, scoreEngagement: 0 });
    expect(ceo.updatedAt.getTime()).toBe(before.getTime());
    expect((ceo.scoreBreakdown as { name: string }[]).map((b) => b.name)).toEqual(["Decision-maker title", "Has a phone number", "Has a company", "Referred to us"]);
    // The computed score now owns the field: Pat's hand-set 55 is replaced.
    expect((await contact(ids.plain!)).score).toBe(0);

    const panel = (await viewer.get(api(`/scoring/contacts/${ids.ceo}`)).expect(200)).body.data;
    expect(panel).toMatchObject({ enabled: true, score: 35, band: "warm", fit: 35, engagement: 0, hot: 60 });
    expect(panel.breakdown).toHaveLength(4);
    const detail = (await owner.get(api(`/contacts/${ids.ceo}`)).expect(200)).body.data;
    expect(detail).toMatchObject({ score: 35, scoreFit: 35, scoreEngagement: 0 });
    expect(detail.scoreUpdatedAt).toBeTruthy();
  });

  it("raises scores with engagement, found by the sweep, and tells the owner the first time a lead turns hot", async () => {
    const convo = await t.prisma.db.conversation.create({ data: { workspaceId: w, channel: "email", contactId: ids.ceo!, externalKey: `test:${ids.ceo}` } });
    const now = new Date();
    for (let i = 0; i < 4; i++) {
      await t.prisma.db.message.create({ data: { workspaceId: w, conversationId: convo.id, channel: "email", direction: "outbound", status: "sent", subject: `Hi ${i}`, sentAt: now, openedAt: now } });
    }
    await t.prisma.db.meeting.create({ data: { workspaceId: w, contactId: ids.ceo!, title: "Intro", startsAt: new Date(Date.now() + DAY) } });
    await t.prisma.db.call.create({ data: { workspaceId: w, contactId: ids.ceo!, status: "completed", outcome: "connected" } });

    const swept = await scoring.sweep();
    expect(swept.workspaces).toBe(1);
    const job = await t.app.get(Queues).queue("scoring").getJob(`score-${ids.ceo}`);
    expect(job?.data).toEqual({ workspaceId: w, contactId: ids.ceo });

    await rescore(ids.ceo!);
    // 35 fit + opens 9 (capped) + meeting 25 + connected call 10.
    expect(await contact(ids.ceo!)).toMatchObject({ score: 79, scoreFit: 35, scoreEngagement: 44 });
    const hot = await t.prisma.db.activity.findMany({ where: { workspaceId: w, contactId: ids.ceo!, type: "contact.score_hot" } });
    expect(hot).toHaveLength(1);
    expect(hot[0]).toMatchObject({ actorType: "system", actorName: "Lead scoring", summary: "Became a hot lead (score 79)" });
    const notes = await t.prisma.db.notification.findMany({ where: { workspaceId: w, userId: member.userId, type: "contact.score_hot" } });
    expect(notes.map((n) => n.title)).toEqual(["Hot lead: Cleo Chief"]);
  });

  it("lets engagement age out of its window (nightly decay) and subtracts for unsubscribes", async () => {
    const old = new Date(Date.now() - 100 * DAY);
    await t.prisma.db.meeting.updateMany({ where: { workspaceId: w, contactId: ids.ceo! }, data: { createdAt: old } });
    await t.prisma.db.message.updateMany({ where: { workspaceId: w }, data: { openedAt: new Date(Date.now() - 40 * DAY) } });
    await scoring.recomputeWorkspace(w, "decay");
    expect(await contact(ids.ceo!)).toMatchObject({ score: 45, scoreEngagement: 10 });

    await t.prisma.db.contact.updateMany({ where: { workspaceId: w, id: ids.ceo! }, data: { unsubscribedAt: new Date() } });
    await rescore(ids.ceo!);
    expect(await contact(ids.ceo!)).toMatchObject({ score: 15, scoreEngagement: -20 });
    const breakdown = (await contact(ids.ceo!)).scoreBreakdown as { name: string; points: number }[];
    expect(breakdown).toContainEqual(expect.objectContaining({ name: "Unsubscribed", points: -30 }));

    // Hot again later: no second "became hot" entry or notification.
    await t.prisma.db.contact.updateMany({ where: { workspaceId: w, id: ids.ceo! }, data: { unsubscribedAt: null } });
    await t.prisma.db.meeting.updateMany({ where: { workspaceId: w, contactId: ids.ceo! }, data: { createdAt: new Date() } });
    await rescore(ids.ceo!);
    expect((await contact(ids.ceo!)).score).toBe(70);
    expect(await t.prisma.db.activity.count({ where: { workspaceId: w, contactId: ids.ceo!, type: "contact.score_hot" } })).toBe(1);
    expect(await t.prisma.db.notification.count({ where: { workspaceId: w, type: "contact.score_hot" } })).toBe(1);
  });

  it("rate-limits Recalculate all", async () => {
    await member.post(api("/scoring/recalculate")).expect(403);
    expect((await owner.post(api("/scoring/recalculate")).expect(200)).body.data).toMatchObject({ queued: true, contacts: 2 });
    await owner.post(api("/scoring/recalculate")).expect(429);
  });

  it("stops writing scores when turned off again", async () => {
    await owner.put(api("/scoring/settings")).send({ enabled: false, hot: 60, warm: 30 }).expect(200);
    await owner.patch(api(`/contacts/${ids.plain}`)).send({ score: 88 }).expect(200);
    await rescore(ids.plain!);
    await scoring.recomputeWorkspace(w, "all");
    expect((await contact(ids.plain!)).score).toBe(88);
    expect((await viewer.get(api(`/scoring/contacts/${ids.plain}`)).expect(200)).body.data).toMatchObject({ enabled: false, score: 88 });
  });

  it("keeps workspaces apart", async () => {
    const rule = (await owner.get(api("/scoring")).expect(200)).body.data.rules[0];
    await other.get(api("/scoring")).expect(404);
    await other.patch(api(`/scoring/rules/${rule.id}`, w2)).send({ points: 99 }).expect(404);
    await other.delete(api(`/scoring/rules/${rule.id}`, w2)).expect(404);
    await other.post(api("/scoring/rules/reorder", w2)).send({ ids: [rule.id] }).expect(400);
    await other.get(api(`/scoring/contacts/${ids.ceo}`, w2)).expect(404);
    expect((await other.get(api("/scoring", w2)).expect(200)).body.data.rules).toEqual([]);

    // Another workspace's job naming this contact touches nothing.
    await other.put(api("/scoring/settings", w2)).send({ enabled: true }).expect(200);
    await rescore(ids.ceo!, w2);
    expect((await contact(ids.ceo!)).score).toBe(70);
    await scoring.recomputeWorkspace(w2, "all");
    expect(await t.prisma.db.contact.findFirstOrThrow({ where: { workspaceId: w2, id: ids.foreign! } })).toMatchObject({ score: 0, scoreBreakdown: [] });
  });
});
