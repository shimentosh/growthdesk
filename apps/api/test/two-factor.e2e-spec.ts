import request from "supertest";
import type { App } from "supertest/types.js";
import { addMember, bootApp, createWorkspace, signUp, type Agent, type TestApp } from "./helpers.js";
import { AuthService } from "../src/auth/auth.service.js";
import { currentStep, totpCode } from "../src/auth/totp.js";

/*
 * TOTP two-factor (docs/GAP_PLAN.md 2.12): enrolment, the sign-in challenge,
 * recovery codes, turning it off, and a workspace that requires it.
 *
 * A code is accepted once per 30-second step, so tests that need several
 * codes in a row clear the remembered step first (codeFor); the replay test
 * checks that rule on its own.
 */
describe("Two-factor authentication", () => {
  let t: TestApp;
  const PASSWORD = "Correct-horse-9";
  const secrets = new Map<string, string>();

  /** A code the API will take now: forgets the last accepted step, then reads the current one. */
  const codeFor = async (userId: string) => {
    await t.prisma.db.user.update({ where: { id: userId }, data: { totpLastStep: null } });
    return totpCode(secrets.get(userId)!, currentStep());
  };
  const newAgent = () => request.agent(t.app.getHttpServer() as App);
  const audits = (action: string, targetId: string) => t.prisma.db.auditEvent.count({ where: { action, targetId } });

  /** Runs setup + enable for a signed-in person; returns their recovery codes. */
  async function enrol(agent: Agent): Promise<string[]> {
    const setup = await agent.post("/v1/auth/2fa/setup").expect(200);
    secrets.set(agent.userId, setup.body.data.secret);
    const res = await agent.post("/v1/auth/2fa/enable").send({ code: totpCode(setup.body.data.secret, currentStep()) }).expect(200);
    return res.body.data.recoveryCodes as string[];
  }

  /** Password step only: the agent ends up holding the pending challenge cookie. */
  async function passwordStep(email: string) {
    const agent = newAgent();
    const res = await agent.post("/v1/auth/login").send({ email, password: PASSWORD }).expect(200);
    expect(res.body.data).toEqual({ signedIn: false, twoFactorRequired: true });
    return agent;
  }

  beforeAll(async () => {
    t = await bootApp();
  });
  afterAll(async () => t.close());

  describe("one account", () => {
    let owner: Agent;
    let recovery: string[];

    beforeAll(async () => {
      owner = await signUp(t, "owner@twofa.test", "Owner", PASSWORD);
    });

    it("enrols: secret and QR code, confirmed by a code, with recovery codes shown once and stored hashed", async () => {
      expect((await owner.get("/v1/auth/2fa").expect(200)).body.data).toMatchObject({ enabled: false, recoveryCodesRemaining: 0 });
      const setup = await owner.post("/v1/auth/2fa/setup").expect(200);
      const { secret, otpauthUri, qrSvg } = setup.body.data as { secret: string; otpauthUri: string; qrSvg: string };
      expect(secret).toMatch(/^[A-Z2-7]{32}$/);
      expect(otpauthUri).toMatch(/^otpauth:\/\/totp\/.+owner%40twofa\.test\?secret=/);
      expect(qrSvg).toContain("<svg");
      secrets.set(owner.userId, secret);

      let user = await t.prisma.db.user.findUniqueOrThrow({ where: { id: owner.userId } });
      expect(user.totpPendingSecret).toBeTruthy();
      expect(user.totpPendingSecret).not.toContain(secret);
      expect(user.totpEnabledAt).toBeNull();

      await owner.post("/v1/auth/2fa/enable").send({ code: "000000" }).expect(400);
      const res = await owner.post("/v1/auth/2fa/enable").send({ code: totpCode(secret, currentStep()) }).expect(200);
      recovery = res.body.data.recoveryCodes;
      expect(recovery).toHaveLength(10);
      expect(new Set(recovery).size).toBe(10);

      user = await t.prisma.db.user.findUniqueOrThrow({ where: { id: owner.userId } });
      expect(user.totpEnabledAt).toBeTruthy();
      expect(user.totpPendingSecret).toBeNull();
      expect(user.totpSecret).not.toContain(secret);
      const stored = await t.prisma.db.recoveryCode.findMany({ where: { userId: owner.userId } });
      expect(stored).toHaveLength(10);
      for (const row of stored) expect(recovery.map((c) => c.replace("-", ""))).not.toContain(row.codeHash);

      expect((await owner.get("/v1/auth/2fa").expect(200)).body.data).toMatchObject({ enabled: true, recoveryCodesRemaining: 10 });
      expect((await owner.get("/v1/auth/me").expect(200)).body.data.user.twoFactorEnabled).toBe(true);
      await owner.post("/v1/auth/2fa/setup").expect(409);
      expect(await audits("auth.two_factor_enabled", owner.userId)).toBe(1);
    });

    it("signing in asks for a code before any session exists, and a code works only once", async () => {
      const agent = await passwordStep(owner.email);
      await agent.get("/v1/auth/me").expect(401);

      // A code for a step already used is refused, even though it is otherwise right.
      const step = currentStep();
      await t.prisma.db.user.update({ where: { id: owner.userId }, data: { totpLastStep: step } });
      const replay = await agent.post("/v1/auth/2fa/verify").send({ code: totpCode(secrets.get(owner.userId)!, step) }).expect(401);
      expect(replay.body.error.code).toBe("two_factor_invalid");

      const wrong = await agent.post("/v1/auth/2fa/verify").send({ code: "123456" }).expect(401);
      expect(wrong.body.error.code).toBe("two_factor_invalid");
      await agent.post("/v1/auth/2fa/verify").send({ code: await codeFor(owner.userId) }).expect(200);
      expect((await agent.get("/v1/auth/me").expect(200)).body.data.user.email).toBe(owner.email);
      // The challenge is spent and its cookie cleared.
      const again = await agent.post("/v1/auth/2fa/verify").send({ code: await codeFor(owner.userId) }).expect(401);
      expect(again.body.error.code).toBe("two_factor_expired");
      expect(await t.prisma.db.auditEvent.count({ where: { action: "auth.signed_in", targetId: owner.userId, metadata: { path: ["twoFactor"], equals: "totp" } } })).toBe(1);
    });

    it("a challenge allows five wrong codes, and the account locks after ten", async () => {
      await t.prisma.db.twoFactorChallenge.deleteMany({ where: { userId: owner.userId } });
      const first = await passwordStep(owner.email);
      for (let i = 0; i < 5; i++) await first.post("/v1/auth/2fa/verify").send({ code: "111111" }).expect(401);
      const spent = await first.post("/v1/auth/2fa/verify").send({ code: await codeFor(owner.userId) }).expect(401);
      expect(spent.body.error.code).toBe("two_factor_expired");

      const second = await passwordStep(owner.email);
      for (let i = 0; i < 5; i++) await second.post("/v1/auth/2fa/verify").send({ code: "222222" }).expect(401);
      const third = await passwordStep(owner.email);
      await third.post("/v1/auth/2fa/verify").send({ code: await codeFor(owner.userId) }).expect(429);
      await t.prisma.db.twoFactorChallenge.deleteMany({ where: { userId: owner.userId } });
    });

    it("a recovery code signs in once, is audited, and new codes replace the old ones", async () => {
      const agent = await passwordStep(owner.email);
      // Typed loosely: case, spaces and dashes do not matter.
      await agent.post("/v1/auth/2fa/verify").send({ code: ` ${recovery[0]!.toUpperCase().replace("-", " ")} ` }).expect(200);
      await agent.get("/v1/auth/me").expect(200);
      expect(await audits("auth.two_factor_recovery_code_used", owner.userId)).toBe(1);
      expect((await owner.get("/v1/auth/2fa").expect(200)).body.data.recoveryCodesRemaining).toBe(9);

      const reuse = await passwordStep(owner.email);
      await reuse.post("/v1/auth/2fa/verify").send({ code: recovery[0] }).expect(401);

      await owner.post("/v1/auth/2fa/recovery-codes").send({ code: "000000" }).expect(400);
      const fresh = (await owner.post("/v1/auth/2fa/recovery-codes").send({ code: await codeFor(owner.userId) }).expect(200)).body.data.recoveryCodes as string[];
      expect(fresh).toHaveLength(10);
      await reuse.post("/v1/auth/2fa/verify").send({ code: recovery[1] }).expect(401);
      await reuse.post("/v1/auth/2fa/verify").send({ code: fresh[0] }).expect(200);
      recovery = fresh.slice(1);
      await t.prisma.db.twoFactorChallenge.deleteMany({ where: { userId: owner.userId } });
    });

    it("Google sign-in for a two-factor account also stops at the challenge", async () => {
      const realFetch = globalThis.fetch;
      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input instanceof Request ? input.url : input);
        if (url.startsWith("https://oauth2.googleapis.com/token")) return new Response(JSON.stringify({ access_token: "tok" }), { status: 200 });
        if (url.startsWith("https://openidconnect.googleapis.com/")) {
          return new Response(JSON.stringify({ sub: "g-owner", email: owner.email, email_verified: true, name: "Owner" }), { status: 200 });
        }
        return realFetch(input, init);
      }) as typeof fetch;
      try {
        const result = await t.app.get(AuthService).googleCallback("code", { requestId: "t", ip: "127.0.0.1", userAgent: "test" });
        expect(result).toHaveProperty("challenge");
        expect(result).not.toHaveProperty("token");
        const row = await t.prisma.db.twoFactorChallenge.findFirstOrThrow({ where: { userId: owner.userId }, orderBy: { createdAt: "desc" } });
        expect(row.method).toBe("google");
      } finally {
        globalThis.fetch = realFetch;
      }
    });

    it("turning it off needs a code or the password, is audited, and sign-in goes back to one step", async () => {
      await owner.post("/v1/auth/2fa/disable").send({}).expect(400);
      await owner.post("/v1/auth/2fa/disable").send({ password: "Wrong-password-1" }).expect(400);
      await owner.post("/v1/auth/2fa/disable").send({ code: "000000" }).expect(400);
      await owner.post("/v1/auth/2fa/disable").send({ password: PASSWORD }).expect(200);
      expect(await audits("auth.two_factor_disabled", owner.userId)).toBe(1);
      const user = await t.prisma.db.user.findUniqueOrThrow({ where: { id: owner.userId } });
      expect(user).toMatchObject({ totpSecret: null, totpEnabledAt: null });
      expect(await t.prisma.db.recoveryCode.count({ where: { userId: owner.userId } })).toBe(0);
      const res = await newAgent().post("/v1/auth/login").send({ email: owner.email, password: PASSWORD }).expect(200);
      expect(res.body.data).toEqual({ signedIn: true });
    });
  });

  describe("workspace requirement", () => {
    let owner: Agent;
    let member: Agent;
    let w: string;

    beforeAll(async () => {
      owner = await signUp(t, "boss@twofa.test", "Boss", PASSWORD);
      w = await createWorkspace(owner, "Strict Co");
      member = await addMember(t, owner, w, "member@twofa.test", "admin");
    });

    it("only an owner with two-factor can require it", async () => {
      const before = await owner.get(`/v1/workspaces/${w}/security`).expect(200);
      expect(before.body.data).toMatchObject({ requireTwoFactor: false, canChange: true });
      expect(before.body.data.membersWithoutTwoFactor).toHaveLength(2);

      await owner.put(`/v1/workspaces/${w}/security`).send({ requireTwoFactor: true }).expect(409);
      await enrol(owner);
      await member.put(`/v1/workspaces/${w}/security`).send({ requireTwoFactor: true }).expect(403);
      const res = await owner.put(`/v1/workspaces/${w}/security`).send({ requireTwoFactor: true }).expect(200);
      expect(res.body.data.requireTwoFactor).toBe(true);
      expect(res.body.data.membersWithoutTwoFactor.map((m: { email: string }) => m.email)).toEqual(["member@twofa.test"]);
      expect(await t.prisma.db.auditEvent.count({ where: { action: "workspace.two_factor_required", workspaceId: w } })).toBe(1);
    });

    it("a member without two-factor is refused until they enrol, and cannot then turn it off", async () => {
      const refused = await member.get(`/v1/workspaces/${w}`).expect(403);
      expect(refused.body.error.code).toBe("two_factor_required");
      // Account routes stay open, so they can enrol.
      expect((await member.get("/v1/auth/2fa").expect(200)).body.data.requiredBy).toEqual([{ id: w, name: "Strict Co" }]);
      await enrol(member);
      await member.get(`/v1/workspaces/${w}`).expect(200);
      await member.put(`/v1/workspaces/${w}/security`).send({ requireTwoFactor: false }).expect(403);
      const blocked = await member.post("/v1/auth/2fa/disable").send({ password: PASSWORD }).expect(409);
      expect(blocked.body.error.message).toContain("Strict Co");

      await owner.put(`/v1/workspaces/${w}/security`).send({ requireTwoFactor: false }).expect(200);
      await member.post("/v1/auth/2fa/disable").send({ code: await codeFor(member.userId) }).expect(200);
      await member.get(`/v1/workspaces/${w}`).expect(200);
    });
  });

  it("platform staff sign in to the console through the same challenge", async () => {
    const staff = await signUp(t, "staff@twofa.test", "Staff", PASSWORD);
    await t.prisma.db.user.update({ where: { id: staff.userId }, data: { platformRole: "admin" } });
    await enrol(staff);
    const agent = await passwordStep(staff.email);
    await agent.get("/v1/admin/overview").expect(401);
    await agent.post("/v1/auth/2fa/verify").send({ code: await codeFor(staff.userId) }).expect(200);
    await agent.get("/v1/admin/overview").expect(200);
  });
});
