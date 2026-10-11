import http from "node:http";
import type { AddressInfo } from "node:net";
import { vi } from "vitest";
import { bootApp, signUp, wait, type Agent, type TestApp } from "./helpers.js";
import { PlatformMailProcessorsModule } from "../src/platform-mail/platform-mail.processors.js";
import { PlatformGrowthProcessorsModule } from "../src/platform-growth/platform-growth.processors.js";
import { PlatformMailRateLimiter } from "../src/platform-mail/rate-limiter.js";
import { BroadcastRunner } from "../src/platform-growth/broadcast-runner.service.js";
import { DripRunner } from "../src/platform-growth/drip-runner.service.js";
import { Queues, QUEUES } from "../src/queues/queues.js";

/*
 * Platform growth (marketing to our own users) against a local fake of the
 * Resend API: the audience rule (consent, unsubscribe, suppression,
 * verification, anonymisation, suspension), broadcast snapshot + batches
 * (idempotent, through the shared limiter), cancel, the RFC 8058 unsubscribe
 * (GET never changes anything; POST is idempotent; transactional mail still
 * goes out), the account toggle, drips (post-activation triggers only,
 * idempotent) and the platform rank gates.
 *
 * TEST_DB_NAME=gd_test_growth TEST_REDIS_DB=14 pnpm --filter @growthdesk/api test:e2e test/platform-growth.e2e-spec.ts
 */

type Reply = { status: number; body?: unknown; headers?: Record<string, string> };
type Seen = { method: string; url: string; headers: http.IncomingHttpHeaders; body: unknown };
type BatchMail = { to: string[]; subject: string; html: string; text: string; headers?: Record<string, string>; tags?: { name: string; value: string }[] };

const API_KEY = "re_growth_e2e_key";

async function until<T>(read: () => Promise<T>, done: (v: T) => boolean, timeoutMs = 30_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await read();
    if (done(v)) return v;
    if (Date.now() > end) throw new Error(`timed out; last value: ${JSON.stringify(v)}`);
    await wait(100);
  }
}

