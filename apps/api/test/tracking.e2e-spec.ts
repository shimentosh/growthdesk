import { randomUUID } from "node:crypto";
import { bootApp, createWorkspace, setPlan, signUp, type Agent, type TestApp } from "./helpers.js";
import { EngineService } from "../src/campaigns/engine.service.js";
import { SuppressionService } from "../src/crm/suppression.service.js";
import { clickUrl, openUrl, trackingBase, trackingToken, unsubscribeUrl } from "../src/messaging/tracking.js";
import { PIXEL_GIF } from "../src/tracking/tracking-rules.js";

/*
 * Open pixel, click redirect and unsubscribe, reached exactly as an email's
 * links reach them: the URLs messaging/tracking.ts builds for
 * ${PUBLIC_APP_URL}/api/t/..., with the web proxy's /api → /v1 applied.
 * Messages are written directly (as OutboundEmailService leaves them after a
 * send), so no SMTP server is involved.
 */
const BROWSER = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15";
const base = trackingBase(process.env.PUBLIC_APP_URL!);
const path = (url: string) => url.replace(`${process.env.PUBLIC_APP_URL}/api`, "/v1");

describe("Tracking and unsubscribe", () => {
  let t: TestApp;
  let owner: Agent;
  let other: Agent;
  let w: string;
  let w2: string;
  let campaignId: string;
  let adaId: string;
  let graceId: string;
  let adaElsewhereId: string;
  let enrollmentId: string;
  let sent: string; // Ada's campaign email
  let inFlight: string; // a write-ahead row whose send is not confirmed yet
  let graceMail: string; // a one-off email to Grace, no campaign

  const api = (p: string) => `/v1/workspaces/${w}${p}`;

  /** A sent outbound email, as OutboundEmailService records it. */
  async function message(workspaceId: string, contactId: string, to: string, opts: { campaignId?: string; enrollmentId?: string; sentAt?: Date | null; mailboxId?: string } = {}) {
    const id = randomUUID();
    const conversation = await t.prisma.db.conversation.create({
      data: { workspaceId, channel: "email", contactId, externalKey: `test:${id}`, peer: to, handle: to, subject: "Quick question", mailboxId: opts.mailboxId ?? null },
    });
    await t.prisma.db.message.create({
      data: {
        id,
        workspaceId,
        conversationId: conversation.id,
        channel: "email",
        direction: "outbound",
        status: opts.sentAt === null ? "sending" : "sent",
        fromAddress: "sam@acme.test",
        toAddress: to,
        subject: "Quick question",
        providerMessageId: `<${id}@acme.test>`,
        campaignId: opts.campaignId ?? null,
        enrollmentId: opts.enrollmentId ?? null,
        mailboxId: opts.mailboxId ?? null,
        sentAt: opts.sentAt === undefined ? new Date(Date.now() - 10 * 60_000) : opts.sentAt,
      },
    });
    return id;
  }

  beforeAll(async () => {
    t = await bootApp();
    owner = await signUp(t, "track-owner@acme.test");
    w = await createWorkspace(owner, "Acme Outreach");
    await setPlan(t, w, "growth");
    other = await signUp(t, "track-other@other.test");
    w2 = await createWorkspace(other, "Other Co");
    await setPlan(t, w2, "growth");

    adaId = (await owner.post(api("/contacts")).send({ fullName: "Ada Lovelace", email: "ada@growthdesk.test" }).expect(201)).body.data.id;
    graceId = (await owner.post(api("/contacts")).send({ fullName: "Grace Hopper", email: "grace@growthdesk.test" }).expect(201)).body.data.id;
    adaElsewhereId = (await other.post(`/v1/workspaces/${w2}/contacts`).send({ fullName: "Ada (elsewhere)", email: "ada@growthdesk.test" }).expect(201)).body.data.id;

    const campaign = await owner
      .post(api("/campaigns"))
      .send({ name: "Q4 outbound", steps: [{ type: "email", config: { subject: "Quick question", body: "Hi {{first_name|there}}" } }] })
      .expect(201);
    campaignId = campaign.body.data.id;
    const mailbox = await t.prisma.db.mailbox.create({ data: { workspaceId: w, provider: "smtp", email: "sam@acme.test", displayName: "Sam Sender", status: "connected" } });
    const enrollment = await t.prisma.db.enrollment.create({ data: { workspaceId: w, campaignId, contactId: adaId, status: "active", nextRunAt: new Date(Date.now() + 86_400_000) } });
    enrollmentId = enrollment.id;
    sent = await message(w, adaId, "ada@growthdesk.test", { campaignId, enrollmentId, mailboxId: mailbox.id });
    await t.prisma.db.stepExecution.create({ data: { workspaceId: w, enrollmentId, campaignId, position: 0, stepType: "email", stepRun: 0, status: "succeeded", messageId: sent } });
    inFlight = await message(w, adaId, "ada@growthdesk.test", { sentAt: null });
    graceMail = await message(w, graceId, "grace@growthdesk.test");
  });
  afterAll(async () => t.close());

  describe("open pixel", () => {
    it("always answers the GIF, uncached, and records a person's open once", async () => {
      const res = await t.http().get(path(openUrl(base, sent))).set("user-agent", BROWSER).expect(200);
      expect(res.headers["content-type"]).toBe("image/gif");
      expect(res.headers["cache-control"]).toMatch(/no-store/);
      expect(Buffer.compare(res.body as Buffer, PIXEL_GIF)).toBe(0);
      // The client re-rendering a moment later is the same open.
      await t.http().get(path(openUrl(base, sent))).set("user-agent", BROWSER).expect(200);

      const m = await t.prisma.db.message.findFirstOrThrow({ where: { id: sent, workspaceId: w } });
      expect(m.openCount).toBe(1);
      expect(m.openedAt).toBeInstanceOf(Date);
      expect(await t.prisma.db.messageEvent.count({ where: { workspaceId: w, messageId: sent, type: "opened" } })).toBe(1);
    });

    it("serves the GIF but records nothing for bad tokens, scanners and unconfirmed sends", async () => {
      for (const p of ["/v1/t/o/garbage.gif", `/v1/t/o/${trackingToken({ kind: "unsubscribe", messageId: sent })}.gif`, `/v1/t/o/${trackingToken({ kind: "open", messageId: randomUUID() })}.gif`]) {
        const res = await t.http().get(p).set("user-agent", BROWSER).expect(200);
        expect(res.headers["content-type"]).toBe("image/gif");
      }
      await t.http().get(path(openUrl(base, graceMail))).set("user-agent", "curl/8.4.0").expect(200);
      await t.http().get(path(openUrl(base, graceMail))).expect(200);
      await t.http().head(path(openUrl(base, graceMail))).set("user-agent", BROWSER).expect(200);
      await t.http().get(path(openUrl(base, inFlight))).set("user-agent", BROWSER).expect(200);

      const rows = await t.prisma.db.message.findMany({ where: { workspaceId: w, id: { in: [graceMail, inFlight] } } });
      expect(rows.every((m) => m.openCount === 0 && m.openedAt === null)).toBe(true);
      expect(await t.prisma.db.messageEvent.count({ where: { workspaceId: w, type: "opened" } })).toBe(1);
    });
  });

  describe("click redirect", () => {
    const target = "https://example.com/pricing?plan=growth&ref=email";

    it("records the click and redirects to the signed URL", async () => {
      const res = await t.http().get(path(clickUrl(base, sent, target))).set("user-agent", BROWSER).expect(302);
      expect(res.headers.location).toBe(target);
      await t.http().get(path(clickUrl(base, sent, target))).set("user-agent", BROWSER).expect(302);

      const m = await t.prisma.db.message.findFirstOrThrow({ where: { id: sent, workspaceId: w } });
      expect(m.clickCount).toBe(1);
      expect(m.clickedAt).toBeInstanceOf(Date);
      const event = await t.prisma.db.messageEvent.findFirstOrThrow({ where: { workspaceId: w, messageId: sent, type: "clicked" } });
      expect(event.data).toMatchObject({ url: target });
      const activity = await t.prisma.db.activity.findMany({ where: { workspaceId: w, contactId: adaId, type: "email.clicked" } });
      expect(activity).toHaveLength(1);
      expect(activity[0]!.summary).toBe('Clicked a link in "Quick question"');
    });

    it("still redirects a scanner, without counting it", async () => {
      const res = await t.http().get(path(clickUrl(base, graceMail, target))).set("user-agent", "Mozilla/5.0 (compatible; bingbot/2.0)").expect(302);
      expect(res.headers.location).toBe(target);
      expect((await t.prisma.db.message.findFirstOrThrow({ where: { id: graceMail, workspaceId: w } })).clickCount).toBe(0);
    });

    it("is not an open redirect: a changed URL or signature is refused", async () => {
      const token = trackingToken({ kind: "click", messageId: sent, url: target });
      const parts = token.split(".");
      parts[2] = Buffer.from("https://evil.example/", "utf8").toString("base64url");
      const swapped = await t.http().get(`/v1/t/c/${parts.join(".")}`).expect(404);
      expect(swapped.headers.location).toBeUndefined();
      expect(swapped.body.error.code).toBe("not_found");
      await t.http().get(`/v1/t/c/${token.slice(0, -3)}xyz`).expect(404);
      await t.http().get(`/v1/t/c/${trackingToken({ kind: "open", messageId: sent })}`).expect(404);
    });

    it("feeds the campaign's counters and per-step stats", async () => {
      await t.app.get(EngineService).refreshStats(w, campaignId);
      const c = (await owner.get(api(`/campaigns/${campaignId}`)).expect(200)).body.data;
      expect(c.stats).toMatchObject({ sent: 1, opened: 1, clicked: 1 });
      const steps = (await owner.get(api(`/campaigns/${campaignId}/step-stats`)).expect(200)).body.data;
      expect(steps[0].messages).toMatchObject({ sent: 1, opened: 1, clicked: 1 });
    });
  });

  describe("unsubscribe", () => {
    it("GET only sends the person to the confirmation page — it never unsubscribes", async () => {
      const url = unsubscribeUrl(base, sent);
      const token = url.slice(url.lastIndexOf("/") + 1);
      const res = await t.http().get(path(url)).expect(302);
      expect(res.headers.location).toBe(`/unsubscribe/${token}`);
      expect(await t.prisma.db.suppression.count({ where: { workspaceId: w } })).toBe(0);
      expect((await t.prisma.db.contact.findFirstOrThrow({ where: { id: adaId, workspaceId: w } })).unsubscribedAt).toBeNull();

      const details = (await t.http().get(`${path(url)}/details`).expect(200)).body.data;
      expect(details).toEqual({ email: "ada@growthdesk.test", senderName: "Sam Sender", senderEmail: "sam@acme.test", workspaceName: "Acme Outreach", suppressed: false });
    });

    it("the page's button opts the recipient out: suppression, contact, enrollments, event, timeline", async () => {
      const res = await t.http().post(path(unsubscribeUrl(base, sent))).send({ via: "page" }).expect(200);
      expect(res.body.data).toEqual({ email: "ada@growthdesk.test", workspaceName: "Acme Outreach", changed: true });

      const suppression = await t.prisma.db.suppression.findFirstOrThrow({ where: { workspaceId: w, kind: "email", value: "ada@growthdesk.test" } });
      expect(suppression).toMatchObject({ reason: "unsubscribed", source: "unsubscribe_page", scope: "outreach" });
      expect(await t.app.get(SuppressionService).check(w, { email: "ada@growthdesk.test" })).toMatch(/do-not-contact/);
      expect((await t.prisma.db.contact.findFirstOrThrow({ where: { id: adaId, workspaceId: w } })).unsubscribedAt).toBeInstanceOf(Date);
      const e = await t.prisma.db.enrollment.findFirstOrThrow({ where: { id: enrollmentId, workspaceId: w } });
      expect(e).toMatchObject({ status: "stopped", stopReason: "Unsubscribed", nextRunAt: null });

      const events = await t.prisma.db.domainEvent.findMany({ where: { workspaceId: w, type: "contact.unsubscribed" } });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ subjectType: "contact", subjectId: adaId });
      expect(events[0]!.payload).toMatchObject({ contactId: adaId, email: "ada@growthdesk.test", messageId: sent, campaignId, via: "unsubscribe_page" });
      const activity = await t.prisma.db.activity.findFirstOrThrow({ where: { workspaceId: w, contactId: adaId, type: "contact.unsubscribed" } });
      expect(activity.summary).toBe("Unsubscribed with the link in an email (ada@growthdesk.test)");
      expect(await t.prisma.db.messageEvent.count({ where: { workspaceId: w, messageId: sent, type: "unsubscribed" } })).toBe(1);
      expect((await t.prisma.db.campaign.findFirstOrThrow({ where: { id: campaignId, workspaceId: w } })).unsubscribeCount).toBe(1);

      const details = (await t.http().get(`${path(unsubscribeUrl(base, sent))}/details`).expect(200)).body.data;
      expect(details.suppressed).toBe(true);
    });

    it("a repeat (or a provider retry) succeeds and changes nothing", async () => {
      const res = await t.http().post(path(unsubscribeUrl(base, sent))).type("form").send("List-Unsubscribe=One-Click").expect(200);
      expect(res.body.data.changed).toBe(false);
      // RFC 8058 also allows multipart/form-data, which is not parsed: still accepted.
      const multipart = await t.http().post(path(unsubscribeUrl(base, sent))).field("List-Unsubscribe", "One-Click").expect(200);
      expect(multipart.body.data.changed).toBe(false);
      expect(await t.prisma.db.domainEvent.count({ where: { workspaceId: w, type: "contact.unsubscribed" } })).toBe(1);
      expect(await t.prisma.db.activity.count({ where: { workspaceId: w, type: "contact.unsubscribed" } })).toBe(1);
    });

    it("RFC 8058 one-click: the mail app's form POST opts out without a page", async () => {
      const res = await t.http().post(path(unsubscribeUrl(base, graceMail))).type("form").send("List-Unsubscribe=One-Click").expect(200);
      expect(res.body.data).toMatchObject({ email: "grace@growthdesk.test", changed: true });
      expect((await t.prisma.db.contact.findFirstOrThrow({ where: { id: graceId, workspaceId: w } })).unsubscribedAt).toBeInstanceOf(Date);
      const activity = await t.prisma.db.activity.findFirstOrThrow({ where: { workspaceId: w, contactId: graceId, type: "contact.unsubscribed" } });
      expect(activity.summary).toBe("Unsubscribed with their mail app's unsubscribe button (grace@growthdesk.test)");
      expect((await t.prisma.db.suppression.findFirstOrThrow({ where: { workspaceId: w, value: "grace@growthdesk.test" } })).source).toBe("one_click");
    });

    it("only touches the workspace that sent the email", async () => {
      expect(await t.prisma.db.suppression.count({ where: { workspaceId: w2 } })).toBe(0);
      expect((await t.prisma.db.contact.findFirstOrThrow({ where: { id: adaElsewhereId, workspaceId: w2 } })).unsubscribedAt).toBeNull();
      expect(await t.prisma.db.domainEvent.count({ where: { workspaceId: w2, type: "contact.unsubscribed" } })).toBe(0);
    });

    it("refuses bad, foreign-kind and unknown tokens", async () => {
      for (const token of ["garbage", trackingToken({ kind: "open", messageId: sent }), trackingToken({ kind: "unsubscribe", messageId: randomUUID() })]) {
        const r = await t.http().post(`/v1/t/u/${token}`).send({ via: "page" }).expect(404);
        expect(r.body.error.code).toBe("not_found");
        await t.http().get(`/v1/t/u/${token}/details`).expect(404);
      }
      await t.http().post(path(unsubscribeUrl(base, sent))).send({ via: "nonsense" }).expect(400);
    });
  });
});
