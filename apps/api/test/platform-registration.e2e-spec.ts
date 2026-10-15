import request from "supertest";
import type { App } from "supertest/types.js";
import { bootApp, createWorkspace, enableGoogleSignIn, signUp, type Agent, type TestApp } from "./helpers.js";
import { PlatformSettingsService, type PlatformSettings } from "../src/core/platform-settings.service.js";
import { csvCell } from "../src/admin/admin-users.service.js";
import { parseAttributionCookie } from "../src/auth/signup-profile.js";
import { domainListed, DISPOSABLE_DOMAINS } from "../src/auth/disposable-domains.js";
import { derivedKey, hashToken, hmac } from "../src/common/crypto.js";

/*
 * Super-admin Phase 3: the sign-up policy (modes, invitations, waitlist,
 * blocked domains), what a sign-up records (source, attribution, consent),
 * the verification and trial settings, and the platform user actions with
 * their rank rules (support / admin / owner), including deletion.
 */

const PASSWORD = "Correct-horse-9";
const DEFAULTS: Partial<PlatformSettings> = {
  signupMode: "open",
  signupsOpen: true,
  signupDomains: [],
  blockDisposableDomains: true,
  extraBlockedDomains: [],
  requireEmailVerification: true,
  defaultTrialDays: null,
};

