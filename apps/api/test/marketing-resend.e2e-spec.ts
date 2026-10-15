import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { bootApp, createWorkspace, setPlan, signUp, type Agent, type TestApp } from "./helpers.js";
import { DnsResolver } from "../src/marketing/dns.js";
import { MarketingSenderService } from "../src/marketing/sender.service.js";
import { SuppressionService } from "../src/crm/suppression.service.js";

/*
 * Resend as the marketing email service, against a fake Resend API
 * (RESEND_API_URL): the key check, a domain created there with the records it
 * asks for, verification (Resend's records + our DMARC lookup), a campaign
 * sent through POST /emails with the send id as idempotency key, and a
 * Resend bounce webhook matched back to the send by Resend's email id.
 */

const FULL = "re_fullaccess_e2e";
const SENDING_ONLY = "re_sendingonly_e2e";

describe("Marketing through Resend", () => {
  let t: TestApp;
  let owner: Agent;
  let w: string;
  let fake: Server;
  let verified = false;
  let emailSeq = 0;
  const emails: { idempotency: string; body: Record<string, unknown> }[] = [];
  const api = (p: string) => `/v1/workspaces/${w}/marketing${p}`;
  let domainId: string;
  let listId: string;
  let campaignId: string;

  const read = (req: IncomingMessage) =>
    new Promise<string>((resolve) => {
      let b = "";
      req.on("data", (c) => (b += c));
      req.on("end", () => resolve(b));
    });

  beforeAll(async () => {
    fake = createServer(async (req, res) => {
      const raw = await read(req);
      const body = raw ? JSON.parse(raw) : null;
      const send = (status: number, json: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(json));
      };
      if (req.headers.authorization === `Bearer ${SENDING_ONLY}`) return send(401, { name: "restricted_api_key", message: "This API key is restricted to only send emails" });
      if (req.headers.authorization !== `Bearer ${FULL}`) return send(403, { name: "validation_error", message: "API key is invalid" });
      const status = verified ? "verified" : "not_started";
      const domain = {
        id: "dom_1",
        name: "news.brand.test",
        status,
        region: "eu-west-1",
        records: [
          { record: "SPF", name: "send.news", type: "MX", ttl: "Auto", status, value: "feedback-smtp.eu-west-1.amazonses.com", priority: 10 },
          { record: "SPF", name: "send.news", type: "TXT", ttl: "Auto", status, value: "v=spf1 include:amazonses.com ~all" },
          { record: "DKIM", name: "resend._domainkey.news", type: "TXT", ttl: "Auto", status, value: "p=MIGfMA0GCSq" },
        ],
      };
      if (req.method === "GET" && req.url === "/domains") return send(200, { object: "list", data: [] });
      if (req.method === "POST" && req.url === "/domains") return send(200, { ...domain, name: body.name, region: body.region });
      if (req.method === "POST" && req.url === "/domains/dom_1/verify") {
        verified = true;
        return send(200, { object: "domain", id: "dom_1" });
      }
      if (req.method === "GET" && req.url === "/domains/dom_1") return send(200, domain);
      if (req.method === "POST" && req.url === "/emails") {
        emails.push({ idempotency: String(req.headers["idempotency-key"] ?? ""), body });
        return send(200, { id: `email_${++emailSeq}` });
      }
      send(404, { name: "not_found" });
    });
    await new Promise<void>((r) => fake.listen(0, "127.0.0.1", r));
    process.env.RESEND_API_URL = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;

    t = await bootApp();
    owner = await signUp(t, "mkt-resend@acme.test", "Rita Owner");
    w = await createWorkspace(owner, "Resend Co");
    await setPlan(t, w, "growth");
    await owner.patch(`/v1/workspaces/${w}`).send({ legalName: "Resend Co Ltd", postalAddress: "2 Main St\nSpringfield" }).expect(200);
  });
  afterAll(async () => {
    delete process.env.RESEND_API_URL;
    fake.close();
    await t.close();
  });

  it("asks for a Full access key, then connects", async () => {
    const restricted = await owner.put(api("/esp")).send({ provider: "resend", region: "eu-west-1", apiKey: SENDING_ONLY }).expect(400);
    expect(restricted.body.error.message).toMatch(/Full access/);
    await owner.put(api("/esp")).send({ provider: "resend", region: "eu-west-1", apiKey: "nope" }).expect(400);

    const res = await owner.put(api("/esp")).send({ provider: "resend", region: "eu-west-1", apiKey: FULL }).expect(200);
    expect(res.body.data).toMatchObject({ provider: "resend", region: "eu-west-1", hasPassword: true, status: "connected" });
    // Saving again without a key keeps the stored one.
    await owner.put(api("/esp")).send({ provider: "resend", region: "eu-west-1" }).expect(200);
  });

  it("creates the domain at Resend and shows the records it asks for", async () => {
    const added = (await owner.post(api("/domains")).send({ domain: "news.brand.test" }).expect(201)).body.data;
    domainId = added.id;
    expect(added.dkimSelectors).toEqual(["resend"]);
    expect(added.esp.status).toBe("not_started");
    expect(added.esp.records.map((r: { record: string; type: string; name: string }) => `${r.record} ${r.type} ${r.name}`)).toEqual([
      "SPF MX send.news",
      "SPF TXT send.news",
      "DKIM TXT resend._domainkey.news",
    ]);
  });

  it("verifies through Resend, and still needs DMARC", async () => {
    const dns = t.app.get(DnsResolver);
    const records: Record<string, string[]> = {};
    dns.txt = async (name) => records[name] ?? [];
    dns.cname = async () => [];

    let checked = (await owner.post(api(`/domains/${domainId}/verify`)).expect(200)).body.data;
    expect(checked).toMatchObject({ status: "pending", checks: { ownership: { ok: true }, dkim: { ok: true }, spf: { ok: true }, dmarc: { ok: false } }, esp: { status: "verified" } });

    records["_dmarc.brand.test"] = ["v=DMARC1; p=none"];
    checked = (await owner.post(api(`/domains/${domainId}/verify`)).expect(200)).body.data;
    expect(checked.status).toBe("verified");
  });

  it("sends a campaign through POST /emails, one idempotency key per send", async () => {
    const granted = (await owner.post(`/v1/workspaces/${w}/contacts`).send({ fullName: "Gia Granted", email: "gia@readers.test", consentStatus: "granted", consentSource: "Web form" }).expect(201)).body.data.id;
    listId = (await owner.post(api("/lists")).send({ name: "News" }).expect(201)).body.data.id;
    await owner.post(api(`/lists/${listId}/members`)).send({ contactIds: [granted] }).expect(200);
    campaignId = (await owner.post(api("/campaigns")).send({ name: "Launch" }).expect(201)).body.data.id;
    await owner
      .patch(api(`/campaigns/${campaignId}`))
      .send({
        subject: "Hello {{first_name|friend}}",
        fromName: "Resend Co",
        fromLocalPart: "news",
        sendingDomainId: domainId,
        audience: { listIds: [listId], excludeListIds: [] },
        blocks: [{ type: "text", id: "t", text: "Hi {{first_name}}", align: "left" }],
      })
      .expect(200);
    await owner.post(api(`/campaigns/${campaignId}/send`)).send({}).expect(200);
    expect(await t.app.get(MarketingSenderService).batch(w, campaignId)).toMatchObject({ sent: 1 });

    const mail = emails.at(-1)!;
    expect(mail.body).toMatchObject({ from: expect.stringContaining("news@news.brand.test"), to: ["gia@readers.test"], subject: "Hello Gia" });
    const send = await t.prisma.db.marketingSend.findFirstOrThrow({ where: { workspaceId: w, campaignId } });
    expect(mail.idempotency).toBe(send.id);
    expect((mail.body.headers as Record<string, string>)["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    expect(send).toMatchObject({ status: "sent", providerMessageId: `email_${emailSeq}` });
  });

  it("matches a Resend bounce webhook to the send by Resend's email id", async () => {
    const hook = new URL((await owner.get(api("/setup")).expect(200)).body.data.esp.webhookUrl).pathname.replace(/^\/api/, "/v1");
    const send = await t.prisma.db.marketingSend.findFirstOrThrow({ where: { workspaceId: w, campaignId } });

    expect((await t.http().post(hook).send({ type: "email.delivered", data: { email_id: send.providerMessageId, to: ["gia@readers.test"] } }).expect(200)).body.data).toEqual({ handled: 0 });
    await t.http().post(hook).send({ type: "email.bounced", data: { email_id: send.providerMessageId, to: ["gia@readers.test"], bounce: { type: "Transient" } } }).expect(200);
    expect((await t.prisma.db.marketingSend.findFirstOrThrow({ where: { id: send.id, workspaceId: w } })).status).toBe("sent");

    const res = await t.http().post(hook).send({ type: "email.bounced", data: { email_id: send.providerMessageId, to: ["gia@readers.test"], bounce: { type: "Permanent" } } }).expect(200);
    expect(res.body.data).toEqual({ handled: 1 });
    expect((await t.prisma.db.marketingSend.findFirstOrThrow({ where: { id: send.id, workspaceId: w } })).status).toBe("bounced");
    expect(await t.app.get(SuppressionService).check(w, { email: "gia@readers.test" })).toMatch(/bounced/);
  });
});
