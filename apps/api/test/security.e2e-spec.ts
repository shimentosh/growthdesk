import request from "supertest";
import type { App } from "supertest/types.js";
import { addMember, bootApp, createWorkspace, setPlan, signUp, type Agent, type TestApp } from "./helpers.js";
import { WEBHOOK_PAUSED_OWNER_LEFT } from "../src/core/credential-release.service.js";

/* docs/GAP_PLAN.md §2: security fixes 2.2–2.8. */
describe("Security", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await bootApp();
  });
  afterAll(async () => t.close());

  const bearer = (secret: string) => ({ Authorization: `Bearer ${secret}` });
  const tokenIn = (to: string, template: string) =>
    decodeURIComponent(t.mail.outbox.filter((m) => m.to === to && m.template === template).at(-1)!.text.match(/token=([^\s]+)/)![1]!);

  describe("2.2 credentials of someone who loses access", () => {
    let owner: Agent;
    let w: string;
    const api = (p: string, ws = w) => `/v1/workspaces/${ws}${p}`;

    beforeAll(async () => {
      owner = await signUp(t, "owner@creds.test");
      w = await createWorkspace(owner, "Creds");
      await setPlan(t, w, "agency");
    });

    async function credentialsOf(agent: Agent, ws = w) {
      const key = (await agent.post(api("/api-keys", ws)).send({ name: "Mine", scopes: ["contacts:read"] }).expect(201)).body.data;
      const hook = (await agent.post(api("/webhooks", ws)).send({ url: "https://93.184.216.34/hook", events: ["contact.created"] }).expect(201)).body.data;
      await t.http().get(api("/contacts", ws)).set(bearer(key.secret)).expect(200);
      return { key, hook };
    }

    it("removing a member revokes their API keys and pauses their webhooks, and audits both", async () => {
      const admin = await addMember(t, owner, w, "admin@creds.test", "admin");
      const theirs = await credentialsOf(admin);
      const ownersKey = (await owner.post(api("/api-keys")).send({ name: "Owner's", scopes: ["contacts:read"] }).expect(201)).body.data;

      const members = (await owner.get(api("/members")).expect(200)).body.data.members as { id: string; userId: string }[];
      await owner.delete(api(`/members/${members.find((m) => m.userId === admin.userId)!.id}`)).expect(200);

      await t.http().get(api("/contacts")).set(bearer(theirs.key.secret)).expect(401);
      // Someone else's key is untouched.
      await t.http().get(api("/contacts")).set(bearer(ownersKey.secret)).expect(200);
      const hook = await t.prisma.db.webhookEndpoint.findFirstOrThrow({ where: { workspaceId: w, id: theirs.hook.id } });
      expect(hook).toMatchObject({ enabled: false, lastError: WEBHOOK_PAUSED_OWNER_LEFT });

      const audit = await t.prisma.db.auditEvent.findMany({ where: { workspaceId: w, targetId: { in: [theirs.key.id, theirs.hook.id] } } });
      expect(audit.map((a) => a.action).sort()).toEqual(["api_key.created", "api_key.revoked", "webhook.created", "webhook.paused"]);
      expect(audit.find((a) => a.action === "webhook.paused")!.metadata).toMatchObject({ reason: "member_removed", creatorId: admin.userId });

      // Whoever turns it back on answers for it from then on.
      await owner.patch(api(`/webhooks/${theirs.hook.id}`)).send({ enabled: true }).expect(200);
      const reviewed = await t.prisma.db.webhookEndpoint.findFirstOrThrow({ where: { workspaceId: w, id: theirs.hook.id } });
      expect(reviewed).toMatchObject({ enabled: true, lastError: "", createdById: owner.userId });
    });

    it("a member who leaves loses their keys too", async () => {
      const admin = await addMember(t, owner, w, "leaver@creds.test", "admin");
      const theirs = await credentialsOf(admin);
      const members = (await owner.get(api("/members")).expect(200)).body.data.members as { id: string; userId: string }[];
      await admin.delete(api(`/members/${members.find((m) => m.userId === admin.userId)!.id}`)).expect(200);
      await t.http().get(api("/contacts")).set(bearer(theirs.key.secret)).expect(401);
    });

    it("disabling an account revokes its keys and pauses its webhooks in every workspace", async () => {
      const person = await addMember(t, owner, w, "disabled@creds.test", "admin");
      const own = await createWorkspace(person, "Theirs");
      await setPlan(t, own, "agency");
      const here = await credentialsOf(person);
      const there = await credentialsOf(person, own);

      const staff = await signUp(t, "staff@creds.test");
      await t.prisma.db.user.update({ where: { id: staff.userId }, data: { platformRole: "admin" } });
      await staff.post(`/v1/admin/users/${person.userId}/disable`).send({ reason: "Left the company" }).expect(200);

      await t.http().get(api("/contacts")).set(bearer(here.key.secret)).expect(401);
      await t.http().get(api("/contacts", own)).set(bearer(there.key.secret)).expect(401);
      for (const [ws, id] of [
        [w, here.hook.id],
        [own, there.hook.id],
      ] as const) {
        expect(await t.prisma.db.webhookEndpoint.findFirstOrThrow({ where: { workspaceId: ws, id } })).toMatchObject({ enabled: false });
      }
      const filed = await t.prisma.db.auditEvent.findFirstOrThrow({ where: { workspaceId: own, action: "api_key.revoked", targetId: there.key.id } });
      expect(filed).toMatchObject({ actorType: "platform_admin", actorUserId: staff.userId });
      expect(filed.metadata).toMatchObject({ reason: "user_disabled" });
    });
  });

  describe("2.3 cross-site sign-in and sign-up", () => {
    beforeAll(async () => {
      await signUp(t, "csrf-login@example.com");
    });

    it("refuses a public auth write from another site", async () => {
      const login = await t
        .http()
        .post("/v1/auth/login")
        .set("Origin", "https://evil.example")
        .send({ email: "csrf-login@example.com", password: "Correct-horse-9" })
        .expect(403);
      expect(login.headers["set-cookie"]).toBeUndefined();
      await t.http().post("/v1/auth/register").set("Origin", "https://evil.example").send({ name: "X", email: "x@csrf.test", password: "Correct-horse-9" }).expect(403);
      await t.http().post("/v1/auth/forgot-password").set("Origin", "null").send({ email: "csrf-login@example.com" }).expect(403);
      expect(await t.prisma.db.user.findUnique({ where: { email: "x@csrf.test" } })).toBeNull();
    });

    it("accepts our own pages and clients that send no Origin", async () => {
      await t.http().post("/v1/auth/login").set("Origin", "http://localhost:3600").send({ email: "csrf-login@example.com", password: "Correct-horse-9" }).expect(200);
      await t.http().post("/v1/auth/login").send({ email: "csrf-login@example.com", password: "Correct-horse-9" }).expect(200);
    });

    it("leaves other public endpoints (webhooks, embedded forms) alone", async () => {
      // A payment webhook arrives from the provider, never from our pages: refused for its signature, not its origin.
      const res = await t.http().post("/v1/webhooks/billing/stripe").set("Origin", "https://evil.example").send({});
      expect(res.status).not.toBe(403);
    });
  });

  describe("2.4 and 2.5 workspace roles and owners", () => {
    let owner: Agent;
    let w: string;
    beforeAll(async () => {
      owner = await signUp(t, "owner@roles.test");
      w = await createWorkspace(owner, "Roles");
      await setPlan(t, w, "growth");
    });

    it("a viewer cannot read the audit log", async () => {
      const viewer = await addMember(t, owner, w, "viewer@roles.test", "viewer");
      await viewer.get(`/v1/workspaces/${w}/audit`).expect(403);
      await owner.get(`/v1/workspaces/${w}/audit`).expect(200);
    });

    it("a company owner must be a member of the workspace", async () => {
      const stranger = await signUp(t, "stranger@elsewhere.test");
      const bad = await owner.post(`/v1/workspaces/${w}/companies`).send({ name: "Acme", ownerId: stranger.userId }).expect(400);
      expect(bad.body.error.message).toMatch(/member of this workspace/);
      const company = (await owner.post(`/v1/workspaces/${w}/companies`).send({ name: "Acme", ownerId: owner.userId }).expect(201)).body.data;
      await owner.patch(`/v1/workspaces/${w}/companies/${company.id}`).send({ ownerId: stranger.userId }).expect(400);
      const row = await t.prisma.db.company.findFirstOrThrow({ where: { workspaceId: w, id: company.id } });
      expect(row.ownerId).toBe(owner.userId);
    });
  });

  describe("2.6 registration does not reveal accounts", () => {
    it("answers a taken address exactly like a new one, without a session, and emails the owner", async () => {
      await signUp(t, "taken@example.com", "Taken Person");
      const fresh = await t.http().post("/v1/auth/register").send({ name: "New", email: "fresh@example.com", password: "Correct-horse-9" }).expect(201);
      const taken = await t.http().post("/v1/auth/register").send({ name: "Attacker", email: "taken@example.com", password: "Other-horse-99" }).expect(201);
      expect(taken.body).toEqual(fresh.body);
      expect(String(fresh.headers["set-cookie"])).toMatch(/gd_session=/);
      expect(taken.headers["set-cookie"]).toBeUndefined();

      const notice = t.mail.outbox.filter((m) => m.to === "taken@example.com" && m.template === "account_exists");
      expect(notice).toHaveLength(1);
      expect(notice[0]!.text).toMatch(/already has one/);
      // The existing password still works; the attempted one does not.
      await t.http().post("/v1/auth/login").send({ email: "taken@example.com", password: "Correct-horse-9" }).expect(200);
      await t.http().post("/v1/auth/login").send({ email: "taken@example.com", password: "Other-horse-99" }).expect(401);
    });

    it("sends at most three notices an hour", async () => {
      await signUp(t, "flood@example.com");
      for (let i = 0; i < 5; i++) {
        await t.http().post("/v1/auth/register").send({ name: "X", email: "flood@example.com", password: "Correct-horse-9" }).expect(201);
      }
      expect(t.mail.outbox.filter((m) => m.to === "flood@example.com" && m.template === "account_exists")).toHaveLength(3);
    });
  });

  describe("2.8 reset links", () => {
    it("a password reset burns every other reset link", async () => {
      await signUp(t, "burn@example.com");
      await t.http().post("/v1/auth/forgot-password").send({ email: "burn@example.com" }).expect(202);
      const first = tokenIn("burn@example.com", "reset_password");
      await t.http().post("/v1/auth/forgot-password").send({ email: "burn@example.com" }).expect(202);
      const second = tokenIn("burn@example.com", "reset_password");
      expect(second).not.toBe(first);
      await t.http().post("/v1/auth/reset-password").send({ token: second, password: "Brand-new-pass-7" }).expect(200);
      await t.http().post("/v1/auth/reset-password").send({ token: first, password: "Attacker-pass-77" }).expect(400);
      await t.http().post("/v1/auth/login").send({ email: "burn@example.com", password: "Brand-new-pass-7" }).expect(200);
    });

    it("changing the password burns outstanding reset links", async () => {
      const agent = await signUp(t, "change@example.com");
      await t.http().post("/v1/auth/forgot-password").send({ email: "change@example.com" }).expect(202);
      const pending = tokenIn("change@example.com", "reset_password");
      await agent.post("/v1/auth/change-password").send({ currentPassword: "Correct-horse-9", newPassword: "Changed-pass-77" }).expect(200);
      await t.http().post("/v1/auth/reset-password").send({ token: pending, password: "Attacker-pass-77" }).expect(400);
      const session = request.agent(t.app.getHttpServer() as App);
      await session.post("/v1/auth/login").send({ email: "change@example.com", password: "Changed-pass-77" }).expect(200);
    });
  });
});
