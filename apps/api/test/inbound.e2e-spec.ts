import { ImapFlow } from "imapflow";
import { vi } from "vitest";
import { bootApp, createWorkspace, setPlan, signUp, type Agent, type TestApp } from "./helpers.js";
import { ImapSyncService, MAX_MESSAGE_ATTEMPTS } from "../src/mailboxes/imap-sync.service.js";
import { InboundEmailService } from "../src/mailboxes/inbound-email.service.js";

/*
 * Inbound mail end to end: messages are appended to the dev GreenMail IMAP
 * server (127.0.0.1:3943, any x@growthdesk.test signs in with its own address
 * as password) and read by ImapSyncService, as the worker's sync job does.
 * Covers quoted opt-out footers, machine mail, the Junk folder, a failing
 * message holding the UID pointer, and the reply-tracking readiness warning.
 */

const RUN = Date.now().toString(36);
const BOX = `inbound-box-${RUN}@growthdesk.test`;
const ALWAYS_OPEN = { timezone: "UTC", days: [0, 1, 2, 3, 4, 5, 6], from: "00:00", to: "00:00" };
const lead = (name: string) => `${name}-${RUN}@lead.test`;
const outId = (name: string) => `<out-${name}-${RUN}@growthdesk.test>`;

type Raw = { from: string; subject: string; text: string; id: string; inReplyTo?: string; headers?: Record<string, string> };
const raw = (m: Raw) =>
  [
    `From: ${m.from}`,
    `To: ${BOX}`,
    `Subject: ${m.subject}`,
    `Message-ID: <${m.id}>`,
    `Date: ${new Date().toUTCString()}`,
    ...(m.inReplyTo ? [`In-Reply-To: ${m.inReplyTo}`, `References: ${m.inReplyTo}`] : []),
    ...Object.entries(m.headers ?? {}).map(([k, v]) => `${k}: ${v}`),
    "Content-Type: text/plain; charset=utf-8",
    "",
    m.text.replace(/\r?\n/g, "\r\n"),
  ].join("\r\n");

// The end of an outbound campaign email, as OutboundEmailService writes it.
const FOOTER = 'If you would rather not hear from me again, reply "unsubscribe" or visit: https://app.test/api/t/u/abc';
const quoted = (answer: string) => `${answer}\n\nOn Tue, Oct 6, 2026 at 9:14 AM Sam <${BOX}> wrote:\n> Hi, would Thursday suit?\n>\n> --\n> Sam\n>\n> ${FOOTER}`;

