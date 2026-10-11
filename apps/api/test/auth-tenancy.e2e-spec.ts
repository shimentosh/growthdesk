import { addMember, bootApp, createWorkspace, setPlan, signUp, type TestApp } from "./helpers.js";
import request from "supertest";
import type { App } from "supertest/types.js";

describe("Authentication", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await bootApp();
  });
  afterAll(async () => t.close());

  it("registers, requires verification before creating a workspace, verifies, and signs in", async () => {
    const agent = request.agent(t.app.getHttpServer() as App);
    await agent.post("/v1/auth/register").send({ name: "Ada", email: "ada@example.com", password: "Correct-horse-9" }).expect(201);
    const me = await agent.get("/v1/auth/me").expect(200);
    expect(me.body.data.user.emailVerified).toBe(false);

    const blocked = await agent.post("/v1/workspaces").send({ name: "Too soon" }).expect(403);
    expect(blocked.body.error.message).toMatch(/Confirm your email/);

    const token = t.mail.outbox.find((m) => m.to === "ada@example.com" && m.template === "verify_email")!.text.match(/token=([^\s]+)/)![1]!;
    await agent.post("/v1/auth/verify-email").send({ token: decodeURIComponent(token) }).expect(200);
    await agent.post("/v1/auth/verify-email").send({ token: decodeURIComponent(token) }).expect(400);

    await agent.post("/v1/auth/logout").expect(200);
    await agent.get("/v1/auth/me").expect(401);
    await agent.post("/v1/auth/login").send({ email: "ada@example.com", password: "Correct-horse-9" }).expect(200);
    const after = await agent.get("/v1/auth/me").expect(200);
    expect(after.body.data.user.emailVerified).toBe(true);
  });

  it("rejects duplicate registration, weak passwords and wrong passwords", async () => {
    await t.http().post("/v1/auth/register").send({ name: "A", email: "ada@example.com", password: "Correct-horse-9" }).expect(409);
    const weak = await t.http().post("/v1/auth/register").send({ name: "B", email: "b@example.com", password: "short" }).expect(400);
    expect(weak.body.error.fields.password).toBeDefined();
    const wrong = await t.http().post("/v1/auth/login").send({ email: "ada@example.com", password: "nope-nope-nope" }).expect(401);
    expect(wrong.body.error.message).toMatch(/do not match/);
    // An unknown email gets the same answer as a wrong password.
    const unknown = await t.http().post("/v1/auth/login").send({ email: "ghost@example.com", password: "nope-nope-nope" }).expect(401);
    expect(unknown.body.error.message).toBe(wrong.body.error.message);
  });

  it("locks out an email+address after repeated failures", async () => {
    await signUp(t, "locked@example.com");
    for (let i = 0; i < 8; i++) {
      await t.http().post("/v1/auth/login").send({ email: "locked@example.com", password: "wrong-password-1" }).expect(401);
    }
    await t.http().post("/v1/auth/login").send({ email: "locked@example.com", password: "Correct-horse-9" }).expect(429);
  });

  it("locks out an account whose failures are spread over many addresses", async () => {
    const agent = await signUp(t, "spread@example.com");
    const userId = agent.userId;
    // 4 addresses × 7 failures stays under the per-address limit (8) but reaches the account limit (30) with 2 more.
    await t.prisma.db.signInFailure.createMany({
      data: [1, 2, 3, 4].map((n) => ({ email: "spread@example.com", ip: `203.0.113.${n}`, count: 7, userId })),
    });
    await t.http().post("/v1/auth/login").send({ email: "spread@example.com", password: "wrong-password-1" }).expect(401);
    await t.http().post("/v1/auth/login").send({ email: "spread@example.com", password: "wrong-password-1" }).expect(401);
    const res = await t.http().post("/v1/auth/login").send({ email: "spread@example.com", password: "Correct-horse-9" }).expect(429);
    expect(res.body.error.message).toMatch(/for this account/);
  });

  it("resets a password with an emailed token and revokes old sessions", async () => {
    const agent = await signUp(t, "reset@example.com");
    await t.http().post("/v1/auth/forgot-password").send({ email: "reset@example.com" }).expect(202);
    await t.http().post("/v1/auth/forgot-password").send({ email: "nobody@example.com" }).expect(202);
    const token = t.mail.outbox.filter((m) => m.template === "reset_password" && m.to === "reset@example.com").at(-1)!.text.match(/token=([^\s]+)/)![1]!;
    await t.http().post("/v1/auth/reset-password").send({ token: decodeURIComponent(token), password: "Brand-new-pass-7" }).expect(200);
    await agent.get("/v1/auth/me").expect(401);
    await t.http().post("/v1/auth/login").send({ email: "reset@example.com", password: "Brand-new-pass-7" }).expect(200);
    await t.http().post("/v1/auth/reset-password").send({ token: decodeURIComponent(token), password: "Another-pass-77" }).expect(400);
  });

  it("refuses unauthenticated access and cross-site writes", async () => {
    await t.http().get("/v1/auth/me").expect(401);
    const agent = await signUp(t, "csrf@example.com");
    await agent.post("/v1/workspaces").set("Origin", "https://evil.example").send({ name: "X" }).expect(403);
  });
});

