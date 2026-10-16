import { addMember, bootApp, createWorkspace, setPlan, signUp, type Agent, type TestApp } from "./helpers.js";

/*
 * Nothing dropped when work changes hands: a manual hand-off to sales tells
 * the new owner and gives them a follow-up task; removing a teammate shows
 * what they were responsible for and hands all of it to someone else —
 * records, tasks, conversations, companies, meetings, campaigns and their
 * place in workflows — logged on each record and announced, with their
 * mailboxes paused.
 */
describe("Team hand-offs", () => {
  let t: TestApp;
  let owner: Agent;
  let w: string;
  let ownerId: string;
  const api = (p: string) => `/v1/workspaces/${w}${p}`;
  const me = async (a: Agent) => (await a.get("/v1/auth/me").expect(200)).body.data.user.id as string;
  const contact = async (body: Record<string, unknown>) => (await owner.post(api("/contacts")).send(body).expect(201)).body.data.id as string;
  const notificationsOf = (userId: string) => t.prisma.db.notification.findMany({ where: { workspaceId: w, userId }, orderBy: { createdAt: "asc" } });

  beforeAll(async () => {
    t = await bootApp();
    owner = await signUp(t, "handover-owner@acme.test", "Hana Owner");
    w = await createWorkspace(owner, "Handover Co");
    await setPlan(t, w, "agency");
    ownerId = await me(owner);
  });
  afterAll(async () => t.close());

  it("tells the new owner about a hand-off to sales and gives them a follow-up task", async () => {
    const closer = await addMember(t, owner, w, "closer@acme.test", "member");
    const closerId = await me(closer);
    const a = await contact({ fullName: "Sam Sdr", email: "sam@lead.example", lifecycleStage: "lead" });
    const b = await contact({ fullName: "Bea Sdr", email: "bea@lead.example", lifecycleStage: "lead" });
    await owner.post(api("/contacts/bulk")).send({ action: "transfer_to_sales", ids: [a, b], ownerId: closerId }).expect(200);

    const tasks = await t.prisma.db.task.findMany({ where: { workspaceId: w, contactId: { in: [a, b] } } });
    expect(tasks).toHaveLength(2);
    expect(tasks.every((x) => x.assigneeId === closerId && x.title === "Follow up: handed to sales" && x.priority === "high" && x.source === "handoff")).toBe(true);
    expect((await notificationsOf(closerId)).map((n) => n.title)).toContain("2 leads were handed to you for sales");

    // Handing them over again does not pile up a second task.
    await owner.post(api("/contacts/bulk")).send({ action: "transfer_to_sales", ids: [a], ownerId: closerId }).expect(200);
    expect(await t.prisma.db.task.count({ where: { workspaceId: w, contactId: a } })).toBe(1);
  });

  it("previews what a leaving teammate owns, then hands all of it to someone else", async () => {
    const leaver = await addMember(t, owner, w, "leaver@acme.test", "member");
    const leaverId = await me(leaver);
    const heir = await addMember(t, owner, w, "heir@acme.test", "member");
    const heirId = await me(heir);

    const c1 = await contact({ fullName: "Leo Lead", email: "leo@x.example", ownerId: leaverId });
    const c2 = await contact({ fullName: "Lia Lead", email: "lia@x.example", ownerId: leaverId });
    const pipeline = (await owner.get(api("/pipelines")).expect(200)).body.data[0];
    const deal = (await owner.post(api("/deals")).send({ name: "Leo deal", contactId: c1, ownerId: leaverId, pipelineId: pipeline.id, value: 1000 }).expect(201)).body.data.id;
    await owner.post(api("/tasks")).send({ title: "Call Leo", contactId: c1, assigneeId: leaverId }).expect(201);
    const company = (await owner.post(api("/companies")).send({ name: "Leo Co", ownerId: leaverId }).expect(201)).body.data.id;
    const wf = (
      await owner
        .post(api("/workflows"))
        .send({ name: "Leads to the leaver", trigger: "lead.imported", conditions: [], actions: [{ type: "assign_contact", config: { strategy: "user", userId: leaverId } }] })
        .expect(201)
    ).body.data.id;
    const mailbox = await t.prisma.db.mailbox.create({
      data: { workspaceId: w, email: "leaver@acme.test", provider: "smtp", status: "connected", smtpHost: "127.0.0.1", smtpPort: 3925, smtpSecurity: "none", smtpUser: "leaver@acme.test", createdById: leaverId },
    });

    const membership = (await owner.get(api("/members")).expect(200)).body.data.members.find((m: { userId: string }) => m.userId === leaverId);
    const preview = (await owner.get(api(`/members/${membership.id}/handover`)).expect(200)).body.data;
    expect(preview).toMatchObject({ contacts: { total: 2 }, openDeals: 1, openTasks: 1, companies: 1, workflows: [{ id: wf, name: "Leads to the leaver" }], mailboxes: [{ email: "leaver@acme.test" }] });

    // A member cannot see or act on someone else's handover.
    await heir.get(api(`/members/${membership.id}/handover`)).expect(403);

    const res = await owner.delete(api(`/members/${membership.id}?handoverTo=${heirId}&pauseMailboxes=true`)).expect(200);
    expect(res.body.data.handover).toMatchObject({ contacts: 2, deals: 1, tasks: 1, companies: 1, workflows: 1, mailboxesPaused: 1 });

    expect((await t.prisma.db.contact.findMany({ where: { workspaceId: w, id: { in: [c1, c2] } } })).every((c) => c.ownerId === heirId)).toBe(true);
    expect((await t.prisma.db.deal.findFirstOrThrow({ where: { workspaceId: w, id: deal } })).ownerId).toBe(heirId);
    expect((await t.prisma.db.company.findFirstOrThrow({ where: { workspaceId: w, id: company } })).ownerId).toBe(heirId);
    expect(await t.prisma.db.task.count({ where: { workspaceId: w, assigneeId: heirId, title: "Call Leo" } })).toBe(1);
    const workflow = await t.prisma.db.workflow.findFirstOrThrow({ where: { workspaceId: w, id: wf } });
    expect(JSON.stringify(workflow.actions)).toContain(heirId);
    expect(JSON.stringify(workflow.actions)).not.toContain(leaverId);
    expect((await t.prisma.db.mailbox.findFirstOrThrow({ where: { workspaceId: w, id: mailbox.id } })).status).toBe("disconnected");

    const timeline = await t.prisma.db.activity.findMany({ where: { workspaceId: w, contactId: c2, type: "contact.assigned" } });
    expect(timeline.at(-1)).toMatchObject({ actorType: "user", actorId: ownerId, summary: expect.stringContaining("Handed over from") });
    expect((await notificationsOf(heirId)).at(-1)!.title).toMatch(/work was handed to you/);
    const audit = await t.prisma.db.auditEvent.findFirstOrThrow({ where: { workspaceId: w, action: "member.removed" }, orderBy: { createdAt: "desc" } });
    expect(audit.metadata).toMatchObject({ userId: leaverId, handoverTo: heirId, contacts: 2 });
  });

  it("refuses a hand-off to a viewer or to someone outside the workspace", async () => {
    const leaver = await addMember(t, owner, w, "leaver2@acme.test", "member");
    const viewer = await addMember(t, owner, w, "viewer@acme.test", "viewer");
    const members = (await owner.get(api("/members")).expect(200)).body.data.members;
    const m = members.find((x: { email: string }) => x.email === "leaver2@acme.test");
    await owner.delete(api(`/members/${m.id}?handoverTo=${await me(viewer)}`)).expect(400);
    await owner.delete(api(`/members/${m.id}?handoverTo=00000000-0000-4000-8000-000000000000`)).expect(400);
    // Without a hand-off, removal still works and releases their records.
    await owner.delete(api(`/members/${m.id}`)).expect(200);
    void leaver;
  });
});
