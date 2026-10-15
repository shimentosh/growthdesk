import { ImapFlow } from "imapflow";
import { addMember, bootApp, createWorkspace, setPlan, signUp, wait, type Agent, type TestApp } from "./helpers.js";

/*
 * The unified inbox API. Conversations and inbound messages are seeded
 * directly (inbound filing is the mailboxes/channels areas' job); replies and
 * new emails go out over the dev GreenMail SMTP server (127.0.0.1:3925, any
 * x@growthdesk.test logs in with its own address as password) and are read
 * back over its IMAP (3943).
 */

const RUN = Date.now().toString(36);
const SENDER = `inbox-sender-${RUN}@growthdesk.test`;
const LEAD = `inbox-lead-${RUN}@growthdesk.test`;
const LEAD2 = `inbox-lead2-${RUN}@growthdesk.test`;

describe("Unified inbox", () => {
  let t: TestApp;
  let owner: Agent;
  let member: Agent;
  let viewer: Agent;
  let w: string;
  let contactId: string;
  let convoId: string;
  let otherConvoId: string;
  const base = () => `/v1/workspaces/${w}/inbox`;

  async function seedConversation(opts: { subject: string; peer: string; displayName: string; contactId?: string | null; assigneeId?: string | null; html?: string }) {
    const at = new Date(Date.now() - 60_000);
    const c = await t.prisma.db.conversation.create({
      data: {
        workspaceId: w,
        channel: "email",
        contactId: opts.contactId ?? null,
        subject: opts.subject,
        externalKey: `seed:${opts.peer}:${Math.random()}`,
        peer: opts.peer,
        handle: opts.peer,
        displayName: opts.displayName,
        assigneeId: opts.assigneeId ?? null,
        unread: true,
        lastMessageAt: at,
        lastInboundAt: at,
      },
    });
    await t.prisma.db.message.create({
      data: {
        workspaceId: w,
        conversationId: c.id,
        channel: "email",
        direction: "inbound",
        status: "received",
        fromAddress: opts.peer,
        toAddress: SENDER,
        subject: opts.subject,
        bodyText: "Sounds interesting, tell me more.",
        bodyHtml: opts.html ?? null,
        providerMessageId: `<seed-${c.id}@lead.test>`,
        receivedAt: at,
        createdAt: at,
      },
    });
    return c.id;
  }

  beforeAll(async () => {
    t = await bootApp();
    owner = await signUp(t, "inbox-owner@acme.test", "Olive Owner");
    w = await createWorkspace(owner, "Inbox Co");
    await setPlan(t, w, "agency");
    // Members here work the inbox but do not see other people's records and cannot assign.
    await owner.put(`/v1/workspaces/${w}/role-permissions`).send({ role: "member", permissions: ["contacts.read", "inbox.read", "inbox.reply", "tasks.read", "tasks.write"] }).expect(200);
    member = await addMember(t, owner, w, "inbox-member@acme.test", "member");
    viewer = await addMember(t, owner, w, "inbox-viewer@acme.test", "viewer");
    contactId = (await owner.post(`/v1/workspaces/${w}/contacts`).send({ fullName: "Lena Lead", email: LEAD }).expect(201)).body.data.id;
    convoId = await seedConversation({
      subject: "Quick question",
      peer: LEAD,
      displayName: "Lena Lead",
      contactId,
      html: `<p onclick="steal()">Sounds <b>interesting</b></p><script>alert(1)</script><a href="javascript:alert(2)">x</a>`,
    });
    otherConvoId = await seedConversation({ subject: "Pricing", peer: "someone@else.test", displayName: "Sam Else" });
  });
  afterAll(async () => t.close());

  it("lists conversations with previews, counts unread and returns a sanitised thread", async () => {
    const list = await owner.get(`${base()}/conversations`).expect(200);
    expect(list.body.data.total).toBe(2);
    const row = list.body.data.items.find((c: { id: string }) => c.id === convoId);
    expect(row).toMatchObject({ channel: "email", subject: "Quick question", unread: true, contact: { id: contactId, fullName: "Lena Lead" } });
    expect(row.preview).toMatchObject({ direction: "inbound", text: "Sounds interesting, tell me more." });

    const unread = await owner.get(`${base()}/unread-count`).expect(200);
    // Every inbox channel is counted, live chat ("web") included.
    expect(unread.body.data).toEqual({ total: 2, byChannel: { email: 2, whatsapp: 0, telegram: 0, web: 0 } });

    const q = await owner.get(`${base()}/conversations?q=pricing`).expect(200);
    expect(q.body.data.items.map((c: { id: string }) => c.id)).toEqual([otherConvoId]);
    await owner.get(`${base()}/conversations?unread=maybe`).expect(400);

    const detail = await owner.get(`${base()}/conversations/${convoId}`).expect(200);
    expect(detail.body.data.messages).toHaveLength(1);
    const html: string = detail.body.data.messages[0].bodyHtml;
    expect(html).toContain("<b>interesting</b>");
    expect(html).not.toMatch(/script|onclick|javascript:/);
    expect(detail.body.data.contact.email).toBe(LEAD);
  });

  it("isolates workspaces: another workspace's conversation is 404 and never listed", async () => {
    const outsider = await signUp(t, "inbox-outsider@other.test");
    const ow = await createWorkspace(outsider, "Other Co");
    await outsider.get(`/v1/workspaces/${ow}/inbox/conversations/${convoId}`).expect(404);
    await outsider.patch(`/v1/workspaces/${ow}/inbox/conversations/${convoId}`).send({ status: "closed" }).expect(404);
    await outsider.post(`/v1/workspaces/${ow}/inbox/conversations/${convoId}/notes`).send({ body: "hi" }).expect(404);
    await outsider.get(`/v1/workspaces/${w}/inbox/conversations`).expect(404); // not a member
    const list = await outsider.get(`/v1/workspaces/${ow}/inbox/conversations`).expect(200);
    expect(list.body.data.total).toBe(0);
    const count = await outsider.get(`/v1/workspaces/${ow}/inbox/unread-count`).expect(200);
    expect(count.body.data.total).toBe(0);
  });

  it("scopes visibility without records.view_all and enforces inbox.assign", async () => {
    // Unassigned: visible to everyone for triage.
    await member.get(`${base()}/conversations/${convoId}`).expect(200);
    // Assigned to the owner: gone for the member, still there for a viewer (records.view_all).
    await owner.patch(`${base()}/conversations/${otherConvoId}`).send({ assigneeId: owner.userId }).expect(200);
    await member.get(`${base()}/conversations/${otherConvoId}`).expect(404);
    const memberList = await member.get(`${base()}/conversations`).expect(200);
    expect(memberList.body.data.items.map((c: { id: string }) => c.id)).toEqual([convoId]);
    await viewer.get(`${base()}/conversations/${otherConvoId}`).expect(200);

    // A member may claim an unassigned conversation, but not hand it to someone else.
    const claimed = await member.patch(`${base()}/conversations/${convoId}`).send({ assigneeId: member.userId }).expect(200);
    expect(claimed.body.data.assignee.id).toBe(member.userId);
    const refused = await member.patch(`${base()}/conversations/${convoId}`).send({ assigneeId: owner.userId }).expect(403);
    expect(refused.body.error.message).toMatch(/assign/);
    // A viewer cannot change a conversation at all.
    await viewer.patch(`${base()}/conversations/${convoId}`).send({ status: "closed" }).expect(403);
    await viewer.post(`${base()}/conversations/${convoId}/read`).expect(403);

    // The owner reassigns to the member: the member is told, with a link into the inbox.
    await owner.patch(`${base()}/conversations/${otherConvoId}`).send({ assigneeId: member.userId }).expect(200);
    const n = await t.prisma.db.notification.findFirst({ where: { workspaceId: w, userId: member.userId, type: "conversation.assigned" } });
    expect(n?.link).toBe(`/w/${w}/inbox?c=${otherConvoId}`);
    await member.get(`${base()}/conversations/${otherConvoId}`).expect(200);
    // Only members can be assignees.
    const stranger = await owner.patch(`${base()}/conversations/${otherConvoId}`).send({ assigneeId: "00000000-0000-4000-8000-000000000000" }).expect(400);
    expect(stranger.body.error.fields.assigneeId).toBeDefined();
    await owner.patch(`${base()}/conversations/${otherConvoId}`).send({ assigneeId: null }).expect(200);
    await owner.patch(`${base()}/conversations/${convoId}`).send({ assigneeId: null }).expect(200);
  });

  it("closes, reopens, snoozes and marks read", async () => {
    await owner.patch(`${base()}/conversations/${otherConvoId}`).send({ status: "closed" }).expect(200);
    const closed = await owner.get(`${base()}/conversations?status=closed`).expect(200);
    expect(closed.body.data.items.map((c: { id: string }) => c.id)).toEqual([otherConvoId]);
    await owner.patch(`${base()}/conversations/${otherConvoId}`).send({ status: "open" }).expect(200);

    const until = new Date(Date.now() + 3600_000).toISOString();
    const snoozed = await owner.patch(`${base()}/conversations/${otherConvoId}`).send({ snoozedUntil: until }).expect(200);
    expect(snoozed.body.data.snoozedUntil).toBe(until);
    const snoozedList = await owner.get(`${base()}/conversations?status=snoozed`).expect(200);
    expect(snoozedList.body.data.items.map((c: { id: string }) => c.id)).toEqual([otherConvoId]);
    const open = await owner.get(`${base()}/conversations?status=open`).expect(200);
    expect(open.body.data.items.map((c: { id: string }) => c.id)).toEqual([convoId]);
    // A snoozed conversation does not count as unread until it wakes.
    expect((await owner.get(`${base()}/unread-count`).expect(200)).body.data.total).toBe(1);
    await owner.patch(`${base()}/conversations/${otherConvoId}`).send({ snoozedUntil: null }).expect(200);

    const read = await member.post(`${base()}/conversations/${otherConvoId}/read`).expect(200);
    expect(read.body.data).toEqual({ id: otherConvoId, unread: false });
    expect((await owner.get(`${base()}/conversations?unread=true`).expect(200)).body.data.total).toBe(1);
  });

  it("keeps internal notes: author or inbox.assign may delete", async () => {
    const mine = (await member.post(`${base()}/conversations/${convoId}/notes`).send({ body: "Asked about pricing tiers" }).expect(201)).body.data;
    const theirs = (await owner.post(`${base()}/conversations/${convoId}/notes`).send({ body: "Owner note" }).expect(201)).body.data;
    await member.post(`${base()}/conversations/${convoId}/notes`).send({ body: "   " }).expect(400);
    await viewer.post(`${base()}/conversations/${convoId}/notes`).send({ body: "viewer" }).expect(403);

    const notes = await viewer.get(`${base()}/conversations/${convoId}/notes`).expect(200);
    expect(notes.body.data.map((n: { body: string }) => n.body)).toEqual(["Asked about pricing tiers", "Owner note"]);
    expect(notes.body.data[0].author.id).toBe(member.userId);

    await member.delete(`${base()}/conversations/${convoId}/notes/${theirs.id}`).expect(403);
    // The note must belong to the conversation in the path.
    await owner.delete(`${base()}/conversations/${otherConvoId}/notes/${mine.id}`).expect(404);
    await member.delete(`${base()}/conversations/${convoId}/notes/${mine.id}`).expect(200);
    await owner.delete(`${base()}/conversations/${convoId}/notes/${theirs.id}`).expect(200);
    const detail = await owner.get(`${base()}/conversations/${convoId}`).expect(200);
    expect(detail.body.data.notes).toEqual([]);
  });

  it("creates a follow-up task linked to the conversation and its contact", async () => {
    const task = (await member.post(`${base()}/conversations/${convoId}/tasks`).send({}).expect(201)).body.data;
    expect(task).toMatchObject({ title: "Follow up with Lena Lead", conversationId: convoId, contactId, assigneeId: member.userId, type: "custom" });
    // Viewers lack tasks.write; members lack tasks.assign.
    await viewer.post(`${base()}/conversations/${convoId}/tasks`).send({}).expect(403);
    await member.post(`${base()}/conversations/${convoId}/tasks`).send({ assigneeId: owner.userId }).expect(403);
    const detail = await owner.get(`${base()}/conversations/${convoId}`).expect(200);
    expect(detail.body.data.tasks.map((x: { id: string }) => x.id)).toContain(task.id);
  });

  it("replies over SMTP, threaded on the inbound message, and composes a new email", async () => {
    // No mailbox yet: the conversation has none to reply from.
    const none = await owner.post(`${base()}/conversations/${convoId}/reply`).send({ body: "Hi" }).expect(409);
    expect(none.body.error.message).toMatch(/mailbox/i);

    const box = (
      await owner
        .post(`/v1/workspaces/${w}/mailboxes/smtp`)
        .send({ email: SENDER, displayName: "Olive at Inbox Co", smtpHost: "127.0.0.1", smtpPort: 3925, smtpSecurity: "none", smtpUser: SENDER, password: SENDER, imapEnabled: false, minDelaySeconds: 0 })
        .expect(201)
    ).body.data;

    await viewer.post(`${base()}/conversations/${convoId}/reply`).send({ body: "Hi", mailboxId: box.id }).expect(403);
    const bad = await owner.post(`${base()}/conversations/${convoId}/reply`).send({ body: "" }).expect(400);
    expect(bad.body.error.fields.body).toBeDefined();

    const sent = (await member.post(`${base()}/conversations/${convoId}/reply`).send({ body: "Happy to — here are the details.", mailboxId: box.id }).expect(201)).body.data;
    expect(sent).toMatchObject({ direction: "outbound", status: "sent", conversationId: convoId, subject: "Re: Quick question", toAddress: LEAD, mailboxId: box.id });
    expect(sent.inReplyTo).toBe(`<seed-${convoId}@lead.test>`);
    expect(sent.author.id).toBe(member.userId);

    const detail = await owner.get(`${base()}/conversations/${convoId}`).expect(200);
    expect(detail.body.data.unread).toBe(false);
    expect(detail.body.data.messages.map((m: { direction: string }) => m.direction)).toEqual(["inbound", "outbound"]);
    expect(detail.body.data.preview.direction).toBe("outbound");

    // Compose: a subject is required for email; then a new conversation with the contact starts.
    const second = (await owner.post(`/v1/workspaces/${w}/contacts`).send({ fullName: "Nora New", email: LEAD2 }).expect(201)).body.data.id;
    const noSubject = await owner.post(`${base()}/compose`).send({ channel: "email", contactId: second, body: "Hello" }).expect(400);
    expect(noSubject.body.error.fields.subject).toBeDefined();
    await viewer.post(`${base()}/compose`).send({ channel: "email", contactId: second, subject: "Hi", body: "Hello" }).expect(403);
    const composed = (await owner.post(`${base()}/compose`).send({ channel: "email", contactId: second, mailboxId: box.id, subject: "Introductions", body: "Hello Nora" }).expect(201)).body.data;
    expect(composed).toMatchObject({ direction: "outbound", status: "sent", subject: "Introductions", toAddress: LEAD2 });
    const started = await owner.get(`${base()}/conversations/${composed.conversationId}`).expect(200);
    expect(started.body.data.contact.id).toBe(second);
    const chat = await owner.post(`${base()}/compose`).send({ channel: "whatsapp", contactId: second, body: "Hello" }).expect(409);
    expect(chat.body.error.code).toBe("send_failed");

    // The reply really reached the lead's mailbox, threaded.
    const imap = new ImapFlow({ host: "127.0.0.1", port: 3943, secure: false, auth: { user: LEAD, pass: LEAD }, logger: false });
    await imap.connect();
    try {
      let found: { subject?: string; inReplyTo?: string } | null = null;
      for (let i = 0; i < 20 && !found; i++) {
        const lock = await imap.getMailboxLock("INBOX");
        try {
          for await (const m of imap.fetch("1:*", { envelope: true, headers: ["in-reply-to"] })) {
            if (m.envelope?.subject !== "Re: Quick question") continue;
            const header = (m.headers?.toString("utf8") ?? "").replace(/\r?\n\s+/g, " ");
            found = { subject: m.envelope.subject, inReplyTo: header.match(/^in-reply-to:\s*(\S+)/im)?.[1] };
          }
        } finally {
          lock.release();
        }
        if (!found) await wait(250);
      }
      expect(found).toEqual({ subject: "Re: Quick question", inReplyTo: `<seed-${convoId}@lead.test>` });
    } finally {
      await imap.logout().catch(() => undefined);
    }
  });
});
