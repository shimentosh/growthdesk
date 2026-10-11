import http from "node:http";
import type { AddressInfo } from "node:net";
import { vi } from "vitest";
import { bootApp, signUp, wait, type Agent, type TestApp } from "./helpers.js";
import { PlatformMailProcessorsModule } from "../src/platform-mail/platform-mail.processors.js";
import { PlatformMailService } from "../src/platform-mail/platform-mail.service.js";
import { SmtpProvider } from "../src/platform-mail/smtp.provider.js";
import { PlatformMailRateLimiter } from "../src/platform-mail/rate-limiter.js";
import { svixSignature } from "../src/platform-mail/svix.js";

/*
 * Platform mail: the queue → worker → Resend path against a local fake of
 * the Resend API (RESEND_API_URL), the SMTP fallback rules, Svix-signed
 * delivery webhooks (dedupe, status changes, complaint suppression), the
 * admin settings / domains / test send, editable system templates
 * (publish, preview, test, reset, rollback) and the platform rank gates.
 */

type Reply = { status: number; body?: unknown; headers?: Record<string, string>; hangup?: boolean };
type Seen = { method: string; url: string; headers: http.IncomingHttpHeaders; body: unknown };

const SECRET = `whsec_${Buffer.from("platform-mail-e2e-signing-secret").toString("base64")}`;
const API_KEY = "re_e2e_key_123";

async function until<T>(read: () => Promise<T>, done: (v: T) => boolean, timeoutMs = 20_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await read();
    if (done(v)) return v;
    if (Date.now() > end) throw new Error(`timed out; last value: ${JSON.stringify(v)}`);
    await wait(100);
  }
}

