import { randomUUID } from "node:crypto";
import { bootApp, createWorkspace, setPlan, signUp, type Agent, type TestApp } from "./helpers.js";
import { closedPort, startFakeSmtp, type FakeSmtp } from "./fake-smtp.js";
import { EngineService } from "../src/campaigns/engine.service.js";
import { OutboundEmailService } from "../src/messaging/outbound-email.service.js";
import { TRANSIENT_FAILURES_BEFORE_ERROR } from "../src/messaging/mailbox-faults.service.js";
import { Queues, QUEUES } from "../src/queues/queues.js";
import { seal } from "../src/common/crypto.js";
import { localDay } from "@growthdesk/shared";

/*
 * Sending reliability (docs/GAP_PLAN.md 0.6, 4.4, 4.5, 4.6, 4.7, 4.10, 4.11, 4.12)
 * against a fake SMTP server (test/fake-smtp.ts) that refuses "bad-*"
 * recipients with 550 5.1.1 and the password "wrong" with 535.
 */
const ALWAYS_OPEN = { timezone: "UTC", days: [0, 1, 2, 3, 4, 5, 6], from: "00:00", to: "00:00" };

describe("Sending reliability", () => {
  let t: TestApp;
  let owner: Agent;
  let w: string;
  let smtp: FakeSmtp;
  let engine: EngineService;

  const api = (path: string) => `/v1/workspaces/${w}${path}`;

  async function mailbox(email: string, minDelaySeconds = 0): Promise<string> {
    const res = await owner
      .post(api("/mailboxes/smtp"))
      .send({ email, displayName: "Sam", smtpHost: "127.0.0.1", smtpPort: smtp.port, smtpSecurity: "none", smtpUser: email, password: "secret", imapEnabled: false, minDelaySeconds })
      .expect(201);
    return res.body.data.id as string;
  }

  async function contact(body: Record<string, string>): Promise<string> {
    return (await owner.post(api("/contacts")).send(body).expect(201)).body.data.id as string;
  }

  /** A running campaign over these contacts, with every enrollment due now. */
  async function campaign(name: string, steps: unknown[], contactIds: string[], mailboxIds: string[], settings: Record<string, unknown> = {}): Promise<string> {
    const id = (await owner.post(api("/campaigns")).send({ name, schedule: ALWAYS_OPEN, settings: { gapSeconds: 0, ...settings } }).expect(201)).body.data.id as string;
    await owner.patch(api(`/campaigns/${id}`)).send({ steps, mailboxIds, audience: { type: "contacts", contactIds } }).expect(200);
    await owner.post(api(`/campaigns/${id}/launch`)).expect(200);
    await t.prisma.db.enrollment.updateMany({ where: { workspaceId: w, campaignId: id }, data: { nextRunAt: new Date(Date.now() - 1000) } });
    return id;
  }

  const enrollments = (campaignId: string) => t.prisma.db.enrollment.findMany({ where: { workspaceId: w, campaignId }, orderBy: { enrolledAt: "asc" } });

  beforeAll(async () => {
    smtp = await startFakeSmtp();
    t = await bootApp();
    owner = await signUp(t, "send-owner@acme.test");
    w = await createWorkspace(owner, "Sending Co");
    await setPlan(t, w, "growth");
    engine = t.app.get(EngineService);
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    await t.close();
    await smtp.close();
  });

  it("4.11: a synchronous 5.1.1 refusal is recorded as a bounce and the address is never enrolled again", async () => {
    const box = await mailbox("bounce-sender@fake.test");
    const good = await contact({ fullName: "Good Person", email: "good@fake.test" });
    const bad = await contact({ fullName: "Gone Person", email: "bad-gone@fake.test" });
    const id = await campaign("Bounce test", [{ type: "email", config: { subject: "Hi", body: "Hello there." } }], [good, bad], [box]);
    const rows = await enrollments(id);
    const outcomes = Object.fromEntries(await Promise.all(rows.map(async (e) => [e.contactId, await engine.runStep(w, e.id, e.stepRun)])));
    expect(outcomes[good]).toMatchObject({ outcome: "completed" });
    expect(outcomes[bad]).toMatchObject({ outcome: "stopped" });
    expect(outcomes[bad].reason).toMatch(/^Bounced: .*5\.1\.1/);

    const e = await t.prisma.db.enrollment.findFirstOrThrow({ where: { workspaceId: w, campaignId: id, contactId: bad } });
    expect(e).toMatchObject({ status: "stopped", stopReason: "Bounced" });
    const exec = await t.prisma.db.stepExecution.findFirstOrThrow({ where: { workspaceId: w, enrollmentId: e.id } });
    expect(exec.status).toBe("failed");
    const msg = await t.prisma.db.message.findFirstOrThrow({ where: { workspaceId: w, enrollmentId: e.id } });
    expect(msg.status).toBe("bounced");
    expect(msg.bouncedAt).not.toBeNull();
    expect((await t.prisma.db.contact.findFirstOrThrow({ where: { id: bad, workspaceId: w } })).bouncedAt).not.toBeNull();
    expect(await t.prisma.db.suppression.findFirst({ where: { workspaceId: w, kind: "email", value: "bad-gone@fake.test", reason: "bounced" } })).not.toBeNull();
    const event = await t.prisma.db.domainEvent.findFirst({ where: { workspaceId: w, type: "message.bounced", subjectId: msg.id } });
    expect(event?.payload).toMatchObject({ email: "bad-gone@fake.test", status: "5.1.1", kind: "smtp", enrollmentId: e.id });
    // The mailbox did nothing wrong.
    expect((await t.prisma.db.mailbox.findFirstOrThrow({ where: { id: box, workspaceId: w } })).status).toBe("connected");

    // A later campaign does not pick the dead address up again.
    const next = (await owner.post(api("/campaigns")).send({ name: "Later" }).expect(201)).body.data.id as string;
    await owner.patch(api(`/campaigns/${next}`)).send({ steps: [{ type: "email", config: { subject: "Hi", body: "Again." } }], mailboxIds: [box], audience: { type: "contacts", contactIds: [bad] } }).expect(200);
    const ready = (await owner.get(api(`/campaigns/${next}/readiness`)).expect(200)).body.data;
    expect(ready.audience).toMatchObject({ candidates: 1, eligible: 0 });
  });

  it("4.6: concurrent step jobs share a mailbox's pacing instead of bursting", async () => {
    const box = await mailbox("paced-sender@fake.test", 60);
    const ids = await Promise.all([1, 2, 3, 4].map((n) => contact({ fullName: `Paced ${n}`, email: `paced${n}@fake.test` })));
    const id = await campaign("Pacing test", [{ type: "email", config: { subject: "Hi", body: "Hello." } }], ids, [box]);
    const rows = await enrollments(id);
    const before = Date.now();
    const outcomes = await Promise.all(rows.map((e) => engine.runStep(w, e.id, e.stepRun)));
    expect(outcomes.filter((o) => o.outcome === "completed")).toHaveLength(1);
    const waiting = outcomes.filter((o) => o.outcome === "rescheduled");
    expect(waiting).toHaveLength(3);
    for (const o of waiting) expect(o.nextRunAt!.getTime()).toBeGreaterThanOrEqual(before + 55_000);
    expect(await t.prisma.db.message.count({ where: { workspaceId: w, campaignId: id, status: "sent" } })).toBe(1);
    const mb = await t.prisma.db.mailbox.findFirstOrThrow({ where: { id: box, workspaceId: w } });
    expect(mb.nextSendAt!.getTime()).toBeGreaterThanOrEqual(before + 59_000);
  });

  it("4.7: a start pushed onto a day that already had its new starts waits for the next day with room", async () => {
    const box = await mailbox("quota-sender@fake.test");
    const ids = await Promise.all([1, 2, 3].map((n) => contact({ fullName: `Quota ${n}`, email: `quota${n}@fake.test` })));
    // One new contact a day. Launch spreads them over three days; forcing all three due now is what a
    // reschedule (mailbox full, kill switch, pacing) can do to starts planned for earlier days.
    const id = await campaign("Quota test", [{ type: "email", config: { subject: "Hi", body: "Hello." } }], ids, [box], { dailyNewLimit: 1 });
    const [a, b, c] = await enrollments(id);
    const today = localDay(new Date(), "UTC");
    expect(await engine.runStep(w, a!.id, a!.stepRun)).toMatchObject({ outcome: "completed" });

    const second = await engine.runStep(w, b!.id, b!.stepRun);
    expect(second.outcome).toBe("rescheduled");
    const day2 = localDay(second.nextRunAt!, "UTC");
    expect(day2 > today).toBe(true);
    // The next pushed start skips the day the previous one now holds.
    const third = await engine.runStep(w, c!.id, c!.stepRun);
    expect(third.outcome).toBe("rescheduled");
    expect(localDay(third.nextRunAt!, "UTC") > day2).toBe(true);
    expect(await t.prisma.db.message.count({ where: { workspaceId: w, campaignId: id } })).toBe(1);
    expect((await t.prisma.db.enrollment.findFirstOrThrow({ where: { id: b!.id, workspaceId: w } })).nextRunAt).toEqual(second.nextRunAt);
  });

  it("4.10: with stop-on-reply, follow-ups wait while the thread's mailbox has not had its replies read", async () => {
    const box = await mailbox("stale-sync@fake.test");
    // Reply tracking on, but the last successful read was two hours ago (a failing sync looks the same).
    await t.prisma.db.mailbox.update({ where: { id: box, workspaceId: w }, data: { imapEnabled: true, imapHost: "127.0.0.1", lastSyncedAt: new Date(Date.now() - 2 * 3600_000), syncError: "Connection refused" } });
    const ids = await Promise.all(["stops", "ignores"].map((n) => contact({ fullName: n, email: `${n}-reply@fake.test` })));
    const step = [{ type: "email", config: { subject: "Following up", body: "Any thoughts?" } }];
    const stops = await campaign("Stale sync", step, [ids[0]!], [box]);
    const ignores = await campaign("Stale sync, no stop", step, [ids[1]!], [box], { stopOnReply: false });
    // The thread already went out from this mailbox (the sticky sender).
    for (const c of [stops, ignores]) await t.prisma.db.enrollment.updateMany({ where: { workspaceId: w, campaignId: c }, data: { mailboxId: box } });

    const [held] = await enrollments(stops);
    const before = Date.now();
    const out = await engine.runStep(w, held!.id, held!.stepRun);
    expect(out.outcome).toBe("rescheduled");
    expect(out.reason).toMatch(/^Waiting for replies to be read before sending: Reading replies for stale-sync@fake.test is failing/);
    expect(out.nextRunAt!.getTime()).toBeGreaterThanOrEqual(before + 14 * 60_000);
    expect(await t.prisma.db.message.count({ where: { workspaceId: w, campaignId: stops } })).toBe(0);
    expect((await t.prisma.db.enrollment.findFirstOrThrow({ where: { id: held!.id, workspaceId: w } })).status).toBe("active");

    // A campaign that does not stop on reply is not held.
    const [free] = await enrollments(ignores);
    expect(await engine.runStep(w, free!.id, free!.stepRun)).toMatchObject({ outcome: "completed" });

    // Replies read again: the held follow-up goes out.
    await t.prisma.db.mailbox.update({ where: { id: box, workspaceId: w }, data: { lastSyncedAt: new Date(), syncError: "" } });
    expect(await engine.runStep(w, held!.id, held!.stepRun)).toMatchObject({ outcome: "completed" });
  });

  it("4.5: one transient failure does not stop a mailbox; repeated ones do, and admins are told once", async () => {
    const box = await mailbox("flaky-sender@fake.test");
    await t.prisma.db.mailbox.update({ where: { id: box, workspaceId: w }, data: { smtpPort: await closedPort() } });
    const outbound = t.app.get(OutboundEmailService);
    const send = () => outbound.send({ workspaceId: w, mailboxId: box, to: "someone@fake.test", subject: "Hi", body: "Hello", kind: "manual" });
    const alerts = () => t.prisma.db.notification.count({ where: { workspaceId: w, userId: owner.userId, type: "mailbox.error" } });

    for (let i = 1; i < TRANSIENT_FAILURES_BEFORE_ERROR; i++) {
      expect((await send()).status).toBe("deferred");
      const mb = await t.prisma.db.mailbox.findFirstOrThrow({ where: { id: box, workspaceId: w } });
      expect(mb).toMatchObject({ status: "connected", sendFailures: i });
      expect(mb.lastError).toMatch(/ECONNREFUSED/);
    }
    expect(await alerts()).toBe(0);
    expect((await send()).status).toBe("deferred");
    expect(await t.prisma.db.mailbox.findFirstOrThrow({ where: { id: box, workspaceId: w } })).toMatchObject({ status: "error", sendFailures: 0 });
    expect(await alerts()).toBe(1);
    // Already in error: further attempts park without another alert. Nothing was left behind as "sending".
    expect((await send()).status).toBe("deferred");
    expect(await alerts()).toBe(1);
    expect(await t.prisma.db.message.count({ where: { workspaceId: w, mailboxId: box } })).toBe(0);

    // A success in between resets the count.
    const steady = await mailbox("steady-sender@fake.test");
    await t.prisma.db.mailbox.update({ where: { id: steady, workspaceId: w }, data: { sendFailures: TRANSIENT_FAILURES_BEFORE_ERROR - 1, lastError: "earlier blip" } });
    expect((await outbound.send({ workspaceId: w, mailboxId: steady, to: "someone@fake.test", subject: "Hi", body: "Hello", kind: "manual" })).status).toBe("sent");
    expect(await t.prisma.db.mailbox.findFirstOrThrow({ where: { id: steady, workspaceId: w } })).toMatchObject({ status: "connected", sendFailures: 0, lastError: "" });
  });

  it("4.5: a refused sign-in stops the mailbox at once and tells admins", async () => {
    const box = await mailbox("locked-sender@fake.test");
    await t.prisma.db.mailbox.update({ where: { id: box, workspaceId: w }, data: { secretSealed: seal("wrong") } });
    const before = await t.prisma.db.notification.count({ where: { workspaceId: w, userId: owner.userId, type: "mailbox.error" } });
    const r = await t.app.get(OutboundEmailService).send({ workspaceId: w, mailboxId: box, to: "someone@fake.test", subject: "Hi", body: "Hello", kind: "manual" });
    expect(r.status).toBe("failed");
    expect((await t.prisma.db.mailbox.findFirstOrThrow({ where: { id: box, workspaceId: w } })).status).toBe("error");
    const after = await t.prisma.db.notification.findMany({ where: { workspaceId: w, userId: owner.userId, type: "mailbox.error" }, orderBy: { createdAt: "desc" } });
    expect(after).toHaveLength(before + 1);
    expect(after[0]!.title).toBe("locked-sender@fake.test stopped working");
  });

  it("4.4: a WhatsApp send with an unknown outcome is recorded uncertain and never retried", async () => {
    await t.prisma.db.channelIntegration.create({
      data: {
        workspaceId: w,
        channel: "whatsapp",
        provider: "meta_cloud",
        name: "Sales line",
        status: "connected",
        config: { phoneNumberId: "1234567890", displayPhoneNumber: "+1 555 0100" },
        secretSealed: seal(JSON.stringify({ accessToken: "token", appSecret: "s", verifyToken: "v" })),
        webhookKey: randomUUID(),
        externalId: "1234567890",
      },
    });
    const tpl = await owner.post(api("/templates")).send({ name: "WA hello", channel: "whatsapp", body: "Hello", waTemplate: "hello_world", waLanguage: "en_US" }).expect(201);
    const person = await contact({ fullName: "Chat Person", phone: "+14155550123" });
    const id = await campaign("Chat test", [{ type: "whatsapp", config: { templateId: tpl.body.data.id } }], [person], []);

    // The request reached Meta but the connection dropped before an answer.
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      if (String(url).includes("graph.facebook.com")) throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
      throw new Error(`unexpected fetch ${String(url)}`);
    });
    try {
      const [e] = await enrollments(id);
      const out = await engine.runStep(w, e!.id, e!.stepRun);
      expect(out.outcome).toBe("completed");
      const exec = await t.prisma.db.stepExecution.findFirstOrThrow({ where: { workspaceId: w, enrollmentId: e!.id } });
      expect(exec.status).toBe("uncertain");
      const msg = await t.prisma.db.message.findFirstOrThrow({ where: { workspaceId: w, enrollmentId: e!.id } });
      expect(msg.status).toBe("uncertain");
      expect(exec.messageId).toBe(msg.id);
      // Nothing is due again: a later tick never re-sends it.
      const tick = await engine.tick();
      expect(tick.claimed.filter((c) => c.id === e!.id)).toHaveLength(0);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(await t.prisma.db.message.count({ where: { workspaceId: w, enrollmentId: e!.id } })).toBe(1);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("4.12: a step job that keeps failing is counted, backs off, then fails the enrollment and tells the owner once", async () => {
    const box = await mailbox("crashy-sender@fake.test");
    const ids = await Promise.all([1, 2].map((n) => contact({ fullName: `Crashy ${n}`, email: `crashy${n}@fake.test` })));
    const id = await campaign("Crash test", [{ type: "email", config: { subject: "Hi", body: "Hello." } }], ids, [box]);

    // Claimed jobs carry the error count in their id, and failed ones are kept.
    const tick = await engine.tick();
    const mine = tick.claimed.filter((c) => ids.length && c.workspaceId === w);
    const job = await t.app.get(Queues).queue(QUEUES.engine).getJob(`${mine[0]!.id}-${mine[0]!.stepRun}-0`);
    expect(job?.opts.removeOnFail).toMatchObject({ age: expect.any(Number) });

    const [first, second] = await enrollments(id);
    expect(await engine.recordJobFailure(w, first!.id, first!.stepRun, "database timeout")).toBe("retry");
    let e = await t.prisma.db.enrollment.findFirstOrThrow({ where: { id: first!.id, workspaceId: w } });
    expect(e).toMatchObject({ status: "active", errorCount: 1, lockedUntil: null });
    expect(e.lastError).toMatch(/database timeout/);
    expect(e.nextRunAt!.getTime()).toBeGreaterThan(Date.now() + 14 * 60_000);
    // A duplicate report for an older stepRun changes nothing.
    expect(await engine.recordJobFailure(w, first!.id, first!.stepRun - 1, "late")).toBe("noop");
    expect(await engine.recordJobFailure(w, first!.id, first!.stepRun, "database timeout")).toBe("retry");
    expect(await engine.recordJobFailure(w, first!.id, first!.stepRun, "database timeout")).toBe("failed");
    e = await t.prisma.db.enrollment.findFirstOrThrow({ where: { id: first!.id, workspaceId: w } });
    expect(e).toMatchObject({ status: "failed", errorCount: 3, nextRunAt: null, stepRun: first!.stepRun + 1 });

    // A second enrollment failing the same way within the hour does not notify again.
    for (let i = 0; i < 3; i++) await engine.recordJobFailure(w, second!.id, second!.stepRun, "database timeout");
    const alerts = await t.prisma.db.notification.findMany({ where: { workspaceId: w, type: "campaign.step_failed" } });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.userId).toBe(owner.userId);
  });
});
