import nodemailer from "nodemailer";
import { bootApp, createWorkspace, setPlan, signUp, wait, type Agent, type TestApp } from "./helpers.js";
import { Queues, type QueueName } from "../src/queues/queues.js";
import { MailboxesProcessorsModule, MailProcessor } from "../src/mailboxes/mailboxes.processors.js";
import { ImportsProcessor, MaintenanceProcessorsModule } from "../src/worker/maintenance.processors.js";
import { hashToken, seal } from "../src/common/crypto.js";

/*
 * The worker side: imports, mailbox sync and health checks, task reminders,
 * trial expiry, billing reconcile and cleanup. The processor modules are
 * booted in-process, so jobs added to the real (test) Redis queues are run
 * by the same BullMQ workers production uses. Recurring schedules are not
 * registered (RUN_WORKERS is off in tests); each sweep is added as a job.
 * Mail goes through the dev GreenMail server (SMTP 3925 / IMAP 3943; any
 * x@growthdesk.test signs in with its own address as password).
 */

const RUN = Date.now().toString(36);
const MAILBOX = `maint-box-${RUN}@growthdesk.test`;
const LEAD = `maint-lead-${RUN}@growthdesk.test`;
const DAY = 86_400_000;

async function until<T>(read: () => Promise<T>, done: (v: T) => boolean, timeoutMs = 20_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await read();
    if (done(v)) return v;
    if (Date.now() > end) throw new Error(`timed out; last value: ${JSON.stringify(v)}`);
    await wait(150);
  }
}