describe("Workspaces, roles and tenant isolation", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await bootApp();
  });
  afterAll(async () => t.close());

  it("creates a workspace with a trial subscription and the default pipeline", async () => {
    const owner = await signUp(t, "owner@acme.test");
    const id = await createWorkspace(owner);
    const detail = await owner.get(`/v1/workspaces/${id}`).expect(200);
    expect(detail.body.data.role).toBe("owner");
    expect(detail.body.data.plan.key).toBe("starter");
    expect(detail.body.data.plan.state).toBe("trialing");
    const stages = await t.prisma.db.pipelineStage.findMany({ where: { workspaceId: id }, orderBy: { position: "asc" } });
    expect(stages.map((s) => s.name)).toEqual([
      "New Lead",
      "Ready to Contact",
      "Contacted",
      "Replied",
      "Qualified",
      "Meeting Booked",
      "Proposal Sent",
      "Negotiation",
      "Won",
      "Lost",
    ]);
  });

  it("answers 404 for a workspace the caller does not belong to", async () => {
    const a = await signUp(t, "a@one.test");
    const b = await signUp(t, "b@two.test");
    const wa = await createWorkspace(a, "One");
    const wb = await createWorkspace(b, "Two");
    await a.get(`/v1/workspaces/${wb}`).expect(404);
    await b.get(`/v1/workspaces/${wa}`).expect(404);
    await b.get(`/v1/workspaces/${wa}/members`).expect(404);
    await b.patch(`/v1/workspaces/${wa}`).send({ name: "Hijacked" }).expect(404);
    const still = await a.get(`/v1/workspaces/${wa}`).expect(200);
    expect(still.body.data.name).toBe("One");
  });

  it("enforces role permissions and the role ladder", async () => {
    const owner = await signUp(t, "boss@ladder.test");
    const w = await createWorkspace(owner, "Ladder");
    await setPlan(t, w, "growth");
    const admin = await addMember(t, owner, w, "admin@ladder.test", "admin");
    const viewer = await addMember(t, owner, w, "viewer@ladder.test", "viewer");

    // A viewer can read but not change settings or invite.
    await viewer.get(`/v1/workspaces/${w}/members`).expect(200);
    await viewer.patch(`/v1/workspaces/${w}`).send({ name: "x" }).expect(403);
    await viewer.post(`/v1/workspaces/${w}/invitations`).send({ email: "z@ladder.test", role: "member" }).expect(403);

    // An admin can invite members but cannot mint another admin or touch billing.manage.
    await admin.post(`/v1/workspaces/${w}/invitations`).send({ email: "m@ladder.test", role: "member" }).expect(201);
    await admin.post(`/v1/workspaces/${w}/invitations`).send({ email: "a2@ladder.test", role: "admin" }).expect(403);
    await admin.post(`/v1/workspaces/${w}/billing/cancel`).expect(403);

    const members = (await owner.get(`/v1/workspaces/${w}/members`).expect(200)).body.data.members as { id: string; role: string }[];
    const ownerRow = members.find((m) => m.role === "owner")!;
    await admin.delete(`/v1/workspaces/${w}/members/${ownerRow.id}`).expect(403);
    await admin.patch(`/v1/workspaces/${w}/members/${ownerRow.id}`).send({ role: "viewer" }).expect(403);
  });

  it("enforces the plan's seat limit on invitations", async () => {
    const owner = await signUp(t, "seats@limit.test");
    const w = await createWorkspace(owner, "Seats");
    await setPlan(t, w, "starter");
    await owner.post(`/v1/workspaces/${w}/invitations`).send({ email: "one@limit.test", role: "member" }).expect(201);
    const refused = await owner.post(`/v1/workspaces/${w}/invitations`).send({ email: "two@limit.test", role: "member" }).expect(402);
    expect(refused.body.error.code).toBe("plan_limit");
    expect(refused.body.error.details).toMatchObject({ limit: "seats", used: 2, allowed: 2 });
  });

  it("an invitation can only be accepted by the invited address", async () => {
    const owner = await signUp(t, "inv-owner@x.test");
    const w = await createWorkspace(owner, "Invites");
    await owner.post(`/v1/workspaces/${w}/invitations`).send({ email: "right@x.test", role: "member" }).expect(201);
    const token = t.mail.outbox.filter((m) => m.template === "invitation" && m.to === "right@x.test").at(-1)!.text.match(/invite\/([^\s]+)/)![1]!;
    const stranger = await signUp(t, "wrong@x.test");
    await stranger.post(`/v1/invitations/${token}/accept`).expect(403);
    const info = await t.http().get(`/v1/invitations/${token}`).expect(200);
    expect(info.body.data.workspaceName).toBe("Invites");
  });
});
