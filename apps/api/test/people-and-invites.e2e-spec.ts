import request from "supertest";
import type { App } from "supertest/types.js";
import { addMember, bootApp, createWorkspace, enableGoogleSignIn, setPlan, signUp, type Agent, type TestApp } from "./helpers.js";
import { LeadRoutingService } from "../src/automation/lead-routing.service.js";
import { PlatformSettingsService } from "../src/core/platform-settings.service.js";
import { safeNextPath } from "../src/auth/safe-next.js";

/*
 * Team-ready people features: bulk invitations with a personal note (role
 * and note in the email and on the accept page, resends audited), Google
 * sign-in that comes back to the invitation, profile details (title, phone,
 * away until), pausing a member's access, and lead routing that skips anyone
 * paused or away.
 */
describe("People and invitations", () => {
  let t: TestApp;
  let owner: Agent;
  let w: string;
  const api = (p: string) => `/v1/workspaces/${w}${p}`;
  const realFetch = globalThis.fetch;
  const invitationMail = (to: string) => t.mail.outbox.filter((m) => m.to === to && m.template === "invitation").at(-1);
  const tokenFor = (to: string) => decodeURIComponent(invitationMail(to)!.text.match(/invite\/([A-Za-z0-9_%-]+)/)![1]!);
  const memberRow = async (email: string) => {
    const list = (await owner.get(api("/members")).expect(200)).body.data;
    return list.members.find((m: { email: string }) => m.email === email);
  };

  const googleSays = (email: string, sub: string) => {
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.startsWith("https://oauth2.googleapis.com/token")) return new Response(JSON.stringify({ access_token: "tok" }), { status: 200 });
      if (url.startsWith("https://openidconnect.googleapis.com/")) return new Response(JSON.stringify({ sub, email, email_verified: true, name: "Gia Google" }), { status: 200 });
      return realFetch(input, init);
    }) as typeof fetch;
  };

  beforeAll(async () => {
    t = await bootApp();
    owner = await signUp(t, "olive@team.test", "Olive Owner");
    w = await createWorkspace(owner, "Team Co");
    await setPlan(t, w, "agency");
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });
  afterAll(async () => t.close());

  describe("invitations", () => {
    it("invites many at once, reporting bad addresses, members and pending invitations per address", async () => {
      const first = await owner
        .post(api("/invitations"))
        .send({ emails: ["ana@team.test", " ANA@team.test ", "not-an-email", "ben@team.test"], role: "member", message: "  Welcome <b>aboard</b> & see you Monday!  " })
        .expect(201);
      expect(first.body.data.results).toEqual([
        { email: "not-an-email", status: "invalid" },
        { email: "ana@team.test", status: "invited", invitationId: expect.any(String) },
        { email: "ben@team.test", status: "invited", invitationId: expect.any(String) },
      ]);
      const second = await owner.post(api("/invitations")).send({ emails: ["ana@team.test", "cy@team.test", "olive@team.test"], role: "viewer" }).expect(201);
      expect(second.body.data.results).toEqual([
        { email: "ana@team.test", status: "already_invited" },
        { email: "cy@team.test", status: "invited", invitationId: expect.any(String) },
        { email: "olive@team.test", status: "already_member" },
      ]);
      const stored = await t.prisma.db.invitation.findFirstOrThrow({ where: { workspaceId: w, email: "ana@team.test" } });
      expect(stored.message).toBe("Welcome <b>aboard</b> & see you Monday!");
    });

    it("keeps the single-address shape and errors", async () => {
      const one = await owner.post(api("/invitations")).send({ email: "dee@team.test", role: "member" }).expect(201);
      expect(one.body.data).toMatchObject({ id: expect.any(String), email: "dee@team.test", role: "member" });
      await owner.post(api("/invitations")).send({ email: "dee@team.test", role: "member" }).expect(409);
      await owner.post(api("/invitations")).send({ email: "nope", role: "member" }).expect(400);
      await owner.post(api("/invitations")).send({ role: "member" }).expect(400);
      await owner.post(api("/invitations")).send({ emails: [], role: "member" }).expect(400);
      await owner.post(api("/invitations")).send({ emails: Array.from({ length: 51 }, (_, i) => `p${i}@team.test`), role: "member" }).expect(400);
      await owner.post(api("/invitations")).send({ email: "long@team.test", role: "member", message: "x".repeat(501) }).expect(400);
      // Rank rules refuse a whole batch.
      await owner.post(api("/invitations")).send({ emails: ["boss@team.test"], role: "owner" }).expect(400);
    });

    it("counts seats for the whole batch and reports the ones that did not fit", async () => {
      const small = await signUp(t, "sol@small.test", "Sol Small");
      const sw = await createWorkspace(small, "Small Co");
      await setPlan(t, sw, "starter"); // 2 seats: the owner and one more
      const res = await small.post(`/v1/workspaces/${sw}/invitations`).send({ emails: ["s1@small.test", "s2@small.test", "s3@small.test"], role: "member" }).expect(201);
      expect(res.body.data.results.map((r: { status: string }) => r.status)).toEqual(["invited", "no_seat", "no_seat"]);
      expect(await t.prisma.db.invitation.count({ where: { workspaceId: sw } })).toBe(1);
    });

    it("the email states the role in plain words, the workspace and the note (escaped)", async () => {
      const mail = invitationMail("ana@team.test")!;
      expect(mail.subject).toBe("Olive Owner invited you to Team Co on Growthdesk");
      expect(mail.text).toContain("join Team Co on Growthdesk as a member — works contacts, deals, campaigns and the inbox");
      expect(mail.text).toContain("Welcome <b>aboard</b> & see you Monday!");
      expect(mail.html).toContain("Welcome &lt;b&gt;aboard&lt;/b&gt; &amp; see you Monday!");
      expect(mail.html).not.toContain("<b>aboard</b>");
      // No note, no empty quote.
      const plain = invitationMail("cy@team.test")!;
      expect(plain.text).toContain("as a viewer — can look at records and reports but not change them");
      expect(plain.html).not.toContain("&ldquo;");
    });

    it("the accept page learns who invited them, the role and the note", async () => {
      const info = (await t.http().get(`/v1/invitations/${tokenFor("ana@team.test")}`).expect(200)).body.data;
      expect(info).toMatchObject({
        email: "ana@team.test",
        role: "member",
        workspaceName: "Team Co",
        accountExists: false,
        invitedBy: { name: "Olive Owner", email: "olive@team.test" },
        message: "Welcome <b>aboard</b> & see you Monday!",
      });
    });

    it("a resend is audited and carries the note again", async () => {
      const inv = await t.prisma.db.invitation.findFirstOrThrow({ where: { workspaceId: w, email: "ben@team.test" } });
      const before = t.mail.outbox.length;
      await owner.post(api(`/invitations/${inv.id}/resend`)).expect(200);
      expect(t.mail.outbox.length).toBe(before + 1);
      expect(invitationMail("ben@team.test")!.text).toContain("Welcome <b>aboard</b>");
      const audit = await t.prisma.db.auditEvent.findFirstOrThrow({ where: { workspaceId: w, action: "member.invitation_resent" } });
      expect(audit).toMatchObject({ targetType: "invitation", targetId: inv.id, actorUserId: owner.userId });
    });
  });

  describe("Google sign-in keeps the invitation", () => {
    it("only same-site paths survive as next", () => {
      expect(safeNextPath("/invite/abc")).toBe("/invite/abc");
      expect(safeNextPath("/w/1?tab=x#y")).toBe("/w/1?tab=x#y");
      for (const bad of ["//evil.test", "https://evil.test", "/\\evil.test", "/\t/evil.test", "evil", "", undefined, 42, ["//x"]]) expect(safeNextPath(bad)).toBe("/");
    });

    it("start stores next, the callback lands there, and an invited newcomer joins in one click (even invite-only)", async () => {
      const settings = t.app.get(PlatformSettingsService);
      await enableGoogleSignIn(t);
      await settings.update({ signupMode: "invite_only" }, null);
      try {
        await owner.post(api("/invitations")).send({ emails: ["gia@team.test"], role: "member", message: "Hi Gia" }).expect(201);
        const token = tokenFor("gia@team.test");
        const next = `/invite/${token}`;
        const agent = request.agent(t.app.getHttpServer() as App);
        const start = await agent.get(`/v1/auth/google/start?next=${encodeURIComponent(next)}`).expect(302);
        expect(String(start.headers["set-cookie"])).toContain("gd_oauth_signup=");
        const state = new URL(start.headers.location as string).searchParams.get("state")!;

        googleSays("gia@team.test", "google-sub-gia");
        const back = await agent.get(`/v1/auth/google/callback?code=c0de&state=${encodeURIComponent(state)}`).expect(302);
        expect(back.headers.location).toBe(next);

        const me = (await agent.get("/v1/auth/me").expect(200)).body.data.user;
        expect(me.email).toBe("gia@team.test");
        const joined = await agent.post(`/v1/invitations/${token}/accept`).expect(200);
        expect(joined.body.data.workspaceId).toBe(w);
        expect(await memberRow("gia@team.test")).toMatchObject({ role: "member" });
      } finally {
        await settings.update({ signupMode: "open" }, null);
      }
    });

    it("an off-site next is dropped: the callback goes to /", async () => {
      await enableGoogleSignIn(t);
      const agent = request.agent(t.app.getHttpServer() as App);
      const start = await agent.get(`/v1/auth/google/start?next=${encodeURIComponent("//evil.test/x")}`).expect(302);
      const state = new URL(start.headers.location as string).searchParams.get("state")!;
      googleSays("olive@team.test", "google-sub-olive");
      const back = await agent.get(`/v1/auth/google/callback?code=c0de&state=${encodeURIComponent(state)}`).expect(302);
      expect(back.headers.location).toBe("/");
    });
  });

  describe("profile details", () => {
    it("saves title, phone and away-until, shown in /auth/me and the members list", async () => {
      const until = new Date(Date.now() + 3 * 86_400_000).toISOString();
      await owner.patch("/v1/auth/me").send({ title: " Head of Sales ", phone: "+44 20 7946 0000", outOfOfficeUntil: until }).expect(200);
      const me = (await owner.get("/v1/auth/me").expect(200)).body.data.user;
      expect(me).toMatchObject({ title: "Head of Sales", phone: "+44 20 7946 0000", outOfOfficeUntil: until });
      expect(await memberRow("olive@team.test")).toMatchObject({ title: "Head of Sales", phone: "+44 20 7946 0000", outOfOfficeUntil: until, deactivatedAt: null });

      await owner.patch("/v1/auth/me").send({ title: "x".repeat(101) }).expect(400);
      await owner.patch("/v1/auth/me").send({ phone: "1".repeat(41) }).expect(400);
      await owner.patch("/v1/auth/me").send({ outOfOfficeUntil: "next tuesday" }).expect(400);
      await owner.patch("/v1/auth/me").send({ outOfOfficeUntil: null }).expect(200);
      expect((await owner.get("/v1/auth/me").expect(200)).body.data.user.outOfOfficeUntil).toBeNull();
    });
  });

  describe("pausing access", () => {
    let pat: Agent;
    let adm: Agent;
    beforeAll(async () => {
      pat = await addMember(t, owner, w, "pat@team.test", "member");
      adm = await addMember(t, owner, w, "adm@team.test", "admin");
    });

    it("a paused member gets 403 member_deactivated; restoring brings them back; both audited", async () => {
      await pat.get(api("/contacts")).expect(200);
      const row = await memberRow("pat@team.test");
      const paused = await adm.patch(api(`/members/${row.id}`)).send({ deactivated: true }).expect(200);
      expect(paused.body.data.deactivatedAt).toBeTruthy();
      const refused = await pat.get(api("/contacts")).expect(403);
      expect(refused.body.error.code).toBe("member_deactivated");
      expect((await memberRow("pat@team.test")).deactivatedAt).toBeTruthy();
      // They keep their seat and role.
      expect(await memberRow("pat@team.test")).toMatchObject({ role: "member" });

      await adm.patch(api(`/members/${row.id}`)).send({ deactivated: false }).expect(200);
      await pat.get(api("/contacts")).expect(200);
      const actions = (await t.prisma.db.auditEvent.findMany({ where: { workspaceId: w, targetId: row.id }, orderBy: { createdAt: "asc" } })).map((a) => a.action);
      expect(actions).toEqual(expect.arrayContaining(["member.deactivated", "member.reactivated"]));
    });

    it("never the owner, never yourself, never someone at or above your level, and only with members.manage", async () => {
      const ownerRow = await memberRow("olive@team.test");
      const admRow = await memberRow("adm@team.test");
      const patRow = await memberRow("pat@team.test");
      await adm.patch(api(`/members/${ownerRow.id}`)).send({ deactivated: true }).expect(403);
      await adm.patch(api(`/members/${admRow.id}`)).send({ deactivated: true }).expect(403);
      await pat.patch(api(`/members/${admRow.id}`)).send({ deactivated: true }).expect(403);
      await owner.patch(api(`/members/${patRow.id}`)).send({}).expect(400);
      // The role change still works as before.
      expect((await owner.patch(api(`/members/${patRow.id}`)).send({ role: "viewer" }).expect(200)).body.data).toMatchObject({ role: "viewer" });
      await owner.patch(api(`/members/${patRow.id}`)).send({ role: "member" }).expect(200);
    });
  });

  describe("routing skips absent people", () => {
    it("lead routing passes over paused and away members, and assigns nobody when all are absent", async () => {
      const boss = await signUp(t, "rae@route.test", "Rae Router");
      const rw = await createWorkspace(boss, "Route Co");
      await setPlan(t, rw, "agency");
      const ids: Record<string, string> = {};
      const agents: Record<string, Agent> = {};
      for (const n of ["ana", "ben", "cat"]) {
        agents[n] = await addMember(t, boss, rw, `${n}@route.test`, "member");
        ids[n] = agents[n].userId;
      }
      await boss.put(`/v1/workspaces/${rw}/lead-routing`).send({ enabled: true, rules: [], fallback: { mode: "round_robin", userIds: [ids.ana, ids.ben, ids.cat] } }).expect(200);

      const members = (await boss.get(`/v1/workspaces/${rw}/members`).expect(200)).body.data.members as { id: string; userId: string }[];
      const benRow = members.find((m) => m.userId === ids.ben)!;
      await boss.patch(`/v1/workspaces/${rw}/members/${benRow.id}`).send({ deactivated: true }).expect(200);
      await agents.cat!.patch("/v1/auth/me").send({ outOfOfficeUntil: new Date(Date.now() + 86_400_000).toISOString() }).expect(200);
      // An away date in the past means they are back.
      await agents.ana!.patch("/v1/auth/me").send({ outOfOfficeUntil: new Date(Date.now() - 60_000).toISOString() }).expect(200);

      const routing = t.app.get(LeadRoutingService);
      const contacts: string[] = [];
      for (const n of [1, 2, 3]) contacts.push((await boss.post(`/v1/workspaces/${rw}/contacts`).send({ fullName: `Lead ${n}`, email: `lead${n}@x.example` }).expect(201)).body.data.id);
      await routing.route(rw, contacts);
      const owners = await t.prisma.db.contact.findMany({ where: { workspaceId: rw, id: { in: contacts } }, select: { ownerId: true } });
      expect(owners.map((o) => o.ownerId)).toEqual([ids.ana, ids.ana, ids.ana]);

      // Everyone absent: the lead stays unowned.
      await agents.ana!.patch("/v1/auth/me").send({ outOfOfficeUntil: new Date(Date.now() + 86_400_000).toISOString() }).expect(200);
      const orphan = (await boss.post(`/v1/workspaces/${rw}/contacts`).send({ fullName: "Nobody's", email: "nobody@x.example" }).expect(201)).body.data.id;
      expect((await routing.route(rw, [orphan])).routed).toBe(0);
      expect((await t.prisma.db.contact.findFirstOrThrow({ where: { workspaceId: rw, id: orphan } })).ownerId).toBeNull();

      // Back from leave and restored: in the pool again.
      await agents.cat!.patch("/v1/auth/me").send({ outOfOfficeUntil: null }).expect(200);
      await routing.route(rw, [orphan]);
      expect((await t.prisma.db.contact.findFirstOrThrow({ where: { workspaceId: rw, id: orphan } })).ownerId).toBe(ids.cat);
    });
  });
});