describe("Platform mail", () => {
  let t: TestApp;
  let owner: Agent;
  let admin: Agent;
  let support: Agent;
  let customer: Agent;
  let server: http.Server;
  const seen: Seen[] = [];
  const replies: Reply[] = [];
  let emailSeq = 0;
  let smtpSeq = 0;

  const sends = () => seen.filter((s) => s.method === "POST" && s.url === "/emails");

  /** Signs and posts a Resend webhook. */
  const hook = (event: unknown, opts: { id?: string; ts?: number; secret?: string } = {}) => {
    const body = JSON.stringify(event);
    const id = opts.id ?? `msg_${Math.random().toString(36).slice(2)}`;
    const ts = String(opts.ts ?? Math.floor(Date.now() / 1000));
    return t
      .http()
      .post("/v1/platform-mail/webhooks/resend")
      .set("content-type", "application/json")
      .set("svix-id", id)
      .set("svix-timestamp", ts)
      .set("svix-signature", `v1,${svixSignature(opts.secret ?? SECRET, id, ts, body)}`)
      .send(body);
  };

  const smtp = () => t.app.get(SmtpProvider);
  const pipeline = () => t.app.get(PlatformMailService);

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
        const reply = replies.shift();
        if (reply?.hangup) return req.socket.destroy();
        if (reply) {
          res.writeHead(reply.status, { "content-type": "application/json", ...(reply.headers ?? {}) });
          return res.end(JSON.stringify(reply.body ?? {}));
        }
        res.setHeader("content-type", "application/json");
        if (req.method === "POST" && req.url === "/emails") return res.end(JSON.stringify({ id: `re_email_${++emailSeq}` }));
        if (req.method === "GET" && req.url === "/domains")
          return res.end(JSON.stringify({ object: "list", has_more: false, data: [{ id: "dom_1", name: "mail.acme.test", status: "pending", region: "us-east-1", created_at: "2026-10-01T00:00:00Z" }] }));
        if (req.method === "GET" && req.url === "/domains/dom_1")
          return res.end(
            JSON.stringify({
              object: "domain",
              id: "dom_1",
              name: "mail.acme.test",
              status: "pending",
              region: "us-east-1",
              records: [
                { record: "SPF", name: "send", type: "MX", ttl: "Auto", status: "pending", value: "feedback-smtp.us-east-1.amazonses.com", priority: 10 },
                { record: "DKIM", name: "resend._domainkey", type: "TXT", ttl: "Auto", status: "verified", value: "p=MIGf" },
              ],
            }),
          );
        if (req.method === "POST" && req.url === "/domains/dom_1/verify") return res.end(JSON.stringify({ object: "domain", id: "dom_1" }));
        res.writeHead(404);
        res.end(JSON.stringify({ statusCode: 404, name: "not_found", message: "Not found" }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    process.env.RESEND_API_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    t = await bootApp([PlatformMailProcessorsModule]);
    owner = await signUp(t, "owner@pm.test", "Pat Owner");
    admin = await signUp(t, "admin@pm.test", "Ada Admin");
    support = await signUp(t, "support@pm.test", "Sam Support");
    customer = await signUp(t, "customer@pm.test", "Cus Tomer");
    for (const [a, role] of [[owner, "owner"], [admin, "admin"], [support, "support"]] as const) {
      await t.prisma.db.user.update({ where: { id: a.userId }, data: { platformRole: role } });
    }
  });

  afterAll(async () => {
    delete process.env.RESEND_API_URL;
    vi.restoreAllMocks();
    await t.close();
    await new Promise((r) => server.close(r));
  });

  beforeEach(() => {
    replies.length = 0;
    vi.spyOn(smtp(), "send").mockImplementation(async () => ({ providerMessageId: `<smtp-${++smtpSeq}@pm.test>` }));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    t.mail.deliveryMode = "outbox";
  });

  describe("in tests, system mail still lands in the outbox", () => {
    it("sign-up verification is rendered from the catalogue with a transactional footer", () => {
      const m = t.mail.outbox.find((x) => x.to === "customer@pm.test" && x.template === "verify_email")!;
      expect(m.subject).toBe("Confirm your email for Growthdesk");
      expect(m.text).toMatch(/Confirm email: http:\/\/localhost:3600\/verify-email\?token=/);
      expect(m.text).toContain("Hi Cus Tomer,");
      expect(m.html).not.toMatch(/unsubscribe/i);
    });

    it("logs the outbox send", async () => {
      const row = await t.prisma.db.emailLog.findFirst({ where: { to: "customer@pm.test", template: "verify_email" } });
      expect(row).toMatchObject({ status: "sent", provider: "outbox", subject: "Confirm your email for Growthdesk" });
    });
  });

  describe("ranks", () => {
    it("customers get 403 on every admin email route", async () => {
      await customer.get("/v1/admin/email/settings").expect(403);
      await customer.get("/v1/admin/email/templates").expect(403);
      await customer.patch("/v1/admin/email/settings").send({ mailProvider: "resend" }).expect(403);
      await t.http().get("/v1/admin/email/templates").expect(401);
    });

    it("support reads and previews but cannot change or send", async () => {
      await support.get("/v1/admin/email/settings").expect(200);
      await support.get("/v1/admin/email/templates").expect(200);
      await support.get("/v1/admin/email/templates/verify_email").expect(200);
      await support.post("/v1/admin/email/templates/verify_email/preview").send({ subject: "Hi", blocks: [{ type: "text", id: "t", text: "x {{action_url}}" }] }).expect(200);
      await support.patch("/v1/admin/email/settings").send({ mailProvider: "resend" }).expect(403);
      await support.post("/v1/admin/email/test").expect(403);
      await support.post("/v1/admin/email/templates/verify_email/versions").send({ subject: "x", blocks: [] }).expect(403);
      await support.post("/v1/admin/email/templates/verify_email/reset").expect(403);
      await support.post("/v1/admin/email/templates/verify_email/test").send({}).expect(403);
      await support.post("/v1/admin/email/templates/verify_email/versions/00000000-0000-4000-8000-000000000000/activate").expect(403);
      await support.post("/v1/admin/email/domains/dom_1/verify").expect(403);
    });
  });

  describe("settings", () => {
    it("defaults to SMTP and shows the webhook URL to paste into Resend", async () => {
      const s = (await admin.get("/v1/admin/email/settings").expect(200)).body.data;
      expect(s).toMatchObject({
        mailProvider: "smtp",
        resendApiKeySet: false,
        resendWebhookSecretSet: false,
        webhookUrl: "http://localhost:3600/api/platform-mail/webhooks/resend",
        effective: { provider: "smtp", transactionalFrom: "Growthdesk <no-reply@growthdesk.local>" },
      });
    });

    it("Resend selected without a key still sends through SMTP", async () => {
      const s = (await admin.patch("/v1/admin/email/settings").send({ mailProvider: "resend" }).expect(200)).body.data;
      expect(s.effective.provider).toBe("smtp");
      expect(s.effective.reason).toMatch(/no API key/);
      t.mail.deliveryMode = "queue";
      expect(await t.mail.notification("nokey@pm.test", "No key", "Body", "/")).toBe(true);
      const row = await until(
        () => t.prisma.db.emailLog.findFirstOrThrow({ where: { to: "nokey@pm.test" } }),
        (r) => r.status !== "queued",
      );
      expect(row).toMatchObject({ status: "sent", provider: "smtp", error: "" });
      expect(smtp().send).toHaveBeenCalledTimes(1);
      expect(sends()).toHaveLength(0);
    });

    it("saves keys write-only, validates senders and audits without secrets", async () => {
      await admin.patch("/v1/admin/email/settings").send({ resendWebhookSecret: "not-a-secret" }).expect(400);
      await admin.patch("/v1/admin/email/settings").send({ transactionalFrom: "Acme <broken" }).expect(400);
      const res = await admin
        .patch("/v1/admin/email/settings")
        .send({ resendApiKey: API_KEY, resendWebhookSecret: SECRET, transactionalFrom: "mail@acme.test", replyTo: "help@acme.test", resendRateLimitPerSec: 20 })
        .expect(200);
      expect(JSON.stringify(res.body)).not.toContain(API_KEY);
      expect(JSON.stringify(res.body)).not.toContain(SECRET);
      expect(res.body.data).toMatchObject({
        resendApiKeySet: true,
        resendApiKeyFromEnv: false,
        resendWebhookSecretSet: true,
        // No display name in the setting → the brand's product name.
        effective: { provider: "resend", transactionalFrom: "Growthdesk <mail@acme.test>", replyTo: "help@acme.test" },
      });
      const audit = await t.prisma.db.auditEvent.findFirstOrThrow({ where: { action: "platform.email_settings_updated", metadata: { path: ["changes", "resendApiKey"], equals: "replaced" } } });
      expect(JSON.stringify(audit.metadata)).not.toContain(API_KEY);
      expect(audit.actorUserId).toBe(admin.userId);
    });
  });

  describe("sending through Resend", () => {
    it("send → queued → sent, with the log id as Idempotency-Key and tag", async () => {
      t.mail.deliveryMode = "queue";
      const before = sends().length;
      expect(await t.mail.sendTemplate("waitlist_confirmed", "queued@pm.test", { name: "Quinn" }, { userId: customer.userId })).toBe(true);
      const queued = await t.prisma.db.emailLog.findFirstOrThrow({ where: { to: "queued@pm.test" } });
      expect(queued).toMatchObject({ stream: "transactional", provider: "resend", subject: "You're on the Growthdesk waitlist", fromAddress: "Growthdesk <mail@acme.test>", userId: customer.userId });
      const sent = await until(
        () => t.prisma.db.emailLog.findUniqueOrThrow({ where: { id: queued.id } }),
        (r) => r.status !== "queued",
      );
      expect(sent).toMatchObject({ status: "sent", provider: "resend", attempts: 1, error: "" });
      expect(sent.providerMessageId).toMatch(/^re_email_/);
      expect(sent.sentAt).not.toBeNull();
      const req = sends()[before]!;
      expect(req.headers.authorization).toBe(`Bearer ${API_KEY}`);
      expect(req.headers["idempotency-key"]).toBe(queued.id);
      expect(req.headers["user-agent"]).toMatch(/growthdesk/);
      expect(req.body).toMatchObject({
        from: "Growthdesk <mail@acme.test>",
        to: ["queued@pm.test"],
        subject: "You're on the Growthdesk waitlist",
        reply_to: "help@acme.test",
        tags: expect.arrayContaining([{ name: "log_id", value: queued.id }, { name: "template", value: "waitlist_confirmed" }]),
      });
      expect((req.body as { html: string }).html).toContain("Hi Quinn,");
      expect(smtp().send).not.toHaveBeenCalled();
    });

    it("401/403 from Resend → SMTP takes over and the log says why", async () => {
      replies.push({ status: 403, body: { statusCode: 403, name: "validation_error", message: "The domain is not verified" } });
      t.mail.deliveryMode = "queue";
      await t.mail.notification("fallback@pm.test", "Fallback", "Body", "/");
      const row = await until(
        () => t.prisma.db.emailLog.findFirstOrThrow({ where: { to: "fallback@pm.test" } }),
        (r) => r.status !== "queued",
      );
      expect(row).toMatchObject({ status: "sent", provider: "smtp" });
      expect(row.error).toMatch(/^Sent through SMTP: Resend 403 validation_error: The domain is not verified/);
      expect(smtp().send).toHaveBeenCalledTimes(1);
    });

    /** A queued row processed directly (no worker), so retries can be stepped through. */
    const direct = async (to: string) => {
      const log = await t.prisma.db.emailLog.create({ data: { to, template: "notification", status: "queued", provider: "resend", subject: "Direct" } });
      const job = { logId: log.id, mail: { from: "a@acme.test", to, subject: "Direct", html: "<p>x</p>", text: "x", template: "notification", stream: "transactional" as const } };
      return { log, job };
    };

    it("a 5xx is an unknown outcome: retried with the same key, never sent through SMTP", async () => {
      const { log, job } = await direct("server-error@pm.test");
      replies.push({ status: 500, body: { name: "application_error", message: "boom" } });
      await expect(pipeline().runSend(job, false)).rejects.toMatchObject({ kind: "unknown_outcome" });
      expect(await t.prisma.db.emailLog.findUniqueOrThrow({ where: { id: log.id } })).toMatchObject({ status: "queued", attempts: 1, error: "Resend 500 application_error: boom" });
      // The retry goes to Resend again with the same Idempotency-Key.
      expect(await pipeline().runSend(job, false)).toEqual({ status: "sent" });
      const keys = sends().filter((s) => (s.body as { to: string[] }).to[0] === "server-error@pm.test").map((s) => s.headers["idempotency-key"]);
      expect(keys).toEqual([log.id, log.id]);
      expect(smtp().send).not.toHaveBeenCalled();
      // A row that is no longer queued is never sent again.
      expect(await pipeline().runSend(job, false)).toEqual({ status: "sent" });
      expect(sends().filter((s) => (s.body as { to: string[] }).to[0] === "server-error@pm.test")).toHaveLength(2);
    });

    it("a dropped connection is an unknown outcome too; on the last attempt the row fails", async () => {
      const { log, job } = await direct("hangup@pm.test");
      replies.push({ status: 0, hangup: true });
      expect(await pipeline().runSend(job, true)).toEqual({ status: "failed" });
      const row = await t.prisma.db.emailLog.findUniqueOrThrow({ where: { id: log.id } });
      expect(row.status).toBe("failed");
      expect(row.error).toMatch(/Resend did not answer/);
      expect(smtp().send).not.toHaveBeenCalled();
    });

    it("a 422 fails at once, without retry or fallback", async () => {
      const { log, job } = await direct("invalid@pm.test");
      replies.push({ status: 422, body: { name: "missing_required_field", message: "Missing `to`" } });
      expect(await pipeline().runSend(job, false)).toEqual({ status: "failed" });
      expect((await t.prisma.db.emailLog.findUniqueOrThrow({ where: { id: log.id } })).error).toBe("Resend 422 missing_required_field: Missing `to`");
      expect(smtp().send).not.toHaveBeenCalled();
    });

    it("a 429 pauses the shared bucket for retry-after, then sends", async () => {
      const { job } = await direct("ratelimited@pm.test");
      replies.push({ status: 429, body: { name: "rate_limit_exceeded", message: "Too many requests" }, headers: { "retry-after": "1" } });
      const started = Date.now();
      expect(await pipeline().runSend(job, false)).toEqual({ status: "sent" });
      expect(Date.now() - started).toBeGreaterThanOrEqual(900);
      expect(sends().filter((s) => (s.body as { to: string[] }).to[0] === "ratelimited@pm.test")).toHaveLength(2);
    });

    it("the Redis token bucket spaces callers across the configured rate", async () => {
      const limiter = t.app.get(PlatformMailRateLimiter);
      const started = Date.now();
      // Rate 2/s: two tokens at once, then one every 500 ms → the 5th waits ~1.5 s.
      await Promise.all(Array.from({ length: 5 }, () => limiter.acquire("e2e-bucket", 2)));
      const took = Date.now() - started;
      expect(took).toBeGreaterThanOrEqual(1300);
      expect(took).toBeLessThan(4000);
    });

    it("the admin test send reports the provider and result", async () => {
      const res = (await admin.post("/v1/admin/email/test").expect(200)).body.data;
      expect(res).toMatchObject({ ok: true, provider: "resend", to: "admin@pm.test", fallbackReason: null, error: null });
      expect(res.providerMessageId).toMatch(/^re_email_/);
      const req = sends().at(-1)!;
      expect((req.body as { subject: string }).subject).toBe("[Test] Growthdesk email settings");
      replies.push({ status: 422, body: { name: "validation_error", message: "Invalid `from`" } });
      const failed = (await admin.post("/v1/admin/email/test").expect(200)).body.data;
      expect(failed).toMatchObject({ ok: false, error: "Resend 422 validation_error: Invalid `from`" });
    });

    it("lists and verifies Resend domains", async () => {
      const list = (await support.get("/v1/admin/email/domains").expect(200)).body.data.items;
      expect(list).toEqual([
        expect.objectContaining({ id: "dom_1", name: "mail.acme.test", status: "pending", records: expect.arrayContaining([expect.objectContaining({ record: "DKIM", status: "verified", priority: null })]) }),
      ]);
      expect((await admin.post("/v1/admin/email/domains/dom_1/verify").expect(200)).body.data).toEqual({ ok: true, id: "dom_1" });
      await admin.post("/v1/admin/email/domains/dom_missing/verify").expect(404);
    });
  });

  describe("webhooks", () => {
    let logId: string;
    let messageId: string;

    beforeAll(async () => {
      const row = await t.prisma.db.emailLog.findFirstOrThrow({ where: { to: "queued@pm.test" } });
      logId = row.id;
      messageId = row.providerMessageId!;
    });

    const event = (type: string, emailId: string, extra: Record<string, unknown> = {}) => ({
      type,
      created_at: new Date().toISOString(),
      data: { email_id: emailId, to: ["queued@pm.test"], tags: {}, ...extra },
    });

    it("refuses a bad or stale signature", async () => {
      await hook(event("email.delivered", messageId), { secret: `whsec_${Buffer.from("wrong").toString("base64")}` }).expect(401);
      await hook(event("email.delivered", messageId), { ts: Math.floor(Date.now() / 1000) - 600 }).expect(401);
      await t.http().post("/v1/platform-mail/webhooks/resend").set("content-type", "application/json").send("{}").expect(401);
      expect(await t.prisma.db.platformEmailEvent.count()).toBe(0);
    });

    it("applies delivered once, however often Svix retries it", async () => {
      const first = await hook(event("email.delivered", messageId), { id: "msg_delivered_1" }).expect(200);
      expect(first.body.data).toEqual({ ok: true, matched: true, duplicate: false });
      const again = await hook(event("email.delivered", messageId), { id: "msg_delivered_1" }).expect(200);
      expect(again.body.data).toEqual({ ok: true, matched: false, duplicate: true });
      expect(await t.prisma.db.platformEmailEvent.count({ where: { providerEventId: "msg_delivered_1" } })).toBe(1);
      const row = await t.prisma.db.emailLog.findUniqueOrThrow({ where: { id: logId } });
      expect(row.status).toBe("delivered");
      expect(row.deliveredAt).not.toBeNull();
    });

    it("records opens and clicks without changing the status", async () => {
      await hook(event("email.opened", messageId)).expect(200);
      await hook(event("email.clicked", messageId, { click: { link: "https://x.test" } })).expect(200);
      const row = await t.prisma.db.emailLog.findUniqueOrThrow({ where: { id: logId } });
      expect(row).toMatchObject({ status: "delivered" });
      expect(row.openedAt).not.toBeNull();
      expect(row.clickedAt).not.toBeNull();
    });

    it("a complaint marks the row and suppresses the user for marketing", async () => {
      await hook(event("email.complained", messageId)).expect(200);
      expect((await t.prisma.db.emailLog.findUniqueOrThrow({ where: { id: logId } })).status).toBe("complained");
      const profile = await t.prisma.db.platformUserProfile.findUniqueOrThrow({ where: { userId: customer.userId } });
      expect(profile.suppressionReason).toBe("complaint");
      expect(profile.suppressedAt).not.toBeNull();
      // A late "delivered" never moves it back.
      await hook(event("email.delivered", messageId)).expect(200);
      expect((await t.prisma.db.emailLog.findUniqueOrThrow({ where: { id: logId } })).status).toBe("complained");
    });

    it("a hard bounce suppresses the user found by address; a soft one does not", async () => {
      const soft = await t.prisma.db.emailLog.create({ data: { to: "support@pm.test", template: "notification", status: "sent", provider: "resend", providerMessageId: "re_soft" } });
      await hook(event("email.bounced", "re_soft", { bounce: { type: "Temporary", subType: "MailboxFull", message: "Full" } })).expect(200);
      expect((await t.prisma.db.emailLog.findUniqueOrThrow({ where: { id: soft.id } })).status).toBe("bounced");
      // Sign-up may already have created a profile; it must not be suppressed.
      expect((await t.prisma.db.platformUserProfile.findUnique({ where: { userId: support.userId } }))?.suppressedAt ?? null).toBeNull();

      await t.prisma.db.emailLog.create({ data: { to: "Owner@PM.test", template: "notification", status: "sent", provider: "resend", providerMessageId: "re_hard" } });
      await hook(event("email.bounced", "re_hard", { bounce: { type: "Permanent", subType: "General", message: "No such user" } })).expect(200);
      const profile = await t.prisma.db.platformUserProfile.findUniqueOrThrow({ where: { userId: owner.userId } });
      expect(profile.suppressionReason).toBe("hard_bounce");
    });

    it("matches by our log_id tag when the provider id is not stored yet, and stores unmatched events", async () => {
      const row = await t.prisma.db.emailLog.create({ data: { to: "late@pm.test", template: "notification", status: "queued", provider: "resend" } });
      await hook(event("email.delivered", "re_late", { tags: { log_id: row.id } })).expect(200);
      expect(await t.prisma.db.emailLog.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ status: "delivered", providerMessageId: "re_late" });
      const unmatched = await hook(event("email.delivered", "re_unknown")).expect(200);
      expect(unmatched.body.data.matched).toBe(false);
      expect(await t.prisma.db.platformEmailEvent.count({ where: { emailLogId: null } })).toBe(1);
    });

    it("the delivery log filters by provider/status/stream and shows a row's events", async () => {
      const list = (await support.get("/v1/admin/email-log?provider=resend&status=complained&stream=transactional").expect(200)).body.data;
      expect(list).toMatchObject({ total: 1, page: 1, items: [expect.objectContaining({ id: logId, to: "queued@pm.test", status: "complained", provider: "resend" })] });
      expect(list.templates).toEqual(expect.arrayContaining(["verify_email", "waitlist_confirmed"]));
      const bySubject = (await support.get("/v1/admin/email-log?q=waitlist").expect(200)).body.data;
      expect(bySubject.items.map((i: { id: string }) => i.id)).toContain(logId);
      const detail = (await support.get(`/v1/admin/email-log/${logId}`).expect(200)).body.data;
      expect(detail.events.map((e: { type: string }) => e.type)).toEqual(["email.delivered", "email.opened", "email.clicked", "email.complained", "email.delivered"]);
      expect(detail.user).toMatchObject({ id: customer.userId, email: "customer@pm.test" });
      await support.get("/v1/admin/email-log/not-a-uuid").expect(404);
    });
  });

  describe("system templates", () => {
    const blocks = (text: string) => [
      { type: "heading", id: "h", text: "Welcome to {{product_name}}" },
      { type: "text", id: "t", text },
      { type: "button", id: "b", label: "Confirm", url: "{{action_url}}" },
    ];

    it("lists every template with its state", async () => {
      const list = (await support.get("/v1/admin/email/templates").expect(200)).body.data;
      expect(list).toHaveLength(10);
      expect(list.find((x: { key: string }) => x.key === "verify_email")).toMatchObject({ label: "Confirm email", category: "account", customised: false, activeVersion: null });
      await support.get("/v1/admin/email/templates/nope").expect(404);
    });

    it("previews a draft with sample values and reports problems", async () => {
      const ok = (await support.post("/v1/admin/email/templates/verify_email/preview").send({ subject: "Confirm for {{product_name}}", blocks: blocks("Hi {{name}}") }).expect(200)).body.data;
      expect(ok.subject).toBe("Confirm for Growthdesk");
      expect(ok.text).toContain("Hi Alex");
      expect(ok.problems).toEqual([]);
      const bad = (await support.post("/v1/admin/email/templates/verify_email/preview").send({ subject: "x", blocks: [{ type: "text", id: "t", text: "{{first_name}}" }] }).expect(200)).body.data;
      expect(bad.problems.join(" ")).toMatch(/Unknown variable: \{\{first_name\}\}.*must include \{\{action_url\}\}/);
    });

    it("refuses to publish unknown tokens or a missing required token", async () => {
      const unknown = await admin.post("/v1/admin/email/templates/verify_email/versions").send({ subject: "Hi {{first_name}}", blocks: blocks("x") }).expect(400);
      expect(unknown.body.error.message).toMatch(/Unknown variable: \{\{first_name\}\}/);
      const missing = await admin.post("/v1/admin/email/templates/verify_email/versions").send({ subject: "Hi", blocks: [{ type: "text", id: "t", text: "x" }] }).expect(400);
      expect(missing.body.error.message).toBe("This email must include {{action_url}}.");
      await admin.post("/v1/admin/email/templates/verify_email/versions").send({ subject: "", blocks: blocks("x") }).expect(400);
    });

    it("publish → sends the new version; rollback; reset to the default (history kept)", async () => {
      const v1 = (await admin.post("/v1/admin/email/templates/verify_email/versions").send({ subject: "V1 confirm for {{product_name}}", blocks: blocks("Hello {{name|friend}}"), note: "first" }).expect(201)).body.data;
      expect(v1).toMatchObject({ customised: true, current: { subject: "V1 confirm for {{product_name}}" } });
      expect(v1.versions).toHaveLength(1);
      expect(v1.versions[0]).toMatchObject({ version: 1, active: true, note: "first", createdBy: { id: admin.userId } });
      await t.mail.verifyEmail("v1@pm.test", "", "tok-v1");
      const sent1 = t.mail.outbox.at(-1)!;
      expect(sent1).toMatchObject({ to: "v1@pm.test", subject: "V1 confirm for Growthdesk", templateVersionId: v1.versions[0].id });
      expect(sent1.text).toContain("Hello friend");
      expect(sent1.text).toContain("token=tok-v1");

      const v2 = (await admin.post("/v1/admin/email/templates/verify_email/versions").send({ subject: "V2 confirm", blocks: blocks("Two") }).expect(201)).body.data;
      expect(v2.versions.map((v: { version: number; active: boolean }) => [v.version, v.active])).toEqual([
        [2, true],
        [1, false],
      ]);
      await t.mail.verifyEmail("v2@pm.test", "", "tok-v2");
      expect(t.mail.outbox.at(-1)!.subject).toBe("V2 confirm");

      const rolled = (await admin.post(`/v1/admin/email/templates/verify_email/versions/${v1.versions[0].id}/activate`).expect(200)).body.data;
      expect(rolled.activeVersionId).toBe(v1.versions[0].id);
      await t.mail.verifyEmail("rollback@pm.test", "", "tok-r");
      expect(t.mail.outbox.at(-1)!.subject).toBe("V1 confirm for Growthdesk");
      await admin.post("/v1/admin/email/templates/reset_password/versions/" + v1.versions[0].id + "/activate").expect(404);

      const reset = (await admin.post("/v1/admin/email/templates/verify_email/reset").expect(200)).body.data;
      expect(reset).toMatchObject({ customised: false, activeVersionId: null });
      expect(reset.versions).toHaveLength(2);
      await t.mail.verifyEmail("reset@pm.test", "", "tok-x");
      expect(t.mail.outbox.at(-1)!.subject).toBe("Confirm your email for Growthdesk");

      const actions = (await t.prisma.db.auditEvent.findMany({ where: { targetType: "platform_email_template" }, orderBy: { createdAt: "asc" } })).map((a) => a.action);
      expect(actions).toEqual(["platform.email_template_published", "platform.email_template_published", "platform.email_template_activated", "platform.email_template_reset"]);
      const list = (await support.get("/v1/admin/email/templates").expect(200)).body.data;
      expect(list.find((x: { key: string }) => x.key === "verify_email")).toMatchObject({ customised: false, versionCount: 2 });
    });

    it("test-sends a draft or the live version to the admin, 10 an hour", async () => {
      const draft = (await admin
        .post("/v1/admin/email/templates/invitation/test")
        .send({ draft: { subject: "Join {{workspace}}", blocks: [{ type: "text", id: "t", text: "{{inviter}} says hi" }, { type: "button", id: "b", label: "Go", url: "{{action_url}}" }] } })
        .expect(200)).body.data;
      expect(draft).toMatchObject({ ok: true, provider: "resend", to: "admin@pm.test" });
      const req = sends().at(-1)!;
      expect(req.body).toMatchObject({ to: ["admin@pm.test"], subject: "[Test] Join Acme Sales" });
      expect((req.body as { text: string }).text).toContain("Sam Rivera says hi");

      const live = (await admin.post("/v1/admin/email/templates/trial_ended/test").send({}).expect(200)).body.data;
      expect(live.ok).toBe(true);
      expect((sends().at(-1)!.body as { subject: string }).subject).toBe("[Test] Your Growthdesk trial has ended");
      await admin.post("/v1/admin/email/templates/invitation/test").send({ draft: { subject: "x", blocks: [{ type: "text", id: "t", text: "{{nope}}" }] } }).expect(400);

      const used = await t.prisma.db.emailLog.count({ where: { userId: admin.userId, template: { startsWith: "test:" } } });
      for (let i = used; i < 10; i++) await t.prisma.db.emailLog.create({ data: { to: "admin@pm.test", template: "test:filler", status: "sent", userId: admin.userId } });
      const refused = await admin.post("/v1/admin/email/templates/trial_ended/test").send({}).expect(429);
      expect(refused.body.error.message).toMatch(/10 test emails an hour/);
      // The allowance is per person.
      await owner.post("/v1/admin/email/templates/trial_ended/test").send({}).expect(200);
    });
  });

  describe("webhook secret", () => {
    it("answers 503 until a signing secret is configured", async () => {
      await admin.patch("/v1/admin/email/settings").send({ resendWebhookSecret: "" }).expect(200);
      await hook({ type: "email.delivered", data: { email_id: "x" } }).expect(503);
    });
  });
});
