import { addMember, bootApp, createWorkspace, setPlan, signUp, type Agent, type TestApp } from "./helpers.js";
import { DispatcherService } from "../src/automation/dispatcher.service.js";
import { LeadRoutingService } from "../src/automation/lead-routing.service.js";
import { EventsService } from "../src/core/events.service.js";

/*
 * The inbox for a team: a reply lands with the contact's owner when nobody
 * has the conversation; "unread" is each person's own (a manager glancing
 * at it no longer hides it from the rep) while "unanswered" stays shared
 * until someone replies; the home "waiting on your reply" list is yours, not
 * the team's; answering takes an unassigned conversation and stops the
 * contact's automated outreach. Sending goes through the dev GreenMail
 * server (127.0.0.1:3925).
 */
describe("Inbox for a team", () => {
  let t: TestApp;
  let owner: Agent;
  let ana: Agent;
  let ben: Agent;
  let w: string;
  let anaId: string;
  let benId: string;
  let mailboxId: string;
  let contactId: string;
  let convo: string;
  const api = (p: string) => `/v1/workspaces/${w}${p}`;
  const me = async (a: Agent) => (await a.get("/v1/auth/me").expect(200)).body.data.user.id as string;
  const unreadIn = async (a: Agent) => ((await a.get(api("/inbox/conversations?unread=true&status=open")).expect(200)).body.data.items as { id: string }[]).map((c) => c.id);
  const conversation = (data: Record<string, unknown>) =>
    t.prisma.db.conversation.create({ data: { workspaceId: w, channel: "email", externalKey: `test:${Math.random().toString(36).slice(2)}`, status: "open", unread: true, lastInboundAt: new Date(), lastMessageAt: new Date(), mailboxId, ...data } as never });

  beforeAll(async () => {
    t = await bootApp();
    owner = await signUp(t, "inbox-team-owner@acme.test", "Ingrid Owner");
    w = await createWorkspace(owner, "Inbox Team Co");
    await setPlan(t, w, "agency");
    ana = await addMember(t, owner, w, "ana@inboxteam.test", "member");
    ben = await addMember(t, owner, w, "ben@inboxteam.test", "member");
    anaId = await me(ana);
    benId = await me(ben);
    mailboxId = (
      await owner
        .post(api("/mailboxes/smtp"))
        .send({ email: "team@growthdesk.test", displayName: "Team", smtpHost: "127.0.0.1", smtpPort: 3925, smtpSecurity: "none", smtpUser: "team@growthdesk.test", password: "team@growthdesk.test", imapEnabled: false, minDelaySeconds: 0 })
        .expect(201)
    ).body.data.id;
    contactId = (await owner.post(api("/contacts")).send({ fullName: "Rosa Replier", email: "rosa@client.example", ownerId: anaId }).expect(201)).body.data.id;
  });
  afterAll(async () => t.close());

  it("gives a reply nobody has to the contact's owner", async () => {
    convo = (await conversation({ contactId, peer: "rosa@client.example", subject: "Pricing?", displayName: "Rosa Replier" })).id;
    await t.app.get(EventsService).emit({ workspaceId: w, type: "reply.received", subjectType: "conversation", subjectId: convo, payload: { conversationId: convo, contactId } });
    const res = await t.app.get(DispatcherService).dispatchBatch();
    for (const r of res.inboxRoutes) await t.app.get(LeadRoutingService).assignConversations(r.workspaceId, r.conversationIds);
    expect((await t.prisma.db.conversation.findFirstOrThrow({ where: { workspaceId: w, id: convo } })).assigneeId).toBe(anaId);
    const log = await t.prisma.db.activity.findFirstOrThrow({ where: { workspaceId: w, contactId, type: "conversation.assigned" } });
    expect(log).toMatchObject({ actorType: "system", actorName: "Inbox routing" });
  });

  it("keeps unread per person: the owner opening it does not hide it from the rep", async () => {
    expect(await unreadIn(ana)).toContain(convo);
    expect(await unreadIn(owner)).toContain(convo);
    await owner.post(api(`/inbox/conversations/${convo}/read`)).expect((r) => expect([200, 201]).toContain(r.status));
    expect(await unreadIn(owner)).not.toContain(convo);
    expect(await unreadIn(ana)).toContain(convo);
    expect((await ana.get(api("/inbox/unread-count")).expect(200)).body.data.total).toBeGreaterThan(0);
    expect((await owner.get(api(`/inbox/conversations/${convo}`)).expect(200)).body.data.unread).toBe(false);
    expect((await ana.get(api(`/inbox/conversations/${convo}`)).expect(200)).body.data.unread).toBe(true);
    // Marking it unread again is the owner's own business too.
    await owner.patch(api(`/inbox/conversations/${convo}`)).send({ unread: true }).expect(200);
    expect(await unreadIn(owner)).toContain(convo);
  });

  it("shows each person only the replies that are theirs to answer at home", async () => {
    const waiting = async (a: Agent) => (await a.get(api("/tasks/summary")).expect(200)).body.data.unansweredReplies as { id: string }[];
    const anaList = await waiting(ana);
    const benList = await waiting(ben);
    expect(anaList.map((c) => c.id)).toContain(convo);
    expect(benList.map((c) => c.id)).not.toContain(convo);
  });

  it("answering an unassigned conversation takes it and stops the contact's automated outreach", async () => {
    const other = (await owner.post(api("/contacts")).send({ fullName: "Omar Open", email: "omar@client.example" }).expect(201)).body.data.id;
    const loose = (await conversation({ contactId: other, peer: "omar@client.example", subject: "Hello", displayName: "Omar Open" })).id;
    const campaign = (await owner.post(api("/campaigns")).send({ name: "Cold outreach" }).expect(201)).body.data.id;
    await t.prisma.db.enrollment.create({ data: { workspaceId: w, campaignId: campaign, contactId: other, status: "active", nextRunAt: new Date(Date.now() + 3_600_000) } });

    await ben.post(api(`/inbox/conversations/${loose}/reply`)).send({ body: "Thanks Omar — calling you now.", mailboxId }).expect(201);
    const after = await t.prisma.db.conversation.findFirstOrThrow({ where: { workspaceId: w, id: loose } });
    expect(after).toMatchObject({ assigneeId: benId, unread: false });
    expect(await t.prisma.db.enrollment.findFirstOrThrow({ where: { workspaceId: w, contactId: other } })).toMatchObject({ status: "stopped", stopReason: "A teammate replied by hand" });
    expect((await t.prisma.db.activity.findMany({ where: { workspaceId: w, contactId: other, type: "campaign.stopped" } })).length).toBe(1);
  });
});