describe("Inbound mail", () => {
  let t: TestApp;
  let owner: Agent;
  let w: string;
  let boxId: string;
  let campaignId: string;
  const contacts: Record<string, string> = {};
  const enrollments: Record<string, string> = {};
  const api = (path: string) => `/v1/workspaces/${w}${path}`;

  async function deliver(folder: string, ...messages: Raw[]) {
    const imap = new ImapFlow({ host: "127.0.0.1", port: 3943, secure: false, auth: { user: BOX, pass: BOX }, logger: false });
    imap.on("error", () => undefined);
    await imap.connect();
    try {
      if (folder !== "INBOX") await imap.mailboxCreate(folder).catch(() => undefined);
      for (const m of messages) await imap.append(folder, raw(m));
    } finally {
      await imap.logout().catch(() => undefined);
    }
  }

  const sync = () => t.app.get(ImapSyncService).sync(w, boxId);
  const box = () => t.prisma.db.mailbox.findFirstOrThrow({ where: { id: boxId, workspaceId: w } });
  const inbound = (id: string) => t.prisma.db.message.findFirst({ where: { workspaceId: w, direction: "inbound", providerMessageId: `<${id}>` } });
  const enrollment = (name: string) => t.prisma.db.enrollment.findFirstOrThrow({ where: { id: enrollments[name]!, workspaceId: w } });

  beforeAll(async () => {
    t = await bootApp();
    owner = await signUp(t, `inbound-owner-${RUN}@acme.test`);
    w = await createWorkspace(owner, "Inbound Co");
    await setPlan(t, w, "growth");

    // Signing in once creates the GreenMail account; connecting the mailbox proves IMAP.
    await deliver("INBOX");
    boxId = (
      await owner
        .post(api("/mailboxes/smtp"))
        .send({ email: BOX, smtpHost: "127.0.0.1", smtpPort: 3925, smtpSecurity: "none", smtpUser: BOX, password: BOX, imapEnabled: true, imapHost: "127.0.0.1", imapPort: 3943, imapSecurity: "none", imapUser: BOX, minDelaySeconds: 0 })
        .expect(201)
    ).body.data.id;

    campaignId = (
      await owner
        .post(api("/campaigns"))
        .send({ name: "Q4 inbound test", schedule: ALWAYS_OPEN, mailboxIds: [boxId], steps: [{ type: "email", config: { subject: "Quick question", body: "Hi, would Thursday suit?" } }] })
        .expect(201)
    ).body.data.id;
    await t.prisma.db.campaign.update({ where: { id: campaignId, workspaceId: w }, data: { status: "running", startedAt: new Date() } });

    // Each lead was sent the campaign's first email: an enrollment, a conversation and our outbound message.
    for (const name of ["ada", "grace", "lin", "held", "stuck"]) {
      contacts[name] = (await owner.post(api("/contacts")).send({ fullName: name, email: lead(name) }).expect(201)).body.data.id;
      const e = await t.prisma.db.enrollment.create({ data: { workspaceId: w, campaignId, contactId: contacts[name]!, status: "active", nextRunAt: new Date(Date.now() + 86_400_000), mailboxId: boxId } });
      enrollments[name] = e.id;
      const c = await t.prisma.db.conversation.create({
        data: { workspaceId: w, channel: "email", contactId: contacts[name]!, subject: "Quick question", mailboxId: boxId, externalKey: `${boxId}:${outId(name)}`, peer: lead(name), handle: lead(name), displayName: name, campaignId },
      });
      await t.prisma.db.message.create({
        data: { workspaceId: w, conversationId: c.id, channel: "email", direction: "outbound", status: "sent", fromAddress: BOX, toAddress: lead(name), subject: "Quick question", bodyText: `Hi\n\n${FOOTER}`, providerMessageId: outId(name), enrollmentId: e.id, campaignId, mailboxId: boxId, sentAt: new Date() },
      });
    }
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    await t.close();
  });

  it("a reply quoting our unsubscribe footer stops the sequence but is not an opt-out; a written opt-out is", async () => {
    await deliver(
      "INBOX",
      { from: lead("ada"), subject: "Re: Quick question", text: quoted("Yes, Thursday works."), id: `ada-reply-${RUN}@lead.test`, inReplyTo: outId("ada") },
      { from: lead("grace"), subject: "Re: Quick question", text: quoted("Please unsubscribe me."), id: `grace-reply-${RUN}@lead.test`, inReplyTo: outId("grace") },
    );
    const res = await sync();
    expect(res.error).toBeUndefined();
    expect(res.failed).toBe(0);

    expect(await enrollment("ada")).toMatchObject({ status: "stopped", stopReason: "Replied" });
    const ada = await t.prisma.db.contact.findFirstOrThrow({ where: { id: contacts.ada!, workspaceId: w } });
    expect(ada.unsubscribedAt).toBeNull();
    expect(await t.prisma.db.suppression.count({ where: { workspaceId: w, value: lead("ada") } })).toBe(0);
    expect(await t.prisma.db.task.count({ where: { workspaceId: w, contactId: contacts.ada!, type: "review_reply" } })).toBe(1);

    expect(await enrollment("grace")).toMatchObject({ status: "stopped", stopReason: "Unsubscribed" });
    const grace = await t.prisma.db.contact.findFirstOrThrow({ where: { id: contacts.grace!, workspaceId: w } });
    expect(grace.unsubscribedAt).not.toBeNull();
    expect(await t.prisma.db.suppression.count({ where: { workspaceId: w, value: lead("grace"), reason: "unsubscribed" } })).toBe(1);
  });

  it("machine mail outside our threads makes no contact, conversation, reply or task; a stranger is filed without a contact", async () => {
    const before = {
      contacts: await t.prisma.db.contact.count({ where: { workspaceId: w } }),
      tasks: await t.prisma.db.task.count({ where: { workspaceId: w } }),
      events: await t.prisma.db.domainEvent.count({ where: { workspaceId: w, type: { in: ["contact.created", "reply.received"] } } }),
    };
    await deliver(
      "INBOX",
      { from: "news@shop.test", subject: "Our autumn sale", text: "50% off", id: `news-${RUN}@shop.test`, headers: { "List-Unsubscribe": "<https://shop.test/u>", "List-Id": "Shop news <news.shop.test>" } },
      { from: "digest@forum.test", subject: "Daily digest", text: "3 new posts", id: `bulk-${RUN}@forum.test`, headers: { Precedence: "bulk" } },
      { from: "noreply@saas.test", subject: "Your invoice", text: "Invoice #1", id: `noreply-${RUN}@saas.test` },
      { from: "alerts@monitor.test", subject: "Disk full", text: "!", id: `auto-${RUN}@monitor.test`, headers: { "Auto-Submitted": "auto-generated" } },
      { from: `stranger-${RUN}@else.test`, subject: "Hello", text: "Do you sell widgets?", id: `stranger-${RUN}@else.test` },
    );
    const res = await sync();
    expect(res).toMatchObject({ read: 5, filed: 1, replies: 0, skipped: 4, failed: 0 });

    for (const id of [`news-${RUN}@shop.test`, `bulk-${RUN}@forum.test`, `noreply-${RUN}@saas.test`, `auto-${RUN}@monitor.test`]) expect(await inbound(id)).toBeNull();
    const stranger = await inbound(`stranger-${RUN}@else.test`);
    expect(stranger).not.toBeNull();
    const convo = await t.prisma.db.conversation.findFirstOrThrow({ where: { id: stranger!.conversationId, workspaceId: w } });
    expect(convo.contactId).toBeNull();
    expect(await t.prisma.db.contact.count({ where: { workspaceId: w } })).toBe(before.contacts);
    expect(await t.prisma.db.task.count({ where: { workspaceId: w } })).toBe(before.tasks);
    expect(await t.prisma.db.domainEvent.count({ where: { workspaceId: w, type: { in: ["contact.created", "reply.received"] } } })).toBe(before.events);
  });

  it("reads the Junk folder for replies to our emails, and only those", async () => {
    await deliver(
      "Junk",
      { from: lead("lin"), subject: "Re: Quick question", text: "Interested — call me.", id: `lin-reply-${RUN}@lead.test`, inReplyTo: outId("lin") },
      { from: `spammer-${RUN}@spam.test`, subject: "You won", text: "Claim now", id: `spam-${RUN}@spam.test` },
    );
    const res = await sync();
    expect(res).toMatchObject({ filed: 1, replies: 1, failed: 0 });
    expect(await enrollment("lin")).toMatchObject({ status: "stopped", stopReason: "Replied" });
    expect(await inbound(`spam-${RUN}@spam.test`)).toBeNull();
    const b = await box();
    expect(b.imapJunkState).toMatchObject({ path: "Junk" });
    expect((b.imapJunkState as { uidNext: number }).uidNext).toBeGreaterThan(0);

    // Read once: the next pass starts after it.
    expect(await sync()).toMatchObject({ read: 0, filed: 0 });
  });

  it("a message that fails to file holds the pointer and is filed by the next pass", async () => {
    const service = t.app.get(InboundEmailService);
    const real = service.ingest.bind(service);
    const failing = `held-reply-${RUN}@lead.test`;
    let failures = 1;
    const spy = vi.spyOn(service, "ingest").mockImplementation(async (mailbox, mail, uid, folder) => {
      if (mail.messageId === `<${failing}>` && failures-- > 0) throw new Error("database hiccup");
      return real(mailbox, mail, uid, folder);
    });
    try {
      await deliver(
        "INBOX",
        { from: lead("held"), subject: "Re: Quick question", text: "Yes please.", id: failing, inReplyTo: outId("held") },
        { from: lead("ada"), subject: "Re: Quick question", text: "See you Thursday.", id: `ada-again-${RUN}@lead.test`, inReplyTo: outId("ada") },
      );
      const first = await sync();
      expect(first).toMatchObject({ failed: 1, filed: 1 });
      expect(await inbound(failing)).toBeNull();
      expect(await enrollment("held")).toMatchObject({ status: "active" });
      const held = await box();
      expect(held.imapFailedUid).not.toBeNull();
      expect(held.imapUidNext).toBe(held.imapFailedUid);
      expect(held.imapFailedAttempts).toBe(1);
      expect(held.syncError).toMatch(/database hiccup \(attempt 1 of 5, will retry\)/);

      // The next pass starts from the held message: it files now, and the one behind it is a duplicate.
      const second = await sync();
      expect(second).toMatchObject({ failed: 0, filed: 1, duplicates: 1 });
      expect(await inbound(failing)).not.toBeNull();
      expect(await enrollment("held")).toMatchObject({ status: "stopped", stopReason: "Replied" });
      const after = await box();
      expect(after).toMatchObject({ imapFailedUid: null, imapFailedAttempts: 0, syncError: "" });
      expect(after.imapUidNext).toBeGreaterThan(held.imapUidNext!);
    } finally {
      spy.mockRestore();
    }
  });

  it("gives up on a message that keeps failing, so the mailbox moves on", async () => {
    const service = t.app.get(InboundEmailService);
    const real = service.ingest.bind(service);
    const poison = `stuck-reply-${RUN}@lead.test`;
    const spy = vi.spyOn(service, "ingest").mockImplementation(async (mailbox, mail, uid, folder) => {
      if (mail.messageId === `<${poison}>`) throw new Error("cannot file this one");
      return real(mailbox, mail, uid, folder);
    });
    try {
      await deliver("INBOX", { from: lead("stuck"), subject: "Re: Quick question", text: "Hm.", id: poison, inReplyTo: outId("stuck") });
      for (let i = 1; i < MAX_MESSAGE_ATTEMPTS; i++) {
        await sync();
        expect(await box()).toMatchObject({ imapFailedAttempts: i });
      }
      const last = await sync();
      expect(last.failed).toBe(1);
      const b = await box();
      expect(b).toMatchObject({ imapFailedUid: null, imapFailedAttempts: 0 });
      expect(b.syncError).toMatch(/skipped after 5 attempts/);
    } finally {
      spy.mockRestore();
    }
    // Moved past it: the next pass reads nothing and clears the error.
    expect(await sync()).toMatchObject({ read: 0, failed: 0 });
    expect((await box()).syncError).toBe("");
  });

  it("warns at launch readiness when the sending mailbox's replies are not being read", async () => {
    const warnings = async () => (await owner.get(api(`/campaigns/${campaignId}/readiness`)).expect(200)).body.data.warnings as string[];
    // Synced a moment ago with no error: nothing to say.
    expect((await warnings()).filter((m) => m.includes(BOX))).toEqual([]);

    await t.prisma.db.mailbox.update({ where: { id: boxId, workspaceId: w }, data: { syncError: "Connection refused" } });
    expect(await warnings()).toContainEqual(expect.stringMatching(new RegExp(`Reading replies for ${BOX} is failing \\(Connection refused\\)`)));

    await t.prisma.db.mailbox.update({ where: { id: boxId, workspaceId: w }, data: { syncError: "", lastSyncedAt: new Date(Date.now() - 2 * 3600_000) } });
    expect(await warnings()).toContainEqual(expect.stringMatching(/were last read 120 minutes ago/));

    await t.prisma.db.mailbox.update({ where: { id: boxId, workspaceId: w }, data: { imapEnabled: false } });
    expect(await warnings()).toContainEqual(`Reply tracking (IMAP) is off for ${BOX}, so replies to its emails will not stop the sequence.`);

    // A campaign that does not stop on reply has nothing to warn about.
    await t.prisma.db.campaign.update({ where: { id: campaignId, workspaceId: w }, data: { settings: { stopOnReply: false } } });
    expect((await warnings()).filter((m) => m.includes(BOX))).toEqual([]);
  });
});