describe("Platform growth", () => {
  let t: TestApp;
  let admin: Agent;
  let support: Agent;
  let customer: Agent;
  let server: http.Server;
  const seen: Seen[] = [];
  const replies: Reply[] = [];
  let seq = 0;

  const batches = () => seen.filter((s) => s.method === "POST" && s.url === "/emails/batch");
  const singles = () => seen.filter((s) => s.method === "POST" && s.url === "/emails");
  const queue = () => t.app.get(Queues).queue(QUEUES.platformMarketing);
  const runner = () => t.app.get(BroadcastRunner);
  const drips = () => t.app.get(DripRunner);

  /** A user straight into the database, with a profile as the options say. */
  async function makeUser(
    email: string,
    o: { consent?: boolean; verified?: boolean; unsubscribed?: boolean; suppressed?: boolean; anonymised?: boolean; suspended?: boolean; profile?: boolean; tags?: string[]; source?: string; name?: string } = {},
  ) {
    const user = await t.prisma.db.user.create({
      data: {
        email,
        name: o.name ?? email.split("@")[0]!,
        emailVerifiedAt: o.verified === false ? null : new Date(),
        suspendedAt: o.suspended ? new Date() : null,
      },
    });
    if (o.profile !== false) {
      await t.prisma.db.platformUserProfile.create({
        data: {
          userId: user.id,
          marketingConsent: o.consent ?? true,
          consentAt: new Date(),
          consentSource: "signup_form",
          unsubscribedAt: o.unsubscribed ? new Date() : null,
          suppressedAt: o.suppressed ? new Date() : null,
          anonymisedAt: o.anonymised ? new Date() : null,
          tags: o.tags ?? [],
          signupSource: o.source ?? "password",
        },
      });
    }
    return user;
  }

  /** Builds an audience over a tag and returns its id. */
  async function audienceFor(tag: string, name = `Tag ${tag}`) {
    const res = await admin.post("/v1/admin/growth/audiences").send({ name, filter: { tagsAny: [tag] } }).expect(201);
    return res.body.data.id as string;
  }

  async function draftBroadcast(audienceId: string, name: string) {
    const res = await admin
      .post("/v1/admin/growth/broadcasts")
      .send({
        name,
        audienceId,
        subject: "News for {{name|you}} from {{product_name}}",
        preheader: "Short and sweet",
        blocks: [
          { type: "heading", id: "h", text: "Hello {{name|there}}", level: 1, align: "left" },
          { type: "text", id: "t", text: "Something new. Not for you? [Unsubscribe]({{unsubscribe_url}})", align: "left" },
        ],
      })
      .expect(201);
    return res.body.data.id as string;
  }

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c: Buffer) => (raw += c.toString("utf8")));
      req.on("end", () => {
        let body: unknown = null;
        try {
          body = raw ? JSON.parse(raw) : null;
        } catch {
          body = raw;
        }
        seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
        res.setHeader("content-type", "application/json");
        const reply = replies.shift();
        if (reply) {
          res.writeHead(reply.status, reply.headers ?? {});
          return res.end(JSON.stringify(reply.body ?? {}));
        }
        if (req.method === "POST" && req.url === "/emails") return res.end(JSON.stringify({ id: `re_one_${++seq}` }));
        if (req.method === "POST" && req.url === "/emails/batch") return res.end(JSON.stringify({ data: (body as unknown[]).map(() => ({ id: `re_batch_${++seq}` })) }));
        res.writeHead(404);
        res.end(JSON.stringify({ statusCode: 404, name: "not_found", message: "Not found" }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    process.env.RESEND_API_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    t = await bootApp([PlatformMailProcessorsModule, PlatformGrowthProcessorsModule]);
    admin = await signUp(t, "admin@growth.test", "Ada Admin");
    support = await signUp(t, "support@growth.test", "Sam Support");
    customer = await signUp(t, "customer@growth.test", "Cus Tomer");
    await t.prisma.db.user.update({ where: { id: admin.userId }, data: { platformRole: "admin" } });
    await t.prisma.db.user.update({ where: { id: support.userId }, data: { platformRole: "support" } });
    await admin.patch("/v1/admin/email/settings").send({ mailProvider: "resend", resendApiKey: API_KEY, replyTo: "help@growth.test", resendRateLimitPerSec: 50 }).expect(200);
  });

  afterAll(async () => {
    delete process.env.RESEND_API_URL;
    vi.restoreAllMocks();
    await t.close();
    await new Promise((r) => server.close(r));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    t.mail.deliveryMode = "outbox";
  });

  describe("ranks", () => {
    it("customers get 403 and anonymous callers 401 on every admin growth route", async () => {
      await customer.get("/v1/admin/growth/audiences").expect(403);
      await customer.get("/v1/admin/growth/broadcasts").expect(403);
      await customer.get("/v1/admin/growth/sequences").expect(403);
      await customer.get("/v1/admin/growth/subscribers").expect(403);
      await customer.post("/v1/admin/growth/audiences/preview").send({ filter: {} }).expect(403);
      await t.http().get("/v1/admin/growth/broadcasts").expect(401);
    });

    it("support reads and previews but cannot change or send", async () => {
      await support.get("/v1/admin/growth/audiences").expect(200);
      await support.post("/v1/admin/growth/audiences/preview").send({ filter: {} }).expect(200);
      await support.post("/v1/admin/growth/preview").send({ subject: "Hi", blocks: [{ type: "text", id: "t", text: "x" }] }).expect(200);
      await support.get("/v1/admin/growth/broadcasts").expect(200);
      await support.get("/v1/admin/growth/sequences").expect(200);
      await support.get("/v1/admin/growth/subscribers?tab=suppressed").expect(200);
      await support.post("/v1/admin/growth/audiences").send({ name: "x", filter: {} }).expect(403);
      await support.post("/v1/admin/growth/broadcasts").send({ name: "x" }).expect(403);
      await support.post("/v1/admin/growth/sequences").send({ name: "x", trigger: "signup" }).expect(403);
      const id = "00000000-0000-4000-8000-000000000000";
      await support.post(`/v1/admin/growth/broadcasts/${id}/schedule`).send({ now: true }).expect(403);
      await support.post(`/v1/admin/growth/broadcasts/${id}/test`).expect(403);
      await support.post(`/v1/admin/growth/broadcasts/${id}/cancel`).expect(403);
      await support.post(`/v1/admin/growth/sequences/${id}/activate`).expect(403);
      await support.post(`/v1/admin/growth/subscribers/${customer.userId}/suppress`).expect(403);
    });
  });

  describe("audiences", () => {
    it("always excludes non-consenting, unsubscribed, suppressed, unverified, anonymised and suspended users", async () => {
      const tags = ["aud"];
      const ok = await makeUser("ok@aud.test", { tags });
      await makeUser("noconsent@aud.test", { tags, consent: false });
      await makeUser("unsub@aud.test", { tags, unsubscribed: true });
      await makeUser("suppressed@aud.test", { tags, suppressed: true });
      await makeUser("unverified@aud.test", { tags, verified: false });
      await makeUser("anon@aud.test", { tags, anonymised: true });
      await makeUser("suspended@aud.test", { tags, suspended: true });
      await makeUser("noprofile@aud.test", { profile: false });
      const google = await makeUser("google@aud.test", { tags: ["aud", "vip"], source: "google" });

      const all = (await admin.post("/v1/admin/growth/audiences/preview").send({ filter: { tagsAny: ["aud"] } }).expect(200)).body.data;
      expect(all.count).toBe(2);
      expect(all.samples.map((s: { email: string }) => s.email).sort()).toEqual(["google@aud.test", "ok@aud.test"]);

      // An empty filter is still the marketing rule: none of the excluded people, nor staff who never opted in.
      const everyone = (await admin.post("/v1/admin/growth/audiences/preview").send({ filter: {} }).expect(200)).body.data;
      const emails = everyone.samples.map((s: { email: string }) => s.email);
      for (const bad of ["noconsent", "unsub", "suppressed", "unverified", "anon", "suspended", "noprofile"]) expect(emails).not.toContain(`${bad}@aud.test`);
      expect(emails).not.toContain("admin@growth.test");

      const vip = (await admin.post("/v1/admin/growth/audiences/preview").send({ filter: { tagsAny: ["aud"], signupSources: ["google"] } }).expect(200)).body.data;
      expect(vip.samples.map((s: { id: string }) => s.id)).toEqual([google.id]);
      const withWs = (await admin.post("/v1/admin/growth/audiences/preview").send({ filter: { tagsAny: ["aud"], workspacesMin: 1 } }).expect(200)).body.data;
      expect(withWs.count).toBe(0);
      const recent = (await admin.post("/v1/admin/growth/audiences/preview").send({ filter: { tagsAny: ["aud"], signedUpAfter: new Date(Date.now() + 60_000).toISOString() } }).expect(200)).body.data;
      expect(recent.count).toBe(0);
      expect(ok.id).toBeTruthy();

      await admin.post("/v1/admin/growth/audiences/preview").send({ filter: { workspacesMin: 3, workspacesMax: 1 } }).expect(400);
    });

    it("saves audiences with a live count and audits them", async () => {
      const id = await audienceFor("aud", "Aud people");
      const list = (await support.get("/v1/admin/growth/audiences").expect(200)).body.data;
      expect(list.find((a: { id: string }) => a.id === id)).toMatchObject({ name: "Aud people", count: 2, filter: { tagsAny: ["aud"] } });
      await admin.patch(`/v1/admin/growth/audiences/${id}`).send({ name: "Renamed" }).expect(200);
      expect(await t.prisma.db.auditEvent.count({ where: { action: { startsWith: "platform.growth_audience_" }, targetId: id } })).toBe(2);
      await admin.delete(`/v1/admin/growth/audiences/${id}`).expect(200);
    });
  });

  describe("broadcasts", () => {
    const BULK = 205;
    let bulkAudience: string;

    beforeAll(async () => {
      const rows = Array.from({ length: BULK }, (_, i) => ({ email: `bulk-${String(i).padStart(3, "0")}@growth.test`, name: `Bulk ${i}`, emailVerifiedAt: new Date() }));
      await t.prisma.db.user.createMany({ data: rows });
      const users = await t.prisma.db.user.findMany({ where: { email: { startsWith: "bulk-" } }, select: { id: true } });
      await t.prisma.db.platformUserProfile.createMany({ data: users.map((u) => ({ userId: u.id, marketingConsent: true, consentAt: new Date(), tags: ["bulk"] })) });
      bulkAudience = await audienceFor("bulk");
    });

    it("drafts validate on schedule; a test goes to the caller only, with [Test]", async () => {
      const id = await draftBroadcast(bulkAudience, "Bad content");
      await admin.patch(`/v1/admin/growth/broadcasts/${id}`).send({ subject: "Hi {{first_name}}" }).expect(200);
      const refused = await admin.post(`/v1/admin/growth/broadcasts/${id}/schedule`).send({ now: true }).expect(400);
      expect(refused.body.error.message).toMatch(/Unknown variable: \{\{first_name\}\}/);
      await admin.post(`/v1/admin/growth/broadcasts/${id}/schedule`).send({ at: new Date(Date.now() + 5_000).toISOString() }).expect(400);

      await admin.patch(`/v1/admin/growth/broadcasts/${id}`).send({ subject: "Hello {{name}}" }).expect(200);
      const before = singles().length;
      const res = (await admin.post(`/v1/admin/growth/broadcasts/${id}/test`).expect(200)).body.data;
      expect(res).toMatchObject({ ok: true, provider: "resend", to: "admin@growth.test" });
      const req = singles().slice(before);
      expect(req).toHaveLength(1);
      expect(req[0]!.body).toMatchObject({ to: ["admin@growth.test"], subject: "[Test] Hello Ada Admin" });
      // Test sends are not broadcast sends.
      expect(await t.prisma.db.emailLog.count({ where: { broadcastId: id } })).toBe(0);
      await admin.delete(`/v1/admin/growth/broadcasts/${id}`).expect(200);
    });

    it("snapshots once, sends 100 per Resend batch through the shared limiter, and is idempotent", async () => {
      const limiter = t.app.get(PlatformMailRateLimiter);
      const acquire = vi.spyOn(limiter, "acquire");
      const block = vi.spyOn(limiter, "block");
      const id = await draftBroadcast(bulkAudience, "Launch");
      const before = batches().length;
      // The first batch call is rate limited: the bucket pauses for everyone, then the same batch is retried.
      replies.push({ status: 429, body: { name: "rate_limit_exceeded", message: "Too many requests" }, headers: { "retry-after": "1" } });

      const scheduled = (await admin.post(`/v1/admin/growth/broadcasts/${id}/schedule`).send({ now: true }).expect(200)).body.data;
      expect(scheduled.status).toMatch(/scheduled|sending/);
      const done = await until(
        () => t.prisma.db.platformBroadcast.findUniqueOrThrow({ where: { id } }),
        (b) => b.status === "sent",
      );
      expect(done.totals).toMatchObject({ recipients: BULK, sent: BULK, failed: 0, skipped: 0 });

      const calls = batches().slice(before);
      expect(calls).toHaveLength(4);
      expect(block).toHaveBeenCalledWith("resend", 1000);
      expect(acquire.mock.calls.filter((c) => c[0] === "resend").length).toBeGreaterThanOrEqual(4);
      const sizes = calls.slice(1).map((c) => (c.body as unknown[]).length).sort((a, b) => b - a);
      expect(sizes).toEqual([100, 100, 5]);
      const keys = calls.map((c) => c.headers["idempotency-key"]);
      expect(new Set(keys)).toEqual(new Set([`${id}:0`, `${id}:1`, `${id}:2`]));
      expect(calls[0]!.body).toEqual(calls.find((c, i) => i > 0 && c.headers["idempotency-key"] === keys[0])!.body);

      const mail = (calls[1]!.body as BatchMail[])[0]!;
      expect(mail.headers!["List-Unsubscribe"]).toMatch(/^<http:\/\/localhost:3600\/api\/platform-mail\/u\/p\.[^>]+>, <mailto:help@growth\.test\?subject=unsubscribe>$/);
      expect(mail.headers!["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
      expect(mail.html).toContain("http://localhost:3600/email-preferences/p.");
      expect(mail.text).toMatch(/Unsubscribe or manage preferences: http:\/\/localhost:3600\/email-preferences\/p\./);
      expect(mail.subject).toMatch(/^News for Bulk \d+ from Growthdesk$/);
      expect(mail.tags).toEqual(expect.arrayContaining([{ name: "stream", value: "marketing" }, { name: "broadcast_id", value: id }]));

      expect(await t.prisma.db.emailLog.count({ where: { broadcastId: id, status: "sent", stream: "marketing", provider: "resend" } })).toBe(BULK);
      expect(await t.prisma.db.platformBroadcastRecipient.count({ where: { broadcastId: id, status: "sent" } })).toBe(BULK);

      // Replays change nothing: no new recipients, logs or provider calls.
      await runner().start(id);
      await runner().batch(id, 0, false);
      await runner().sweep();
      await wait(300);
      expect(batches().length - before).toBe(4);
      expect(await t.prisma.db.emailLog.count({ where: { broadcastId: id } })).toBe(BULK);
      expect(await t.prisma.db.platformBroadcastRecipient.count({ where: { broadcastId: id } })).toBe(BULK);

      const stats = (await support.get(`/v1/admin/growth/broadcasts/${id}/stats`).expect(200)).body.data;
      expect(stats).toMatchObject({ recipients: { total: BULK, sent: BULK }, email: { total: BULK, sent: BULK, failed: 0 }, unsubscribes: 0 });
      await admin.patch(`/v1/admin/growth/broadcasts/${id}`).send({ name: "x" }).expect(409);
    });

    it("re-checks consent at send time and cancel stops whoever is left", async () => {
      const id = await draftBroadcast(bulkAudience, "Cancel me");
      await queue().pause();
      try {
        await admin.post(`/v1/admin/growth/broadcasts/${id}/schedule`).send({ now: true }).expect(200);
        await runner().start(id);
        expect(await t.prisma.db.platformBroadcastRecipient.count({ where: { broadcastId: id } })).toBe(BULK);
        // Someone in the first batch withdraws consent after the snapshot.
        const first = await t.prisma.db.platformBroadcastRecipient.findFirstOrThrow({ where: { broadcastId: id }, orderBy: { userId: "asc" } });
        await t.prisma.db.platformUserProfile.update({ where: { userId: first.userId }, data: { marketingConsent: false } });
        const before = batches().length;
        const r = await runner().batch(id, 0, false);
        expect(r).toMatchObject({ sent: 99, skipped: 1 });
        expect((batches().at(-1)!.body as unknown[]).length).toBe(99);
        expect(await t.prisma.db.platformBroadcastRecipient.findUniqueOrThrow({ where: { broadcastId_userId: { broadcastId: id, userId: first.userId } } })).toMatchObject({ status: "skipped", emailLogId: null });

        const canceled = (await admin.post(`/v1/admin/growth/broadcasts/${id}/cancel`).expect(200)).body.data;
        expect(canceled.status).toBe("canceled");
        expect(canceled.progress).toMatchObject({ sent: 99, skipped: 1, canceled: BULK - 100, pending: 0 });
        await queue().resume();
        await wait(1500);
        await runner().batch(id, 1, false);
        expect(batches().length - before).toBe(1);
        expect(await t.prisma.db.emailLog.count({ where: { broadcastId: id } })).toBe(99);
        expect((await t.prisma.db.platformBroadcast.findUniqueOrThrow({ where: { id } })).status).toBe("canceled");
        await admin.post(`/v1/admin/growth/broadcasts/${id}/cancel`).expect(409);
      } finally {
        await queue().resume();
        await t.prisma.db.platformUserProfile.updateMany({ where: { tags: { has: "bulk" } }, data: { marketingConsent: true } });
      }
    });

    it("a scheduled broadcast can be pulled back to draft before it starts", async () => {
      const id = await draftBroadcast(bulkAudience, "Later");
      const at = new Date(Date.now() + 3_600_000).toISOString();
      const s = (await admin.post(`/v1/admin/growth/broadcasts/${id}/schedule`).send({ at }).expect(200)).body.data;
      expect(s).toMatchObject({ status: "scheduled", audience: { count: BULK } });
      expect(await queue().getJob(`pb-start-${id}-${new Date(at).getTime()}`)).toBeTruthy();
      const back = (await admin.post(`/v1/admin/growth/broadcasts/${id}/cancel`).expect(200)).body.data;
      expect(back).toMatchObject({ status: "draft", scheduledAt: null });
      expect(await queue().getJob(`pb-start-${id}-${new Date(at).getTime()}`)).toBeFalsy();
      // A stale start does nothing to a draft.
      expect(await runner().start(id)).toEqual({ status: "draft" });
    });

    it("refuses an audience nobody in it may receive", async () => {
      const empty = await audienceFor("nobody-has-this");
      const id = await draftBroadcast(empty, "Empty");
      const res = await admin.post(`/v1/admin/growth/broadcasts/${id}/schedule`).send({ now: true }).expect(409);
      expect(res.body.error.message).toMatch(/Nobody in this audience/);
    });
  });

  describe("unsubscribe", () => {
    let token: string;
    let userId: string;
    let broadcastId: string;

    beforeAll(async () => {
      const log = await t.prisma.db.emailLog.findFirstOrThrow({ where: { template: "broadcast", status: "sent" }, orderBy: { createdAt: "asc" } });
      const call = batches().find((c) => (c.body as BatchMail[]).some((m) => m.tags?.some((tg) => tg.name === "log_id" && tg.value === log.id)))!;
      const mail = (call.body as BatchMail[]).find((m) => m.tags?.some((tg) => tg.name === "log_id" && tg.value === log.id))!;
      token = mail.html.match(/email-preferences\/(p\.[A-Za-z0-9_.-]+)/)![1]!;
      userId = log.userId!;
      broadcastId = log.broadcastId!;
    });

    it("GET shows who and what and never unsubscribes", async () => {
      const details = (await t.http().get(`/v1/platform-mail/u/${token}/details`).expect(200)).body.data;
      expect(details).toMatchObject({ subscribed: true, suppressed: false, productName: "Growthdesk" });
      expect(details.email).toMatch(/^bulk-\d+@growth\.test$/);
      const redirect = await t.http().get(`/v1/platform-mail/u/${token}`).expect(302);
      expect(redirect.headers.location).toBe(`/email-preferences/${encodeURIComponent(token)}`);
      const p = await t.prisma.db.platformUserProfile.findUniqueOrThrow({ where: { userId } });
      expect(p).toMatchObject({ marketingConsent: true, unsubscribedAt: null });
      await t.http().get(`/v1/platform-mail/u/${token.slice(0, -2)}xx/details`).expect(404);
    });

    it("RFC 8058 one-click POST unsubscribes, stops drips, is attributed and idempotent", async () => {
      const seqRow = await t.prisma.db.platformDripSequence.create({ data: { name: "tmp", trigger: "signup", active: false } });
      await t.prisma.db.platformDripEnrollment.create({ data: { sequenceId: seqRow.id, userId, nextRunAt: new Date() } });

      const first = (await t.http().post(`/v1/platform-mail/u/${token}`).type("form").send("List-Unsubscribe=One-Click").expect(200)).body.data;
      expect(first).toMatchObject({ subscribed: false, changed: true });
      const p1 = await t.prisma.db.platformUserProfile.findUniqueOrThrow({ where: { userId } });
      expect(p1).toMatchObject({ marketingConsent: false, consentSource: "preference_page" });
      expect(p1.unsubscribedAt).not.toBeNull();
      expect(await t.prisma.db.platformDripEnrollment.findFirstOrThrow({ where: { userId, sequenceId: seqRow.id } })).toMatchObject({ status: "stopped" });

      const again = (await t.http().post(`/v1/platform-mail/u/${token}`).send({ via: "page" }).expect(200)).body.data;
      expect(again).toMatchObject({ subscribed: false, changed: false });
      const p2 = await t.prisma.db.platformUserProfile.findUniqueOrThrow({ where: { userId } });
      expect(p2.unsubscribedAt).toEqual(p1.unsubscribedAt);
      expect((await support.get(`/v1/admin/growth/broadcasts/${broadcastId}/stats`).expect(200)).body.data.unsubscribes).toBe(1);

      // Out of every audience now.
      const preview = (await admin.post("/v1/admin/growth/audiences/preview").send({ filter: { tagsAny: ["bulk"] } }).expect(200)).body.data;
      expect(preview.count).toBe(204);
      await t.prisma.db.platformDripSequence.delete({ where: { id: seqRow.id } });
    });

    it("transactional mail still reaches an unsubscribed user", async () => {
      const user = await t.prisma.db.user.findUniqueOrThrow({ where: { id: userId } });
      t.mail.deliveryMode = "queue";
      expect(await t.mail.notification(user.email, "Your export is ready", "Download it from the app.", "/")).toBe(true);
      const row = await until(
        () => t.prisma.db.emailLog.findFirstOrThrow({ where: { to: user.email, template: "notification" } }),
        (r) => r.status !== "queued",
      );
      expect(row).toMatchObject({ status: "sent", stream: "transactional", provider: "resend" });
    });

    it("the page can subscribe again; the account toggle uses account_settings", async () => {
      const back = (await t.http().post(`/v1/platform-mail/u/${token}/resubscribe`).expect(200)).body.data;
      expect(back).toMatchObject({ subscribed: true, changed: true });
      expect(await t.prisma.db.platformUserProfile.findUniqueOrThrow({ where: { userId } })).toMatchObject({ marketingConsent: true, unsubscribedAt: null, consentSource: "preference_page" });

      expect((await customer.get("/v1/auth/me/email-preferences").expect(200)).body.data).toMatchObject({ marketingConsent: false });
      const on = (await customer.put("/v1/auth/me/email-preferences").send({ marketingConsent: true }).expect(200)).body.data;
      expect(on.marketingConsent).toBe(true);
      expect(await t.prisma.db.platformUserProfile.findUniqueOrThrow({ where: { userId: customer.userId } })).toMatchObject({ marketingConsent: true, consentSource: "account_settings", unsubscribedAt: null });
      const off = (await customer.put("/v1/auth/me/email-preferences").send({ marketingConsent: false }).expect(200)).body.data;
      expect(off.marketingConsent).toBe(false);
      expect((await t.prisma.db.platformUserProfile.findUniqueOrThrow({ where: { userId: customer.userId } })).unsubscribedAt).not.toBeNull();
      await t.http().get("/v1/auth/me/email-preferences").expect(401);
    });
  });

  describe("drips", () => {
    it("enrolls only triggers after activation, sends each step once, and keeps the watermark on rename", async () => {
      const before = await makeUser("drip-before@growth.test", { tags: ["drip"] });
      await wait(20);
      const created = (await admin.post("/v1/admin/growth/sequences").send({ name: "Welcome", trigger: "signup" }).expect(201)).body.data;
      const id = created.id as string;
      const stepId = created.steps[0].id as string;
      await admin.patch(`/v1/admin/growth/sequences/${id}/steps/${stepId}`).send({ subject: "Welcome, {{name|friend}}" }).expect(200);
      await admin.post(`/v1/admin/growth/sequences/${id}/steps`).send({ delayHours: 24, subject: "Day two", blocks: [{ type: "text", id: "t", text: "Tip of the day" }] }).expect(201);
      const active = (await admin.post(`/v1/admin/growth/sequences/${id}/activate`).expect(200)).body.data;
      expect(active.active).toBe(true);
      const activatedAt = active.activatedAt as string;
      await wait(20);
      const after = await makeUser("drip-after@growth.test", { tags: ["drip"], name: "Dana" });
      await makeUser("drip-noconsent@growth.test", { consent: false });

      // A live step must stay sendable.
      await admin.patch(`/v1/admin/growth/sequences/${id}/steps/${stepId}`).send({ subject: "" }).expect(400);
      const renamed = (await admin.patch(`/v1/admin/growth/sequences/${id}`).send({ name: "Welcome series" }).expect(200)).body.data;
      expect(renamed.activatedAt).toBe(activatedAt);
      await admin.patch(`/v1/admin/growth/sequences/${id}`).send({ trigger: "verified" }).expect(409);

      const first = await Promise.all([drips().sweep(), drips().sweep()]);
      expect(first.reduce((n, r) => n + r.enrolled, 0)).toBe(1);
      expect(first.reduce((n, r) => n + r.sent, 0)).toBe(1);
      const enrollments = await t.prisma.db.platformDripEnrollment.findMany({ where: { sequenceId: id } });
      expect(enrollments.map((e) => e.userId)).toEqual([after.id]);
      expect(enrollments[0]).toMatchObject({ nextStepPosition: 2, status: "active" });
      expect(before.id).not.toBe(after.id);

      const log = await until(
        () => t.prisma.db.emailLog.findFirstOrThrow({ where: { userId: after.id, template: "drip" } }),
        (r) => r.status !== "queued",
      );
      expect(log).toMatchObject({ status: "sent", stream: "marketing", subject: "Welcome, Dana", dripStepId: stepId });
      const req = singles().find((s) => (s.body as { to: string[] }).to[0] === "drip-after@growth.test")!;
      expect((req.body as { headers: Record<string, string> }).headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");

      // Nothing else is due until a day later.
      expect(await drips().sweep()).toMatchObject({ enrolled: 0, sent: 0 });
      const later = new Date(Date.now() + 25 * 3_600_000);
      expect(await drips().sweep(later)).toMatchObject({ enrolled: 0, sent: 1 });
      expect(await drips().sweep(later)).toMatchObject({ sent: 0 });
      expect(await t.prisma.db.platformDripEnrollment.findFirstOrThrow({ where: { sequenceId: id } })).toMatchObject({ status: "completed", nextRunAt: null });
      expect(await t.prisma.db.emailLog.count({ where: { userId: after.id, template: "drip" } })).toBe(2);

      const stats = (await support.get(`/v1/admin/growth/sequences/${id}/stats`).expect(200)).body.data;
      expect(stats.steps.map((s: { email: { total: number } }) => s.email.total)).toEqual([1, 1]);

      await admin.delete(`/v1/admin/growth/sequences/${id}`).expect(409);
      await admin.post(`/v1/admin/growth/sequences/${id}/deactivate`).expect(200);
      await admin.delete(`/v1/admin/growth/sequences/${id}`).expect(200);
    });

    it("stops an enrollment whose person no longer passes the marketing rule", async () => {
      const created = (await admin.post("/v1/admin/growth/sequences").send({ name: "Verified", trigger: "verified" }).expect(201)).body.data;
      await admin.post(`/v1/admin/growth/sequences/${created.id}/activate`).expect(200);
      await wait(20);
      const u = await makeUser("drip-revoked@growth.test");
      await t.prisma.db.platformDripStep.update({ where: { id: created.steps[0].id }, data: { delayHours: 2 } });
      // Enrolled with step 1 due in 2 hours…
      expect((await drips().sweep()).enrolled).toBe(1);
      await t.prisma.db.platformUserProfile.update({ where: { userId: u.id }, data: { suppressedAt: new Date() } });
      // …and stopped instead of sent once it is due.
      expect(await drips().sweep(new Date(Date.now() + 3 * 3_600_000))).toMatchObject({ sent: 0, stopped: 1 });
      expect(await t.prisma.db.emailLog.count({ where: { userId: u.id, template: "drip" } })).toBe(0);
    });

    it("reorders steps and keeps waiting enrollments on the same step", async () => {
      const created = (await admin.post("/v1/admin/growth/sequences").send({ name: "Order", trigger: "signup" }).expect(201)).body.data;
      const id = created.id as string;
      const s2 = (await admin.post(`/v1/admin/growth/sequences/${id}/steps`).send({ delayHours: 1, subject: "Two", blocks: [{ type: "text", id: "t", text: "2" }] }).expect(201)).body.data.steps[1].id;
      const s1 = created.steps[0].id as string;
      const u = await makeUser("order@growth.test");
      await t.prisma.db.platformDripEnrollment.create({ data: { sequenceId: id, userId: u.id, nextStepPosition: 2, nextRunAt: new Date() } });
      const res = (await admin.put(`/v1/admin/growth/sequences/${id}/steps/order`).send({ stepIds: [s2, s1] }).expect(200)).body.data;
      expect(res.steps.map((s: { id: string; position: number }) => [s.id, s.position])).toEqual([
        [s2, 1],
        [s1, 2],
      ]);
      expect((await t.prisma.db.platformDripEnrollment.findFirstOrThrow({ where: { sequenceId: id } })).nextStepPosition).toBe(1);
      await admin.put(`/v1/admin/growth/sequences/${id}/steps/order`).send({ stepIds: [s2] }).expect(400);
    });
  });

  describe("subscribers", () => {
    it("lists by tab with counts; admin suppresses and unsuppresses", async () => {
      const page = (await support.get("/v1/admin/growth/subscribers?tab=consented&q=bulk-00").expect(200)).body.data;
      expect(page.counts.consented).toBeGreaterThan(200);
      expect(page.items.every((i: { email: string }) => i.email.startsWith("bulk-00"))).toBe(true);
      const target = page.items[0].userId as string;
      const s = (await admin.post(`/v1/admin/growth/subscribers/${target}/suppress`).expect(200)).body.data;
      expect(s).toMatchObject({ suppressionReason: "admin" });
      const suppressed = (await support.get(`/v1/admin/growth/subscribers?tab=suppressed&q=${target}`).expect(200)).body.data;
      expect(suppressed.items.map((i: { userId: string }) => i.userId)).toEqual([target]);
      await admin.post(`/v1/admin/growth/subscribers/${target}/unsuppress`).expect(200);
      expect((await t.prisma.db.platformUserProfile.findUniqueOrThrow({ where: { userId: target } })).suppressedAt).toBeNull();
      expect(await t.prisma.db.auditEvent.count({ where: { action: { in: ["platform.growth_user_suppressed", "platform.growth_user_unsuppressed"] }, targetId: target } })).toBe(2);
    });
  });
});
