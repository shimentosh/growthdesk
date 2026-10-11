import { bootApp, createWorkspace, setPlan, signUp, type Agent, type TestApp } from "./helpers.js";
import { DnsResolver } from "../src/marketing/dns.js";
import { MarketingSenderService } from "../src/marketing/sender.service.js";
import { SuppressionService } from "../src/crm/suppression.service.js";
import { marketingToken } from "../src/marketing/tokens.js";

/*
 * The marketing engine end to end: lists and consent (R2), sending setup and
 * the outreach/marketing domain split (R1), a campaign sent through the dev
 * GreenMail SMTP server (127.0.0.1:3925; any address authenticates with
 * itself as the password), tracking, the preference page and one-click
 * unsubscribe (R3), bounce/complaint webhooks and the guardrail (R5).
 */

const SMTP_USER = "esp@growthdesk.test";
const BROWSER = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 Safari/605.1.15";

describe("Marketing engine", () => {
  let t: TestApp;
  let owner: Agent;
  let w: string;
  const api = (p: string) => `/v1/workspaces/${w}/marketing${p}`;
  const ids: Record<string, string> = {};
  let listId: string;
  let domainId: string;
  let campaignId: string;

  const contact = async (key: string, body: Record<string, unknown>) => {
    ids[key] = (await owner.post(`/v1/workspaces/${w}/contacts`).send(body).expect(201)).body.data.id;
    return ids[key]!;
  };

  beforeAll(async () => {
    t = await bootApp();
    owner = await signUp(t, "mkt-engine@acme.test", "Maya Owner");
    w = await createWorkspace(owner, "Newsletter Co");
    await setPlan(t, w, "growth");
    await owner.patch(`/v1/workspaces/${w}`).send({ legalName: "Newsletter Co Ltd", postalAddress: "1 Main St\nSpringfield" }).expect(200);
    await contact("granted", { fullName: "Grace Granted", email: "grace@readers.test", consentStatus: "granted", consentSource: "Web form" });
    await contact("unknown", { fullName: "Uma Unknown", email: "uma@readers.test" });
    await contact("denied", { fullName: "Dan Denied", email: "dan@readers.test", consentStatus: "denied" });
    await contact("suppressed", { fullName: "Sam Suppressed", email: "sam@readers.test", consentStatus: "granted" });
    await contact("other", { fullName: "Olga Other", email: "olga@readers.test", consentStatus: "granted" });
    await owner.post(`/v1/workspaces/${w}/suppressions`).send({ kind: "email", value: "sam@readers.test", scope: "marketing" }).expect(201);
  });
  afterAll(async () => t.close());

  describe("lists and consent", () => {
    it("adds only contacts with consent, and reports why the rest were skipped", async () => {
      listId = (await owner.post(api("/lists")).send({ name: "Newsletter", description: "Monthly news" }).expect(201)).body.data.id;
      const res = await owner.post(api(`/lists/${listId}/members`)).send({ contactIds: [ids.granted, ids.unknown, ids.denied, ids.suppressed, ids.other] }).expect(200);
      expect(res.body.data).toMatchObject({ added: 2, alreadyMember: 0, skipped: { no_consent: 1, consent_denied: 1, suppressed: 1 } });
    });

    it("records consent when the person adding confirms it, but never overrides a refusal", async () => {
      const res = await owner
        .post(api(`/lists/${listId}/members`))
        .send({ contactIds: [ids.unknown, ids.denied], consent: { confirmed: true, source: "Signed up at the booth" } })
        .expect(200);
      expect(res.body.data).toMatchObject({ added: 1, skipped: { consent_denied: 1 } });
      const history = (await owner.get(`/v1/workspaces/${w}/contacts/${ids.unknown}/consent`).expect(200)).body.data;
      expect(history[0]).toMatchObject({ status: "granted", source: "Signed up at the booth", detail: { via: "list_add", listId } });
      const list = (await owner.get(api(`/lists/${listId}`)).expect(200)).body.data;
      expect(list.counts).toEqual({ subscribed: 3, unsubscribed: 0, pending: 0 });
      const lists = (await owner.get(api(`/contacts/${ids.unknown}/lists`)).expect(200)).body.data;
      expect(lists).toMatchObject([{ status: "subscribed", list: { id: listId, name: "Newsletter" } }]);
    });

    it("keeps lists inside their workspace", async () => {
      const other = await signUp(t, "mkt-engine-other@acme.test");
      const w2 = await createWorkspace(other, "Other Co");
      await other.get(`/v1/workspaces/${w2}/marketing/lists/${listId}`).expect(404);
      await other.post(`/v1/workspaces/${w2}/marketing/lists/${listId}/members`).send({ contactIds: [ids.granted] }).expect(404);
    });
  });

  describe("sending setup", () => {
    it("connects the email service after checking its login", async () => {
      // Nothing listens on port 1: the connect test fails and nothing is saved.
      const refused = await owner.put(api("/esp")).send({ provider: "smtp_relay", host: "127.0.0.1", port: 1, security: "none", username: SMTP_USER, password: SMTP_USER }).expect(400);
      expect(refused.body.error.message).toMatch(/Could not sign in to 127\.0\.0\.1/);
      expect((await owner.get(api("/setup")).expect(200)).body.data.esp).toBeNull();
      const res = await owner.put(api("/esp")).send({ provider: "smtp_relay", host: "127.0.0.1", port: 3925, security: "none", username: SMTP_USER, password: SMTP_USER }).expect(200);
      expect(res.body.data).toMatchObject({ provider: "smtp_relay", status: "connected", hasPassword: true });
      expect(res.body.data.webhookUrl).toMatch(/\/api\/m\/hooks\/[A-Za-z0-9_-]+$/);
      expect(res.body.data).not.toHaveProperty("password");
      expect(JSON.stringify(res.body.data)).not.toContain("secretSealed");
    });

    it("refuses a sending domain that an outreach mailbox uses (R1)", async () => {
      await t.prisma.db.mailbox.create({ data: { workspaceId: w, provider: "smtp", email: "rep@outreach-brand.test", smtpHost: "127.0.0.1", smtpPort: 3925 } });
      const res = await owner.post(api("/domains")).send({ domain: "outreach-brand.test" }).expect(400);
      expect(res.body.error.message).toMatch(/used by an outreach mailbox/);
    });

    it("verifies a domain from its DNS records", async () => {
      const added = (await owner.post(api("/domains")).send({ domain: "news.brand.test", dkimSelectors: ["s1"] }).expect(201)).body.data;
      domainId = added.id;
      expect(added.records.ownership).toMatchObject({ type: "TXT", name: "_growthdesk.news.brand.test" });

      const dns = t.app.get(DnsResolver);
      const records: Record<string, string[]> = {};
      const cnames: Record<string, string[]> = {};
      dns.txt = async (name) => records[name] ?? [];
      dns.cname = async (name) => cnames[name] ?? [];

      let checked = (await owner.post(api(`/domains/${domainId}/verify`)).expect(200)).body.data;
      expect(checked.status).toBe("pending");
      expect(checked.checks.ownership.ok).toBe(false);

      records["_growthdesk.news.brand.test"] = [added.records.ownership.value];
      cnames["s1._domainkey.news.brand.test"] = ["s1.dkim.esp.test"];
      records["_dmarc.brand.test"] = ["v=DMARC1; p=none"];
      checked = (await owner.post(api(`/domains/${domainId}/verify`)).expect(200)).body.data;
      expect(checked).toMatchObject({ status: "verified", checks: { ownership: { ok: true }, dkim: { ok: true }, dmarc: { ok: true }, spf: { ok: false, required: false } } });

      // A new DKIM selector is looked up straight away, not left "verified" unchecked.
      const changed = (await owner.patch(api(`/domains/${domainId}`)).send({ dkimSelectors: ["s1", "s2"] }).expect(200)).body.data;
      expect(changed).toMatchObject({ status: "failed", checks: { dkim: { ok: false } } });
      cnames["s2._domainkey.news.brand.test"] = ["s2.dkim.esp.test"];
      expect((await owner.post(api(`/domains/${domainId}/verify`)).expect(200)).body.data.status).toBe("verified");
    });
  });

  describe("campaign", () => {
    it("lists what stops a draft from sending, then becomes ready", async () => {
      campaignId = (await owner.post(api("/campaigns")).send({ name: "October news" }).expect(201)).body.data.id;
      let ready = (await owner.get(api(`/campaigns/${campaignId}/readiness`)).expect(200)).body.data;
      expect(ready.ready).toBe(false);
      expect(ready.problems).toEqual(expect.arrayContaining(["Write a subject line.", "Choose at least one list to send to."]));

      await owner
        .patch(api(`/campaigns/${campaignId}`))
        .send({
          subject: "Hello {{first_name|friend}}",
          fromName: "Newsletter Co",
          fromLocalPart: "news",
          sendingDomainId: domainId,
          audience: { listIds: [listId], excludeListIds: [] },
          blocks: [
            { type: "heading", id: "h", text: "October news", level: 1, align: "left" },
            { type: "text", id: "t", text: "Hi {{first_name}}, read [the post](https://brand.test/post).", align: "left" },
          ],
        })
        .expect(200);
      ready = (await owner.get(api(`/campaigns/${campaignId}/readiness`)).expect(200)).body.data;
      expect(ready).toEqual({ ready: true, problems: [], recipients: 3 });
      expect((await owner.post(api("/audience/count")).send({ listIds: [listId], excludeListIds: [] }).expect(200)).body.data).toEqual({ count: 3 });
    });

    it("sends a test", async () => {
      const res = await owner.post(api(`/campaigns/${campaignId}/test`)).send({ emails: ["me@readers.test"] }).expect(200);
      expect(res.body.data.results).toEqual([{ email: "me@readers.test", sent: true }]);
    });

    it("sends to eligible recipients, re-checking each one right before sending", async () => {
      const res = await owner.post(api(`/campaigns/${campaignId}/send`)).send({}).expect(200);
      expect(res.body.data).toMatchObject({ status: "sending", stats: { recipients: 3 } });
      await owner.patch(api(`/campaigns/${campaignId}`)).send({ subject: "changed" }).expect(409);

      // Olga withdraws consent after the campaign started: she is skipped, not mailed.
      await owner.patch(`/v1/workspaces/${w}/contacts/${ids.other}`).send({ consentStatus: "denied" }).expect(200);

      const sender = t.app.get(MarketingSenderService);
      const batch = await sender.batch(w, campaignId);
      expect(batch).toMatchObject({ sent: 2, processed: 3 });
      await sender.tick();
      const c = (await owner.get(api(`/campaigns/${campaignId}`)).expect(200)).body.data;
      expect(c).toMatchObject({ status: "sent", stats: { recipients: 3, sent: 2, skipped: 1, failed: 0 } });

      const recipients = (await owner.get(api(`/campaigns/${campaignId}/recipients`)).expect(200)).body.data.items;
      expect(recipients.find((r: { email: string }) => r.email === "olga@readers.test")).toMatchObject({ status: "skipped", error: "No marketing consent" });
      const sent = recipients.filter((r: { status: string }) => r.status === "sent");
      expect(sent).toHaveLength(2);
      ids.sendGrace = sent.find((r: { email: string }) => r.email === "grace@readers.test").id;
      ids.sendUma = sent.find((r: { email: string }) => r.email === "uma@readers.test").id;

      const usage = await t.prisma.db.usageCounter.findFirst({ where: { workspaceId: w, metric: "marketing_emails" } });
      expect(usage?.value).toBe(3); // one test + two campaign emails
    });
  });

  describe("tracking and preferences", () => {
    it("records opens and clicks from people, not scanners", async () => {
      await t.prisma.db.marketingSend.updateMany({ where: { workspaceId: w, campaignId }, data: { sentAt: new Date(Date.now() - 60_000) } });
      const open = marketingToken({ kind: "open", sendId: ids.sendGrace! });
      await t.http().get(`/v1/m/o/${open}.gif`).set("user-agent", "curl/8.0").expect(200);
      expect((await t.prisma.db.marketingSend.findFirstOrThrow({ where: { workspaceId: w, id: ids.sendGrace } })).openedAt).toBeNull();
      await t.http().get(`/v1/m/o/${open}.gif`).set("user-agent", BROWSER).expect(200).expect("content-type", "image/gif");

      const click = marketingToken({ kind: "click", sendId: ids.sendUma!, url: "https://brand.test/post" });
      await t.http().get(`/v1/m/c/${click}`).set("user-agent", BROWSER).expect(302).expect("location", "https://brand.test/post");
      await t.http().get(`/v1/m/c/${click}x`).set("user-agent", BROWSER).expect(404);

      await t.app.get(MarketingSenderService).refresh(w, campaignId);
      const c = (await owner.get(api(`/campaigns/${campaignId}`)).expect(200)).body.data;
      expect(c.stats).toMatchObject({ uniqueOpens: 2, uniqueClicks: 1 });
    });

    it("shows and changes a recipient's lists on the preference page", async () => {
      const token = marketingToken({ kind: "preferences", sendId: ids.sendGrace! });
      const details = (await t.http().get(`/v1/m/p/${token}`).expect(200)).body.data;
      expect(details).toEqual({
        email: "grace@readers.test",
        workspaceName: "Newsletter Co",
        legalName: "Newsletter Co Ltd",
        unsubscribedFromAll: false,
        lists: [{ id: listId, name: "Newsletter", description: "Monthly news", subscribed: true }],
      });
      const after = (await t.http().post(`/v1/m/p/${token}`).send({ unsubscribeAll: true }).expect(200)).body.data;
      expect(after).toMatchObject({ unsubscribedFromAll: true, lists: [{ subscribed: false }] });

      const grace = await t.prisma.db.contact.findFirstOrThrow({ where: { workspaceId: w, id: ids.granted } });
      expect(grace.consentStatus).toBe("denied");
      // R3: a marketing unsubscribe never blocks outreach.
      const s = t.app.get(SuppressionService);
      expect(await s.check(w, { email: "grace@readers.test" }, undefined, "marketing")).toMatch(/for marketing/);
      expect(await s.check(w, { email: "grace@readers.test" }, undefined, "outreach")).toBeNull();

      // Re-subscribing on their own page is their own consent.
      const back = (await t.http().post(`/v1/m/p/${token}`).send({ lists: [{ listId, subscribed: true }] }).expect(200)).body.data;
      expect(back).toMatchObject({ unsubscribedFromAll: false, lists: [{ subscribed: true }] });
      expect(await s.check(w, { email: "grace@readers.test" }, undefined, "marketing")).toBeNull();
      expect((await t.prisma.db.contact.findFirstOrThrow({ where: { workspaceId: w, id: ids.granted } })).consentStatus).toBe("granted");
    });

    it("keeps an unsubscribe when the team removes the person, so a re-add cannot bypass it", async () => {
      const token = marketingToken({ kind: "preferences", sendId: ids.sendGrace! });
      await t.http().post(`/v1/m/p/${token}`).send({ lists: [{ listId, subscribed: false }] }).expect(200);
      // Grace still has consent (she left one list, not all marketing).
      expect((await t.prisma.db.contact.findFirstOrThrow({ where: { workspaceId: w, id: ids.granted } })).consentStatus).toBe("granted");
      const removed = (await owner.post(api(`/lists/${listId}/members/remove`)).send({ contactIds: [ids.granted] }).expect(200)).body.data;
      expect(removed).toEqual({ removed: 0, keptUnsubscribed: 1 });
      const readd = (await owner.post(api(`/lists/${listId}/members`)).send({ contactIds: [ids.granted] }).expect(200)).body.data;
      expect(readd).toMatchObject({ added: 0, skipped: { unsubscribed: 1 } });
      // She can still come back on her own.
      await t.http().post(`/v1/m/p/${token}`).send({ lists: [{ listId, subscribed: true }] }).expect(200);
    });

    it("unsubscribes on an RFC 8058 one-click POST, but never on a GET", async () => {
      const token = marketingToken({ kind: "unsubscribe", sendId: ids.sendUma! });
      await t.http().get(`/v1/m/u/${token}`).expect(302).expect("location", `/preferences/${token}`);
      expect((await t.prisma.db.contact.findFirstOrThrow({ where: { workspaceId: w, id: ids.unknown } })).consentStatus).toBe("granted");
      await t.http().post(`/v1/m/u/${token}`).type("form").send("List-Unsubscribe=One-Click").expect(200);
      expect((await t.prisma.db.contact.findFirstOrThrow({ where: { workspaceId: w, id: ids.unknown } })).consentStatus).toBe("denied");
      await t.app.get(MarketingSenderService).refresh(w, campaignId);
      expect((await owner.get(api(`/campaigns/${campaignId}`)).expect(200)).body.data.stats.unsubscribes).toBe(2);
    });

    it("refuses a token that was tampered with", async () => {
      await t.http().get(`/v1/m/p/${marketingToken({ kind: "preferences", sendId: ids.sendGrace! })}A`).expect(404);
      await t.http().get(`/v1/m/p/${marketingToken({ kind: "open", sendId: ids.sendGrace! })}`).expect(404);
    });
  });

  describe("bounces, complaints and the guardrail", () => {
    let hook: string;
    beforeAll(async () => {
      hook = new URL((await owner.get(api("/setup")).expect(200)).body.data.esp.webhookUrl).pathname.replace(/^\/api/, "/v1");
    });

    it("suppresses a permanent bounce for every engine, and ignores a transient one", async () => {
      await t.http().post(hook).send({ type: "bounce", bounceType: "transient", email: "grace@readers.test", sendId: ids.sendGrace }).expect(200);
      expect((await t.prisma.db.marketingSend.findFirstOrThrow({ where: { workspaceId: w, id: ids.sendGrace } })).status).toBe("sent");

      await t.http().post(hook).send({ type: "bounce", email: "grace@readers.test", sendId: ids.sendGrace }).expect(200);
      expect((await t.prisma.db.marketingSend.findFirstOrThrow({ where: { workspaceId: w, id: ids.sendGrace } })).status).toBe("bounced");
      expect((await t.prisma.db.contact.findFirstOrThrow({ where: { workspaceId: w, id: ids.granted } })).bouncedAt).toBeTruthy();
      expect(await t.app.get(SuppressionService).check(w, { email: "grace@readers.test" })).toMatch(/do-not-contact list \(bounced\)/);
    });

    it("handles an Amazon SNS complaint notification", async () => {
      const providerMessageId = (await t.prisma.db.marketingSend.findFirstOrThrow({ where: { workspaceId: w, id: ids.sendUma } })).providerMessageId;
      const message = JSON.stringify({ notificationType: "Complaint", complaint: { complainedRecipients: [{ emailAddress: "uma@readers.test" }] }, mail: { messageId: providerMessageId } });
      const res = await t.http().post(hook).set("content-type", "text/plain; charset=UTF-8").send(JSON.stringify({ Type: "Notification", Message: message })).expect(200);
      expect(res.body.data).toEqual({ handled: 1 });
      expect((await t.prisma.db.marketingSend.findFirstOrThrow({ where: { workspaceId: w, id: ids.sendUma } })).status).toBe("complained");
      await t.http().post("/v1/m/hooks/not-a-real-token").send({ type: "bounce", email: "x@readers.test" }).expect(404);
    });

    it("pauses the sending domain when bounces run high (R5)", async () => {
      await t.prisma.db.marketingCampaign.update({ where: { id: campaignId, workspaceId: w }, data: { sentCount: 100, bounceCount: 3 } });
      await t.app.get(MarketingSenderService).guardrail(w, campaignId);
      const setup = (await owner.get(api("/setup")).expect(200)).body.data;
      expect(setup.domains[0].pausedReason).toMatch(/Bounce rate 3\.0%/);

      const next = (await owner.post(api(`/campaigns/${campaignId}/duplicate`)).expect(201)).body.data;
      const ready = (await owner.get(api(`/campaigns/${next.id}/readiness`)).expect(200)).body.data;
      expect(ready.problems.join(" ")).toMatch(/paused/);
      await owner.patch(api(`/domains/${domainId}`)).send({ paused: false }).expect(200);
      expect((await owner.get(api("/setup")).expect(200)).body.data.domains[0].pausedAt).toBeNull();
    });
  });

  describe("permissions and plans", () => {
    it("needs the marketing feature", async () => {
      await setPlan(t, w, "free");
      await t.prisma.db.plan.update({ where: { key: "free" }, data: { features: { marketing: false } } });
      await owner.post(api("/lists")).send({ name: "Blocked" }).expect(402);
      await t.prisma.db.plan.update({ where: { key: "free" }, data: { features: { marketing: true, calling: true, ai: true } } });
      await setPlan(t, w, "growth");
    });
  });
});