describe("Platform registration and user management", () => {
  let t: TestApp;
  let settings: PlatformSettingsService;
  let owner: Agent;
  let admin: Agent;
  let support: Agent;

  const setRole = (userId: string, platformRole: "none" | "support" | "admin" | "owner") =>
    t.prisma.db.user.update({ where: { id: userId }, data: { platformRole } });
  const set = (patch: Partial<PlatformSettings>) => settings.update(patch, null);
  const agent = () => request.agent(t.app.getHttpServer() as App);
  const register = (body: Record<string, unknown>, cookie?: string) => {
    const req = agent().post("/v1/auth/register");
    if (cookie) req.set("Cookie", cookie);
    return req.send({ name: "New Person", password: PASSWORD, acceptTerms: true, ...body });
  };
  const mails = (to: string, template: string) => t.mail.outbox.filter((m) => m.to === to && m.template === template);
  const userBy = (email: string) => t.prisma.db.user.findUniqueOrThrow({ where: { email } });
  const profileOf = (userId: string) => t.prisma.db.platformUserProfile.findUnique({ where: { userId } });
  const tokenFromUrl = (url: string) => decodeURIComponent(new URL(url).searchParams.get("invite") ?? "");

  beforeAll(async () => {
    t = await bootApp();
    settings = t.app.get(PlatformSettingsService);
    owner = await signUp(t, "owner@platform.test", "Plat Owner");
    admin = await signUp(t, "admin@platform.test", "Plat Admin");
    support = await signUp(t, "support@platform.test", "Plat Support");
    await setRole(owner.userId, "owner");
    await setRole(admin.userId, "admin");
    await setRole(support.userId, "support");
  });
  beforeEach(async () => {
    await set(DEFAULTS);
  });
  afterAll(async () => t.close());

  describe("sign-up modes", () => {
    it("answers the register page's policy question", async () => {
      const open = await t.http().get("/v1/auth/signup-policy").expect(200);
      expect(open.body.data).toMatchObject({ mode: "open", requiresInvite: false, invite: null });
      expect(typeof open.body.data.googleEnabled).toBe("boolean");
      await set({ signupMode: "invite_only", signupsOpen: true });
      const inv = await t.http().get("/v1/auth/signup-policy?invite=not-a-real-token").expect(200);
      expect(inv.body.data).toMatchObject({ mode: "invite_only", requiresInvite: true, invite: { valid: false, email: null } });
    });

    it("closed refuses every sign-up, including a legacy install with only signupsOpen=false", async () => {
      await set({ signupMode: "closed", signupsOpen: false });
      const res = await register({ email: "closed1@example.com" }).expect(403);
      expect(res.body.error.code).toBe("signup_closed");
      // Before signupMode existed: signupsOpen false and the mode at its default.
      await set({ signupMode: "open", signupsOpen: false });
      expect((await t.http().get("/v1/auth/signup-policy").expect(200)).body.data.mode).toBe("closed");
      expect((await register({ email: "closed2@example.com" }).expect(403)).body.error.code).toBe("signup_closed");
    });

    it("keeps signupsOpen and signupMode in step when either is saved", async () => {
      const read = async () => (await admin.get("/v1/admin/settings").expect(200)).body.data as PlatformSettings;
      await admin.patch("/v1/admin/settings").send({ signupMode: "waitlist" }).expect(200);
      expect(await read()).toMatchObject({ signupMode: "waitlist", signupsOpen: true });
      // The older switch, still sent by the old settings form, leaves waitlist alone when "on"…
      await admin.patch("/v1/admin/settings").send({ signupsOpen: true, signupDomains: [] }).expect(200);
      expect(await read()).toMatchObject({ signupMode: "waitlist", signupsOpen: true });
      // …closes when "off", and reopens a closed install.
      await admin.patch("/v1/admin/settings").send({ signupsOpen: false }).expect(200);
      expect(await read()).toMatchObject({ signupMode: "closed", signupsOpen: false });
      await admin.patch("/v1/admin/settings").send({ signupsOpen: true }).expect(200);
      expect(await read()).toMatchObject({ signupMode: "open", signupsOpen: true });
      await admin.patch("/v1/admin/settings").send({ signupMode: "closed" }).expect(200);
      expect(await read()).toMatchObject({ signupMode: "closed", signupsOpen: false });
      const audit = await t.prisma.db.auditEvent.findMany({ where: { action: "platform.settings_updated" } });
      expect(audit.length).toBeGreaterThan(0);
    });

    it("workspace invitations still work in every mode", async () => {
      const boss = await signUp(t, "boss@team.example", "Boss");
      const w = await createWorkspace(boss, "Team");
      await set({ signupMode: "closed", signupsOpen: false });
      await boss.post(`/v1/workspaces/${w}/invitations`).send({ email: "mate@team.example", role: "member" }).expect(201);
      const token = mails("mate@team.example", "invitation").at(-1)?.text.match(/invite\/([A-Za-z0-9_%-]+)/)?.[1];
      expect(token).toBeTruthy();
      await agent().post(`/v1/invitations/${token}/register`).send({ name: "Mate", password: PASSWORD, acceptTerms: true }).expect(201);
      const mate = await userBy("mate@team.example");
      expect((await profileOf(mate.id))?.signupSource).toBe("workspace_invite");
    });
  });

  describe("blocked domains", () => {
    it("refuses disposable addresses (and their subdomains) unless the setting is off", async () => {
      expect(DISPOSABLE_DOMAINS.size).toBeGreaterThan(300);
      expect(domainListed("inbox.mailinator.com", DISPOSABLE_DOMAINS)).toBe(true);
      expect(domainListed("gmail.com", DISPOSABLE_DOMAINS)).toBe(false);
      expect((await register({ email: "throw@mailinator.com" }).expect(403)).body.error.code).toBe("signup_domain_blocked");
      expect((await register({ email: "throw@x.yopmail.com" }).expect(403)).body.error.code).toBe("signup_domain_blocked");
      await set({ blockDisposableDomains: false });
      await register({ email: "allowed@mailinator.com" }).expect(201);
    });

    it("refuses the admin's extra blocked domains and enforces the allow-list", async () => {
      await admin.patch("/v1/admin/settings").send({ extraBlockedDomains: ["not a domain"] }).expect(400);
      await admin.patch("/v1/admin/settings").send({ extraBlockedDomains: [" @Spammy.Test ", "spammy.test"] }).expect(200);
      expect((await settings.get()).extraBlockedDomains).toEqual(["spammy.test"]);
      expect((await register({ email: "a@spammy.test" }).expect(403)).body.error.code).toBe("signup_domain_blocked");
      expect((await register({ email: "a@mx.spammy.test" }).expect(403)).body.error.code).toBe("signup_domain_blocked");
      await set({ extraBlockedDomains: [], signupDomains: ["corp.example"] });
      expect((await register({ email: "a@other.example" }).expect(403)).body.error.code).toBe("signup_domain_not_allowed");
      await register({ email: "a@corp.example" }).expect(201);
    });
  });

  describe("invitations and the waitlist", () => {
    it("invite-only: needs a valid, unused, unexpired invitation for the same address", async () => {
      await set({ signupMode: "invite_only" });
      expect((await register({ email: "invitee@example.com" }).expect(403)).body.error.code).toBe("signup_invite_required");
      expect((await register({ email: "invitee@example.com", inviteToken: "x".repeat(20) }).expect(403)).body.error.code).toBe("signup_invite_invalid");

      await support.post("/v1/admin/signup-invites").send({ email: "invitee@example.com" }).expect(403);
      const created = await admin.post("/v1/admin/signup-invites").send({ email: "Invitee@Example.com", expiresDays: 7 }).expect(201);
      expect(created.body.data.invite).toMatchObject({ email: "invitee@example.com", status: "pending", createdBy: { email: "admin@platform.test" } });
      expect(mails("invitee@example.com", "signup_invite")).toHaveLength(1);
      const token = tokenFromUrl(created.body.data.url);
      expect(created.body.data.url).toContain("http://localhost:3600/register?invite=");

      const policy = await t.http().get(`/v1/auth/signup-policy?invite=${encodeURIComponent(token)}`).expect(200);
      expect(policy.body.data.invite).toEqual({ valid: true, email: "invitee@example.com" });

      expect((await register({ email: "someone-else@example.com", inviteToken: token }).expect(403)).body.error.code).toBe("signup_invite_invalid");
      // A valid invitation skips the domain rules: the admin chose this address.
      await set({ signupDomains: ["corp.example"] });
      await register({ email: "invitee@example.com", inviteToken: token }).expect(201);
      const user = await userBy("invitee@example.com");
      expect(user.emailVerifiedAt).not.toBeNull();
      expect(mails("invitee@example.com", "verify_email")).toHaveLength(0);
      expect((await profileOf(user.id))?.signupSource).toBe("invite");
      const row = await t.prisma.db.platformSignupInvite.findUniqueOrThrow({ where: { tokenHash: hashToken(token) } });
      expect(row.usedAt).not.toBeNull();

      // Used: cannot be used again, cannot be revoked; listed as used.
      expect((await register({ email: "invitee2@example.com", inviteToken: token }).expect(403)).body.error.code).toBe("signup_invite_invalid");
      await admin.delete(`/v1/admin/signup-invites/${row.id}`).expect(409);
      const used = await admin.get("/v1/admin/signup-invites?status=used").expect(200);
      expect(used.body.data.items.map((i: { email: string }) => i.email)).toContain("invitee@example.com");

      // An account already exists for that address.
      await admin.post("/v1/admin/signup-invites").send({ email: "invitee@example.com" }).expect(409);
    });

    it("an expired or revoked invitation does not work", async () => {
      await set({ signupMode: "invite_only" });
      const a = await admin.post("/v1/admin/signup-invites").send({ email: "late@example.com" }).expect(201);
      await t.prisma.db.platformSignupInvite.update({ where: { id: a.body.data.invite.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
      expect((await register({ email: "late@example.com", inviteToken: tokenFromUrl(a.body.data.url) }).expect(403)).body.error.code).toBe("signup_invite_invalid");
      const expired = await admin.get("/v1/admin/signup-invites?status=expired").expect(200);
      expect(expired.body.data.items[0]).toMatchObject({ email: "late@example.com", status: "expired" });

      const b = await admin.post("/v1/admin/signup-invites").send({ email: "revoked@example.com" }).expect(201);
      await admin.delete(`/v1/admin/signup-invites/${b.body.data.invite.id}`).expect(200);
      expect((await register({ email: "revoked@example.com", inviteToken: tokenFromUrl(b.body.data.url) }).expect(403)).body.error.code).toBe("signup_invite_invalid");
      const audit = await t.prisma.db.auditEvent.findMany({ where: { action: { in: ["platform.signup_invite_created", "platform.signup_invite_revoked"] } } });
      expect(audit.every((a) => a.actorType === "platform_admin")).toBe(true);
    });

    it("waitlist: join, admin invites, the person registers", async () => {
      await t.http().post("/v1/auth/waitlist").send({ email: "early@example.com", name: "Early" }).expect(409);
      await set({ signupMode: "waitlist" });
      expect((await register({ email: "early@example.com" }).expect(403)).body.error.code).toBe("signup_waitlist");

      const attr = encodeURIComponent(JSON.stringify({ utm_source: "producthunt", landingPath: "/" }));
      await t.http().post("/v1/auth/waitlist").set("Cookie", `gd_attr=${attr}`).send({ email: "Early@Example.com", name: "Early" }).expect(202);
      await t.http().post("/v1/auth/waitlist").send({ email: "early@example.com", name: "Again" }).expect(202);
      expect(mails("early@example.com", "waitlist_confirmed")).toHaveLength(1);
      expect((await t.http().post("/v1/auth/waitlist").send({ email: "x@mailinator.com" }).expect(403)).body.error.code).toBe("signup_domain_blocked");
      await t.http().post("/v1/auth/waitlist").send({ email: "later@example.com" }).expect(202);

      await support.get("/v1/admin/waitlist").expect(403);
      const list = await admin.get("/v1/admin/waitlist?status=pending").expect(200);
      expect(list.body.data.counts).toEqual({ pending: 2, invited: 0, rejected: 0 });
      const entry = list.body.data.items.find((e: { email: string }) => e.email === "early@example.com");
      expect(entry).toMatchObject({ name: "Early", status: "pending", utm: { utm_source: "producthunt" } });

      const invited = await admin.post(`/v1/admin/waitlist/${entry.id}/invite`).send({}).expect(200);
      expect(invited.body.data.entry).toMatchObject({ status: "invited" });
      expect(invited.body.data.invite).toMatchObject({ email: "early@example.com", status: "pending" });
      const mail = mails("early@example.com", "signup_invite").at(-1);
      expect(`${mail?.text ?? ""}${mail?.html ?? ""}`).toContain("/register?invite=");

      const later = list.body.data.items.find((e: { email: string }) => e.email === "later@example.com");
      const rejected = await admin.post(`/v1/admin/waitlist/${later.id}/reject`).expect(200);
      expect(rejected.body.data.status).toBe("rejected");

      const person = agent();
      await person.post("/v1/auth/register").send({ name: "Early", email: "early@example.com", password: PASSWORD, inviteToken: tokenFromUrl(invited.body.data.url), acceptTerms: true }).expect(201);
      const me = await person.get("/v1/auth/me").expect(200);
      expect(me.body.data.user).toMatchObject({ email: "early@example.com", emailVerified: true });
      expect((await profileOf(me.body.data.user.id))?.signupSource).toBe("invite");
    });
  });

  describe("Google sign-up", () => {
    const realFetch = globalThis.fetch;
    beforeEach(async () => {
      // After the outer beforeEach, which puts the settings (and so the Google client) back to their defaults.
      await enableGoogleSignIn(t);
    });
    afterEach(() => {
      globalThis.fetch = realFetch;
    });
    /** Fakes Google's two endpoints, then calls our callback with a valid state and the cookies the register page leaves. */
    const googleCallback = async (email: string, sub: string, cookies: string[]) => {
      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input instanceof Request ? input.url : input);
        if (url.startsWith("https://oauth2.googleapis.com/token")) return new Response(JSON.stringify({ access_token: "tok" }), { status: 200 });
        if (url.startsWith("https://openidconnect.googleapis.com/")) return new Response(JSON.stringify({ sub, email, email_verified: true, name: "G User" }), { status: 200 });
        return realFetch(input, init);
      }) as typeof fetch;
      const nonce = `n${sub}`;
      const state = `${nonce}.${hmac(derivedKey("oauth-state"), nonce, "base64url")}`;
      return t
        .http()
        .get(`/v1/auth/google/callback?code=abc&state=${encodeURIComponent(state)}`)
        .set("Cookie", [`gd_oauth_state=${state}`, ...cookies].join("; "))
        .expect(302);
    };

    it("carries the invitation, consent and attribution across the OAuth round-trip", async () => {
      await set({ signupMode: "invite_only" });
      const created = await admin.post("/v1/admin/signup-invites").send({ email: "guser@example.com" }).expect(201);
      const signup = encodeURIComponent(JSON.stringify({ invite: tokenFromUrl(created.body.data.url), consent: true }));
      const attr = encodeURIComponent(JSON.stringify({ utm_source: "newsletter" }));
      const res = await googleCallback("guser@example.com", "g-sub-1", [`gd_oauth_signup=${signup}`, `gd_attr=${attr}`]);
      expect(res.headers.location).toBe("/");
      const user = await userBy("guser@example.com");
      expect(user.googleSub).toBe("g-sub-1");
      expect(await profileOf(user.id)).toMatchObject({ signupSource: "invite", marketingConsent: true, consentSource: "signup_form", utm: { utm_source: "newsletter" } });
      expect((await t.prisma.db.platformSignupInvite.findUniqueOrThrow({ where: { id: created.body.data.invite.id } })).usedAt).not.toBeNull();
    });

    it("sends a refused Google sign-up back to the register page with the policy's code", async () => {
      await set({ signupMode: "waitlist" });
      const res = await googleCallback("nobody@example.com", "g-sub-2", []);
      expect(res.headers.location).toBe("/register?error=signup_waitlist");
      expect(await t.prisma.db.user.count({ where: { email: "nobody@example.com" } })).toBe(0);
      await set({ signupMode: "open" });
      await googleCallback("open@example.com", "g-sub-3", []);
      expect(await profileOf((await userBy("open@example.com")).id)).toMatchObject({ signupSource: "google", marketingConsent: false });
    });
  });

  describe("what a sign-up records", () => {
    it("stores first-touch attribution from gd_attr and the consent tick", async () => {
      const attr = { utm_source: "google", utm_medium: "cpc", utm_campaign: "launch", referrer: "https://news.example/item", landingPath: "/pricing", evil: "dropped" };
      await register({ email: "attr@example.com", marketingConsent: true }, `gd_attr=${encodeURIComponent(JSON.stringify(attr))}`).expect(201);
      const p = await profileOf((await userBy("attr@example.com")).id);
      expect(p).toMatchObject({
        signupSource: "password",
        utm: { utm_source: "google", utm_medium: "cpc", utm_campaign: "launch" },
        referrer: "https://news.example/item",
        landingPath: "/pricing",
        marketingConsent: true,
        consentSource: "signup_form",
      });
      expect(p?.consentAt).not.toBeNull();
      expect(JSON.stringify(p?.utm)).not.toContain("evil");

      await register({ email: "noconsent@example.com" }, "gd_attr=%7Bnot-json").expect(201);
      const q = await profileOf((await userBy("noconsent@example.com")).id);
      expect(q).toMatchObject({ signupSource: "password", utm: {}, referrer: "", marketingConsent: false, consentAt: null, consentSource: "" });
    });

    it("ignores an oversized or malformed attribution cookie", () => {
      expect(parseAttributionCookie(JSON.stringify({ utm_source: "x".repeat(3000) }))).toBeNull();
      expect(parseAttributionCookie("[1,2]")).toBeNull();
      expect(parseAttributionCookie(undefined)).toBeNull();
      expect(parseAttributionCookie(JSON.stringify({ utm_source: 5, utm_medium: "email\u0000" }))).toEqual({ utm_medium: "email" });
      expect(parseAttributionCookie({ utm_source: "obj" })).toEqual({ utm_source: "obj" });
    });
  });

  describe("verification and trial settings", () => {
    it("requireEmailVerification off lets an unconfirmed account work; on blocks it again", async () => {
      const person = agent();
      await person.post("/v1/auth/register").send({ name: "Unver", email: "unverified@example.com", password: PASSWORD, acceptTerms: true }).expect(201);
      expect((await person.get("/v1/auth/me").expect(200)).body.data.emailVerificationRequired).toBe(true);
      await person.post("/v1/workspaces").send({ name: "Nope", businessType: "agency", timezone: "UTC" }).expect(403);

      await set({ requireEmailVerification: false });
      expect((await person.get("/v1/auth/me").expect(200)).body.data.emailVerificationRequired).toBe(false);
      const w = (await person.post("/v1/workspaces").send({ name: "Unverified Co", businessType: "agency", timezone: "UTC" }).expect(201)).body.data.id;
      await person.get(`/v1/workspaces/${w}`).expect(200);
      await person.post(`/v1/workspaces/${w}/contacts`).send({ fullName: "Ada Lovelace", email: "ada@lovelace.example" }).expect(201);

      await set({ requireEmailVerification: true });
      await person.get(`/v1/workspaces/${w}`).expect(403);
      // @AllowUnverified routes stay reachable either way.
      await person.patch("/v1/auth/me").send({ name: "Still Me" }).expect(200);
    });

    it("defaultTrialDays overrides the plan's trial length when set", async () => {
      const trialOf = async (agentFor: Agent, name: string) => {
        const w = await createWorkspace(agentFor, name);
        const ws = await t.prisma.db.workspace.findUniqueOrThrow({ where: { id: w } });
        return t.prisma.db.subscription.findUniqueOrThrow({ where: { billingAccountId: ws.billingAccountId } });
      };
      await set({ defaultTrialDays: 3 });
      const a = await trialOf(await signUp(t, "trial3@example.com"), "Three");
      expect(a.status).toBe("trialing");
      expect(Math.round((a.trialEndsAt!.getTime() - Date.now()) / 86_400_000)).toBe(3);
      await set({ defaultTrialDays: 0 });
      const b = await trialOf(await signUp(t, "trial0@example.com"), "Zero");
      expect(b).toMatchObject({ status: "active", trialEndsAt: null });
      await set({ defaultTrialDays: null });
      const c = await trialOf(await signUp(t, "trialplan@example.com"), "Plan");
      expect(Math.round((c.trialEndsAt!.getTime() - Date.now()) / 86_400_000)).toBe(14);
    });
  });

  describe("admin user actions", () => {
    let customer: Agent;
    let unverifiedId: string;

    beforeAll(async () => {
      customer = await signUp(t, "customer@acme.example", "Cus Tomer");
      const u = agent();
      await u.post("/v1/auth/register").send({ name: "Pending", email: "pending@acme.example", password: PASSWORD, marketingConsent: true, acceptTerms: true }).expect(201);
      unverifiedId = (await userBy("pending@acme.example")).id;
    });

    it("support: resend verification, notes, tags — and nothing more", async () => {
      const before = mails("pending@acme.example", "verify_email").length;
      await support.post(`/v1/admin/users/${unverifiedId}/resend-verification`).expect(200);
      expect(mails("pending@acme.example", "verify_email")).toHaveLength(before + 1);
      await support.post(`/v1/admin/users/${customer.userId}/resend-verification`).expect(409); // already confirmed
      await support.post(`/v1/admin/users/${admin.userId}/resend-verification`).expect(403); // higher rank

      const note = await support.post(`/v1/admin/users/${customer.userId}/notes`).send({ body: "Asked about annual billing" }).expect(201);
      expect(note.body.data).toMatchObject({ body: "Asked about annual billing", author: { email: "support@platform.test" } });
      const notes = await support.get(`/v1/admin/users/${customer.userId}/notes`).expect(200);
      expect(notes.body.data).toHaveLength(1);
      await support.post(`/v1/admin/users/${customer.userId}/notes`).send({ body: "  " }).expect(400);

      const tags = await support.put(`/v1/admin/users/${customer.userId}/tags`).send({ tags: ["VIP", "beta tester", "vip"] }).expect(200);
      expect(tags.body.data.tags).toEqual(["beta-tester", "vip"]);
      await support.put(`/v1/admin/users/${customer.userId}/tags`).send({ tags: ["no/slashes"] }).expect(400);

      await support.post(`/v1/admin/users/${unverifiedId}/verify-email`).expect(403);
      await support.post(`/v1/admin/users/${customer.userId}/password-reset`).expect(403);
      await support.put(`/v1/admin/users/${customer.userId}/email`).send({ email: "x@acme.example" }).expect(403);
      await support.get("/v1/admin/users/export.csv").expect(403);
      await support.get("/v1/admin/signup-invites").expect(403);
      await support.delete(`/v1/admin/users/${customer.userId}`).expect(403);
      await customer.get(`/v1/admin/users/${customer.userId}/notes`).expect(403);

      const actions = (await t.prisma.db.auditEvent.findMany({ where: { targetId: customer.userId, actorType: "platform_admin" } })).map((a) => a.action);
      expect(actions).toEqual(expect.arrayContaining(["platform.user_note_added", "platform.user_tags_updated"]));
    });

    it("admin: verify email, send a password reset; never on a higher rank", async () => {
      const verified = await admin.post(`/v1/admin/users/${unverifiedId}/verify-email`).expect(200);
      expect(verified.body.data.emailVerified).toBe(true);
      const before = mails("customer@acme.example", "reset_password").length;
      await admin.post(`/v1/admin/users/${customer.userId}/password-reset`).expect(200);
      expect(mails("customer@acme.example", "reset_password")).toHaveLength(before + 1);
      await admin.post(`/v1/admin/users/${owner.userId}/password-reset`).expect(403);
      await admin.post(`/v1/admin/users/${admin.userId}/verify-email`).expect(403); // own account
      await admin.delete(`/v1/admin/users/${customer.userId}`).expect(403); // owner only
      const audit = await t.prisma.db.auditEvent.findMany({ where: { action: { in: ["platform.user_email_verified", "platform.user_password_reset_sent"] } } });
      expect(audit).toHaveLength(2);
    });

    it("lists and filters with the profile fields", async () => {
      const all = await support.get("/v1/admin/users?q=acme.example").expect(200);
      const pending = all.body.data.items.find((u: { email: string }) => u.email === "pending@acme.example");
      expect(pending).toMatchObject({ signupSource: "password", marketingConsent: true, tags: [], utmSource: null, workspaceCount: 0 });
      const cust = all.body.data.items.find((u: { email: string }) => u.email === "customer@acme.example");
      expect(cust.tags).toEqual(["beta-tester", "vip"]);

      const byTag = await support.get("/v1/admin/users?tag=VIP").expect(200);
      expect(byTag.body.data.items.map((u: { email: string }) => u.email)).toEqual(["customer@acme.example"]);
      const consent = await support.get("/v1/admin/users?consent=true&q=acme").expect(200);
      expect(consent.body.data.items.map((u: { email: string }) => u.email)).toEqual(["pending@acme.example"]);
      const noConsent = await support.get("/v1/admin/users?consent=false&q=acme").expect(200);
      expect(noConsent.body.data.items.map((u: { email: string }) => u.email)).toEqual(["customer@acme.example"]);
      const invited = await support.get("/v1/admin/users?signupSource=invite").expect(200);
      expect(invited.body.data.items.map((u: { email: string }) => u.email)).toContain("invitee@example.com");
      const unverified = await support.get("/v1/admin/users?verified=false").expect(200);
      expect(unverified.body.data.items.every((u: { emailVerified: boolean }) => !u.emailVerified)).toBe(true);
      expect(unverified.body.data.total).toBeGreaterThan(0);
      const future = await support.get(`/v1/admin/users?lastLoginFrom=${new Date(Date.now() + 86_400_000).toISOString()}`).expect(200);
      expect(future.body.data.total).toBe(0);
      const recent = await support.get(`/v1/admin/users?lastLoginFrom=${new Date(Date.now() - 3_600_000).toISOString()}&q=customer@acme`).expect(200);
      expect(recent.body.data.total).toBe(1);

      await createWorkspace(customer, "Acme");
      const onStarter = await support.get("/v1/admin/users?plan=starter&q=acme").expect(200);
      expect(onStarter.body.data.items.map((u: { email: string }) => u.email)).toEqual(["customer@acme.example"]);
      expect((await support.get("/v1/admin/users?plan=agency&q=acme").expect(200)).body.data.total).toBe(0);
      // The original filters still work, paged as before.
      const staff = await support.get("/v1/admin/users?scope=staff&pageSize=2").expect(200);
      expect(staff.body.data).toMatchObject({ total: 3, page: 1, pageSize: 2 });
      expect(staff.body.data.items).toHaveLength(2);

      const detail = await support.get(`/v1/admin/users/${unverifiedId}`).expect(200);
      expect(detail.body.data.profile).toMatchObject({ signupSource: "password", marketingConsent: true, consentSource: "signup_form", anonymisedAt: null });
    });

    it("exports CSV, neutralising formulas", async () => {
      await t.prisma.db.user.update({ where: { id: unverifiedId }, data: { name: '=HYPERLINK("http://evil.example","x")' } });
      const res = await admin.get("/v1/admin/users/export.csv?q=acme.example").expect(200);
      expect(res.headers["content-type"]).toContain("text/csv");
      expect(res.headers["content-disposition"]).toContain("attachment");
      const lines = res.text.replace(/^﻿/, "").trim().split("\r\n");
      expect(lines[0]).toContain('"email"');
      expect(lines).toHaveLength(3);
      expect(res.text).toContain(`"'=HYPERLINK(""http://evil.example"",""x"")"`);
      expect(res.text).not.toMatch(/(^|,)"=/m);
      const tagged = await admin.get("/v1/admin/users/export.csv?tag=vip").expect(200);
      expect(tagged.text.trim().split("\r\n")).toHaveLength(2);
      expect(csvCell("+1 555")).toBe(`"'+1 555"`);
      expect(csvCell("-2")).toBe(`"'-2"`);
      expect(csvCell("@cmd")).toBe(`"'@cmd"`);
      expect(csvCell("plain")).toBe(`"plain"`);
      const audit = await t.prisma.db.auditEvent.findFirst({ where: { action: "platform.users_exported" }, orderBy: { createdAt: "desc" } });
      expect(audit?.metadata).toMatchObject({ rows: 1, filters: { tag: "vip" } });
    });

    it("changes a person's email: unique, old address told, re-verify, signed out", async () => {
      const victim = await signUp(t, "move@old.example", "Mover");
      await admin.put(`/v1/admin/users/${victim.userId}/email`).send({ email: "customer@acme.example" }).expect(409);
      await admin.put(`/v1/admin/users/${victim.userId}/email`).send({ email: "move@old.example" }).expect(400);
      const res = await admin.put(`/v1/admin/users/${victim.userId}/email`).send({ email: "Move@New.example" }).expect(200);
      expect(res.body.data).toMatchObject({ email: "move@new.example", emailVerified: false });
      const told = mails("move@old.example", "email_changed").at(-1);
      expect(`${told?.text ?? ""}${told?.html ?? ""}`).toContain("move@new.example");
      expect(mails("move@new.example", "verify_email")).toHaveLength(1);
      await victim.get("/v1/auth/me").expect(401);
      const audit = await t.prisma.db.auditEvent.findFirst({ where: { action: "platform.user_email_changed", targetId: victim.userId } });
      expect(audit?.metadata).toMatchObject({ from: "move@old.example", to: "move@new.example" });
      await admin.put(`/v1/admin/users/${owner.userId}/email`).send({ email: "boss@new.example" }).expect(403);
    });
  });

  describe("delete (anonymise)", () => {
    it("is refused for yourself, equal rank, live subscriptions and shared workspaces", async () => {
      await owner.delete(`/v1/admin/users/${owner.userId}`).expect(403);
      const coOwner = await signUp(t, "coowner@platform.test", "Co Owner");
      await setRole(coOwner.userId, "owner");
      await owner.delete(`/v1/admin/users/${coOwner.userId}`).expect(403);

      const payer = await signUp(t, "payer@paid.example", "Payer");
      const w = await createWorkspace(payer, "Paid Co");
      const ws = await t.prisma.db.workspace.findUniqueOrThrow({ where: { id: w } });
      await t.prisma.db.subscription.update({ where: { billingAccountId: ws.billingAccountId }, data: { provider: "stripe", status: "active" } });
      const live = await owner.delete(`/v1/admin/users/${payer.userId}`).expect(409);
      expect(live.body.error.message).toContain("live stripe subscription");

      const lead = await signUp(t, "lead@shared.example", "Lead");
      const sw = await createWorkspace(lead, "Shared Co");
      await lead.post(`/v1/workspaces/${sw}/invitations`).send({ email: "peer@shared.example", role: "member" }).expect(201);
      const token = mails("peer@shared.example", "invitation").at(-1)?.text.match(/invite\/([A-Za-z0-9_%-]+)/)?.[1];
      await agent().post(`/v1/invitations/${token}/register`).send({ name: "Peer", password: PASSWORD, acceptTerms: true }).expect(201);
      const shared = await owner.delete(`/v1/admin/users/${lead.userId}`).expect(409);
      expect(shared.body.error.message).toContain("Shared Co");
      expect(shared.body.error.details).toEqual({ workspaceId: sw });
    });

    it("erases the person and everything that would let the account work again", async () => {
      const gone = await signUp(t, "gone@solo.example", "Gone Person");
      const w = await createWorkspace(gone, "Solo Co");
      await t.prisma.db.platformUserProfile.upsert({
        where: { userId: gone.userId },
        create: { userId: gone.userId, tags: ["x"], marketingConsent: true },
        update: { tags: ["x"], marketingConsent: true, utm: { utm_source: "ads" } },
      });
      await owner.post(`/v1/admin/users/${gone.userId}/notes`).send({ body: "private note" }).expect(201);
      const key = await t.prisma.db.apiKey.create({
        data: { workspaceId: w, name: "Zapier", prefix: "gd_abc", keyHash: hashToken("gd_secret_value_for_test"), scopes: ["leads:write"], createdById: gone.userId },
      });
      expect(await t.prisma.db.emailLog.count({ where: { to: "gone@solo.example" } })).toBeGreaterThan(0);

      const res = await owner.delete(`/v1/admin/users/${gone.userId}`).expect(200);
      expect(res.body.data).toEqual({ anonymised: true, apiKeysRevoked: 1, workspacesSuspended: 1 });

      expect(mails("gone@solo.example", "account_deleted")).toHaveLength(1);
      const user = await t.prisma.db.user.findUniqueOrThrow({ where: { id: gone.userId } });
      expect(user).toMatchObject({ email: `deleted+${gone.userId}@invalid`, name: "", passwordHash: null, googleSub: null, avatarUrl: "" });
      expect(user.suspendedAt).not.toBeNull();
      await gone.get("/v1/auth/me").expect(401);
      await agent().post("/v1/auth/login").send({ email: "gone@solo.example", password: PASSWORD }).expect(401);
      expect(await t.prisma.db.session.count({ where: { userId: gone.userId, revokedAt: null } })).toBe(0);
      expect(await t.prisma.db.authToken.count({ where: { userId: gone.userId } })).toBe(0);
      expect((await t.prisma.db.apiKey.findUniqueOrThrow({ where: { id: key.id } })).revokedAt).not.toBeNull();
      expect(await t.prisma.db.emailLog.count({ where: { to: "gone@solo.example" } })).toBe(0);
      expect(await t.prisma.db.platformUserNote.count({ where: { userId: gone.userId } })).toBe(0);
      const profile = await profileOf(gone.userId);
      expect(profile).toMatchObject({ tags: [], marketingConsent: false, utm: {} });
      expect(profile?.anonymisedAt).not.toBeNull();
      expect((await t.prisma.db.workspace.findUniqueOrThrow({ where: { id: w } })).status).toBe("suspended");

      const audit = await t.prisma.db.auditEvent.findFirst({ where: { action: "platform.user_anonymised", targetId: gone.userId } });
      expect(audit).toMatchObject({ actorType: "platform_admin", actorUserId: owner.userId });
      expect(JSON.stringify(audit?.metadata)).not.toContain("gone@solo.example");

      await owner.delete(`/v1/admin/users/${gone.userId}`).expect(409);
      await owner.post(`/v1/admin/users/${gone.userId}/password-reset`).expect(409);
      const detail = await owner.get(`/v1/admin/users/${gone.userId}`).expect(200);
      expect(detail.body.data.anonymisedAt).not.toBeNull();
      // The address is free again.
      await register({ email: "gone@solo.example" }).expect(201);
    });
  });
});