describe("Worker: imports, mailboxes and maintenance", () => {
  let t: TestApp;
  let owner: Agent;
  let w: string;
  let other: string;
  let queues: Queues;

  /** Adds a job to a real queue and waits for the in-process worker to finish it. */
  async function run(queue: QueueName, name: string, data: Record<string, unknown> = {}) {
    const job = await queues.add(queue, name, data, { attempts: 1 });
    const q = queues.queue(queue);
    const state = await until(() => q.getJob(job.id!).then((j) => j?.getState()), (s) => s === "completed" || s === "failed");
    const finished = await q.getJob(job.id!);
    if (state === "failed") throw new Error(`${queue}/${name} failed: ${finished?.failedReason}`);
    return finished?.returnvalue as Record<string, unknown>;
  }

  beforeAll(async () => {
    t = await bootApp([MaintenanceProcessorsModule, MailboxesProcessorsModule]);
    queues = t.app.get(Queues);
    owner = await signUp(t, "maint-owner@acme.test", "Mona Owner");
    w = await createWorkspace(owner, "Maintenance Co");
    await setPlan(t, w, "agency");
    const outsider = await signUp(t, "maint-outsider@other.test");
    other = await createWorkspace(outsider, "Other Co");
  });
  afterAll(async () => t.close());

  describe("imports", () => {
    it("runs an import created through the API to completion on the imports queue", async () => {
      const csv = ["Name,Email,Company", "Ada Lovelace,ada@engines.test,Engines", "Grace Hopper,grace@navy.test,Navy", ",,"].join("\n");
      const started = await owner
        .post(`/v1/workspaces/${w}/imports`)
        .send({ fileName: "leads.csv", csv, mapping: { Name: "fullName", Email: "email", Company: "company" }, tags: ["imported"], onDuplicate: "update" })
        .expect(201);
      const id = started.body.data.id as string;
      const imp = await until(
        () => owner.get(`/v1/workspaces/${w}/imports/${id}`).then((r) => r.body.data),
        (d) => d.status === "completed" || d.status === "failed",
      );
      expect(imp).toMatchObject({ status: "completed", totalRows: 3, processedRows: 3, createdCount: 2, failedCount: 1 });
      expect(await t.prisma.db.contact.count({ where: { workspaceId: w, email: { in: ["ada@engines.test", "grace@navy.test"] } } })).toBe(2);
      const list = await owner.get(`/v1/workspaces/${w}/imports`).expect(200);
      expect(list.body.data.find((i: { id: string }) => i.id === id)?.status).toBe("completed");
    });

    it("never processes an import under another workspace's id", async () => {
      const imp = await t.prisma.db.import.create({
        data: { workspaceId: w, source: "csv", fileName: "x.csv", mapping: { Email: "email" }, options: {}, rows: [{ Email: "cross@tenant.test" }], totalRows: 1 },
      });
      await run("imports", "process", { workspaceId: other, importId: imp.id });
      const after = await t.prisma.db.import.findFirstOrThrow({ where: { id: imp.id, workspaceId: w } });
      expect(after.status).toBe("pending");
      expect(await t.prisma.db.contact.count({ where: { workspaceId: other } })).toBe(0);
      await t.prisma.db.import.deleteMany({ where: { id: imp.id, workspaceId: w } });
    });

    it("marks an import failed on its last attempt, with a message the UI can show", async () => {
      // Rows that are not a list cannot be processed: every attempt throws.
      const imp = await t.prisma.db.import.create({
        data: { workspaceId: w, source: "csv", fileName: "broken.csv", mapping: { Email: "email" }, options: {}, rows: "corrupt", totalRows: 1 },
      });
      await run("imports", "process", { workspaceId: w, importId: imp.id });
      const res = await owner.get(`/v1/workspaces/${w}/imports/${imp.id}`).expect(200);
      expect(res.body.data.status).toBe("failed");
      expect(res.body.data.errors).toEqual([{ row: 0, message: expect.stringMatching(/unexpected error/) }]);
      expect(res.body.data.finishedAt).not.toBeNull();
    });

    it("re-queues an import whose job was lost, and resumes from the saved row", async () => {
      const imp = await t.prisma.db.import.create({
        data: {
          workspaceId: w,
          source: "csv",
          fileName: "stuck.csv",
          status: "processing",
          mapping: { Email: "email" },
          options: { onDuplicate: "update" },
          rows: [{ Email: "already@done.test" }, { Email: "resumed@row.test" }],
          totalRows: 2,
          processedRows: 1,
          createdCount: 1,
        },
      });
      // Not idle long enough yet: left alone.
      expect(await t.app.get(ImportsProcessor).requeueStalled()).toBe(0);
      await t.prisma.unscoped.$executeRaw`UPDATE "Import" SET "updatedAt" = now() - interval '1 hour' WHERE id = ${imp.id}::uuid`;
      const swept = await run("imports", "sweep");
      expect(swept.requeued).toBe(1);
      const done = await until(
        () => t.prisma.db.import.findFirstOrThrow({ where: { id: imp.id, workspaceId: w } }),
        (i) => i.status === "completed",
      );
      expect(done).toMatchObject({ processedRows: 2, createdCount: 2 });
      // Only the unsaved row ran.
      expect(await t.prisma.db.contact.count({ where: { workspaceId: w, email: "already@done.test" } })).toBe(0);
      expect(await t.prisma.db.contact.count({ where: { workspaceId: w, email: "resumed@row.test" } })).toBe(1);
    });
  });

  describe("mailboxes", () => {
    let boxId: string;

    it("syncs a connected mailbox over IMAP from the queued job, filing the reply", async () => {
      await owner.post(`/v1/workspaces/${w}/contacts`).send({ fullName: "Lee Lead", email: LEAD }).expect(201);
      // GreenMail creates an account on its first sign-in; send to the mailbox before connecting it.
      const smtp = nodemailer.createTransport({ host: "127.0.0.1", port: 3925, secure: false, ignoreTLS: true, auth: { user: LEAD, pass: LEAD } });
      await smtp.sendMail({ from: LEAD, to: MAILBOX, subject: "Re: our chat", text: "Yes, let's talk on Tuesday.", messageId: `<maint-${RUN}@lead.test>` });
      smtp.close();

      const box = (
        await owner
          .post(`/v1/workspaces/${w}/mailboxes/smtp`)
          .send({
            email: MAILBOX,
            smtpHost: "127.0.0.1",
            smtpPort: 3925,
            smtpSecurity: "none",
            smtpUser: MAILBOX,
            password: MAILBOX,
            imapEnabled: true,
            imapHost: "127.0.0.1",
            imapPort: 3943,
            imapSecurity: "none",
            imapUser: MAILBOX,
          })
          .expect(201)
      ).body.data;
      boxId = box.id;
      // Connecting queued `sync-mailbox`; the worker reads the inbox.
      const synced = await until(
        () => t.prisma.db.mailbox.findFirstOrThrow({ where: { id: boxId, workspaceId: w } }),
        (b) => b.lastSyncedAt !== null || b.syncError !== "",
      );
      expect(synced.syncError).toBe("");
      expect(synced.imapUidNext).toBeGreaterThan(0);
      const msg = await t.prisma.db.message.findFirst({ where: { workspaceId: w, direction: "inbound", providerMessageId: `<maint-${RUN}@lead.test>` } });
      expect(msg?.bodyText).toContain("Tuesday");
    });

    it("the sync sweep queues mailboxes with reply tracking, but not ones whose sign-in is broken", async () => {
      const mail = t.app.get(MailProcessor);
      expect(await mail.queueDueSyncs()).toBe(1);
      await t.prisma.db.mailbox.update({ where: { id: boxId, workspaceId: w }, data: { status: "error", lastError: "IMAP sign-in failed: AUTHENTICATIONFAILED" } });
      expect(await mail.queueDueSyncs()).toBe(0);
      await t.prisma.db.mailbox.update({ where: { id: boxId, workspaceId: w }, data: { status: "error", lastError: "SMTP — 421 try later" } });
      expect(await mail.queueDueSyncs()).toBe(1);
      await t.prisma.db.mailbox.update({ where: { id: boxId, workspaceId: w }, data: { status: "connected", lastError: "" } });
      // A sync job under the wrong workspace touches nothing.
      const res = await run("mail", "sync-mailbox", { workspaceId: other, mailboxId: boxId });
      expect(res.error).toBe("The mailbox no longer exists");
    });

    it("the health check flags a mailbox whose server stopped answering, tells the owner, and recovers it", async () => {
      // Checked recently: not due.
      const fresh = await run("mail", "check-due");
      expect(fresh.queued).toBe(0);

      await t.prisma.db.mailbox.update({
        where: { id: boxId, workspaceId: w },
        // Nothing listens on this port: the SMTP check is refused. (GreenMail accepts any password, so a wrong one would pass.)
        data: { smtpPort: 3999, lastCheckedAt: new Date(Date.now() - 2 * DAY) },
      });
      const due = await run("mail", "check-due");
      expect(due.queued).toBe(1);
      const broken = await until(
        () => t.prisma.db.mailbox.findFirstOrThrow({ where: { id: boxId, workspaceId: w } }),
        (b) => b.status === "error",
      );
      expect(broken.lastError).toMatch(/^SMTP — /);
      const note = await until(
        () => t.prisma.db.notification.findFirst({ where: { workspaceId: w, userId: owner.userId, type: "mailbox.error" } }),
        (n) => n !== null,
      );
      expect(note?.link).toBe(`/w/${w}/settings/mailboxes/${boxId}`);
      expect(t.mail.outbox.some((m) => m.to === owner.email && m.subject.includes(MAILBOX))).toBe(true);
      // Sending pauses while the mailbox is in error.
      const listed = await owner.get(`/v1/workspaces/${w}/mailboxes`).expect(200);
      expect(listed.body.data[0].status).toBe("error");

      // The server is back; an hour later the check brings the mailbox back.
      await t.prisma.db.mailbox.update({ where: { id: boxId, workspaceId: w }, data: { smtpPort: 3925, lastCheckedAt: new Date(Date.now() - 2 * 3600_000) } });
      expect((await run("mail", "check-due")).queued).toBe(1);
      const back = await until(
        () => t.prisma.db.mailbox.findFirstOrThrow({ where: { id: boxId, workspaceId: w } }),
        (b) => b.status === "connected",
      );
      expect(back.lastError).toBe("");
      expect(await t.prisma.db.notification.count({ where: { workspaceId: w, type: "mailbox.error" } })).toBe(1);
    });
  });

  describe("maintenance", () => {
    it("sends due task reminders once and emits task.overdue once per task", async () => {
      const now = Date.now();
      const task = (
        await owner
          .post(`/v1/workspaces/${w}/tasks`)
          .send({ title: "Call back Ada", type: "call", dueAt: new Date(now - 3600_000).toISOString(), remindAt: new Date(now - 60_000).toISOString(), assigneeId: owner.userId })
          .expect(201)
      ).body.data;
      expect((await run("maintenance", "task-reminders")).reminded).toBeGreaterThanOrEqual(1);
      await run("maintenance", "task-reminders");
      const reminders = await t.prisma.db.notification.findMany({ where: { workspaceId: w, type: "task.reminder" } });
      expect(reminders.filter((n) => n.link.includes(task.id))).toHaveLength(1);

      expect((await run("maintenance", "task-overdue")).emitted).toBeGreaterThanOrEqual(1);
      await run("maintenance", "task-overdue");
      const events = await t.prisma.db.domainEvent.findMany({ where: { workspaceId: w, type: "task.overdue", subjectId: task.id } });
      expect(events).toHaveLength(1);
    });

    it("expires an unpaid trial and emails the owner; data is kept", async () => {
      const ws = await t.prisma.db.workspace.findUniqueOrThrow({ where: { id: w } });
      await t.prisma.db.subscription.update({
        where: { billingAccountId: ws.billingAccountId },
        data: { status: "trialing", trialEndsAt: new Date(Date.now() - 60_000), providerSubscriptionId: null, provider: "none" },
      });
      const contacts = await t.prisma.db.contact.count({ where: { workspaceId: w } });
      expect((await run("maintenance", "expire-trials")).expired).toBe(1);
      expect((await run("maintenance", "expire-trials")).expired).toBe(0);
      const sub = await t.prisma.db.subscription.findUniqueOrThrow({ where: { billingAccountId: ws.billingAccountId } });
      expect(sub.status).toBe("expired");
      expect(t.mail.outbox.filter((m) => m.to === owner.email && m.subject === "Your Growthdesk trial has ended")).toHaveLength(1);
      expect(await t.prisma.db.contact.count({ where: { workspaceId: w } })).toBe(contacts);
      await setPlan(t, w, "agency");
    });

    it("skips billing reconciliation when no subscription is provider-managed", async () => {
      const res = await run("maintenance", "billing-reconcile");
      expect(res.skipped).toMatch(/No payment provider/);
    });

    it("cleans up expired and stale rows, keeping everything still in use", async () => {
      const old = new Date(Date.now() - 200 * DAY);
      const userId = owner.userId;
      // Sessions and tokens: one expired, one live.
      const liveSessions = await t.prisma.db.session.count({ where: { userId } });
      await t.prisma.db.session.create({ data: { userId, tokenHash: hashToken(`old-${RUN}`), expiresAt: old } });
      await t.prisma.db.authToken.create({ data: { userId, kind: "reset_password", tokenHash: hashToken(`tok-${RUN}`), expiresAt: old } });
      await t.prisma.db.signInFailure.create({ data: { email: "someone@acme.test", ip: "10.0.0.1", count: 2, firstAt: old, lastAt: old } });
      // Tenant rows, in both workspaces.
      await t.prisma.db.idempotencyKey.create({ data: { workspaceId: other, key: "old", requestHash: "h", statusCode: 201, response: {}, createdAt: old } });
      await t.prisma.db.idempotencyKey.create({ data: { workspaceId: w, key: "fresh", requestHash: "h", statusCode: 201, response: {} } });
      const endpoint = await t.prisma.db.webhookEndpoint.create({ data: { workspaceId: w, url: "https://example.test/hook", secretSealed: seal("s"), events: ["contact.created"] } });
      const ev = () => crypto.randomUUID();
      await t.prisma.db.webhookDelivery.create({ data: { workspaceId: w, endpointId: endpoint.id, eventId: ev(), eventType: "contact.created", status: "succeeded", createdAt: old } });
      await t.prisma.db.webhookDelivery.create({ data: { workspaceId: w, endpointId: endpoint.id, eventId: ev(), eventType: "contact.created", status: "pending", createdAt: old } });
      await t.prisma.db.notification.create({ data: { workspaceId: w, userId, type: "x", title: "read, old", readAt: old, createdAt: old } });
      await t.prisma.db.notification.create({ data: { workspaceId: w, userId, type: "x", title: "unread, old", createdAt: old } });
      await t.prisma.db.aiCache.create({ data: { workspaceId: w, key: "gone", feature: "x", output: {}, expiresAt: new Date(Date.now() - 1000) } });
      await t.prisma.db.aiCache.create({ data: { workspaceId: w, key: "kept", feature: "x", output: {}, expiresAt: new Date(Date.now() + DAY) } });
      const box = await t.prisma.db.mailbox.findFirstOrThrow({ where: { workspaceId: w } });
      await t.prisma.db.mailboxDailyCount.create({ data: { workspaceId: w, mailboxId: box.id, day: old.toISOString().slice(0, 10), count: 4 } });
      await t.prisma.db.mailboxDailyCount.create({ data: { workspaceId: w, mailboxId: box.id, day: new Date().toISOString().slice(0, 10), count: 1 } });
      await t.prisma.db.emailLog.create({ data: { to: "x@acme.test", template: "x", status: "sent", createdAt: old } });
      const finished = await t.prisma.db.import.create({
        data: { workspaceId: w, source: "csv", status: "completed", rows: [{ a: "b" }], totalRows: 1, processedRows: 1, createdCount: 1, finishedAt: old },
      });

      const counts = await run("maintenance", "cleanup");
      expect(counts).toMatchObject({
        sessions: 1,
        authTokens: 1,
        signInFailures: 1,
        idempotencyKeys: 1,
        webhookDeliveries: 1,
        notifications: 1,
        aiCache: 1,
        mailboxDailyCounts: 1,
        emailLog: 1,
        importRows: 1,
      });
      expect(await t.prisma.db.session.count({ where: { userId } })).toBe(liveSessions);
      await owner.get("/v1/auth/me").expect(200);
      expect(await t.prisma.db.idempotencyKey.count({ where: { workspaceId: w, key: "fresh" } })).toBe(1);
      expect(await t.prisma.db.webhookDelivery.count({ where: { workspaceId: w, status: "pending" } })).toBe(1);
      expect(await t.prisma.db.notification.count({ where: { workspaceId: w, title: "unread, old" } })).toBe(1);
      expect(await t.prisma.db.aiCache.count({ where: { workspaceId: w, key: "kept" } })).toBe(1);
      expect(await t.prisma.db.mailboxDailyCount.count({ where: { workspaceId: w, mailboxId: box.id } })).toBe(1);
      const imp = await t.prisma.db.import.findFirstOrThrow({ where: { id: finished.id, workspaceId: w } });
      expect(imp.rows).toBeNull();
      expect(imp).toMatchObject({ status: "completed", createdCount: 1 });

      // A second run finds nothing.
      const again = await run("maintenance", "cleanup");
      expect(Object.values(again).every((n) => n === 0)).toBe(true);
    });
  });
});
