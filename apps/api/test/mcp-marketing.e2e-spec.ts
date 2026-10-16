import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { bootApp, createWorkspace, setPlan, signUp, type Agent, type TestApp } from "./helpers.js";
import { startFakeSmtp, type FakeSmtp } from "./fake-smtp.js";
import { DnsResolver } from "../src/marketing/dns.js";
import { MarketingCampaignsService } from "../src/marketing/campaigns.service.js";
import { MarketingSenderService } from "../src/marketing/sender.service.js";
import { LibrarySeedService } from "../src/workspaces/library-seed.service.js";

/*
 * The email marketing MCP tools end to end, through the SDK client: setup
 * status, a list filled by email address, a design from the template library,
 * preview, a campaign, readiness, a test email (caught by the fake SMTP
 * server the ESP points at), scheduling through the two-step confirmation
 * (a Build token prepares but cannot confirm; a Send token confirms; an edit
 * after preparing voids it), the send and its report, and the guarded
 * list/suppression actions.
 */

const OWNER = "mcp-mkt-owner@acme.test";

const text = (r: unknown) => ((r as CallToolResult).content[0] as { text: string }).text;
const data = (r: unknown) => JSON.parse(text(r)) as Record<string, any>;
const idOf = (r: unknown) => (r as CallToolResult).structuredContent!.confirmationId as string;

describe("MCP marketing tools", () => {
  let t: TestApp;
  let smtp: FakeSmtp;
  let owner: Agent;
  let w: string;
  let url: string;
  const clients: Client[] = [];
  const tokens: Record<"read" | "build" | "send", string> = { read: "", build: "", send: "" };
  let reader: Client;
  let builder: Client;
  let sender: Client;
  let listId: string;
  let designId: string;
  let campaignId: string;

  const api = (p: string) => `/v1/workspaces/${w}${p}`;

  async function connect(secret: string) {
    const client = new Client({ name: "growthdesk-mkt-e2e", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${secret}` } } }));
    clients.push(client);
    return client;
  }

  const call = async (client: Client, name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args });
    if (r.isError) throw new Error(`${name} failed: ${text(r)}`);
    return r;
  };

  beforeAll(async () => {
    smtp = await startFakeSmtp();
    t = await bootApp();
    await t.app.listen(0, "127.0.0.1");
    url = `http://127.0.0.1:${(t.app.getHttpServer().address() as AddressInfo).port}/mcp`;
    await t.app.get(LibrarySeedService).ensureBuiltInDesigns();
    owner = await signUp(t, OWNER, "Mira Owner");
    w = await createWorkspace(owner, "MCP Newsletter Co");
    await setPlan(t, w, "growth");
    await owner.patch(`/v1/workspaces/${w}`).send({ legalName: "MCP Newsletter Co Ltd", postalAddress: "1 Main St\nSpringfield" }).expect(200);

    // Sending setup through the app: the ESP is the fake SMTP server, the domain verified with faked DNS.
    await owner.put(api("/marketing/esp")).send({ provider: "smtp_relay", host: "127.0.0.1", port: smtp.port, security: "none", username: "esp@mcp.test", password: "secret" }).expect(200);
    const domain = (await owner.post(api("/marketing/domains")).send({ domain: "news.mcpbrand.test", dkimSelectors: ["s1"] }).expect(201)).body.data;
    const dns = t.app.get(DnsResolver);
    const txt: Record<string, string[]> = { "_growthdesk.news.mcpbrand.test": [domain.records.ownership.value], "_dmarc.mcpbrand.test": ["v=DMARC1; p=none"] };
    const cname: Record<string, string[]> = { "s1._domainkey.news.mcpbrand.test": ["s1.dkim.esp.test"] };
    dns.txt = async (n) => txt[n] ?? [];
    dns.cname = async (n) => cname[n] ?? [];
    expect((await owner.post(api(`/marketing/domains/${domain.id}/verify`)).expect(200)).body.data.status).toBe("verified");

    for (const [name, email] of [["Ann Reader", "ann@readers.test"], ["Ben Reader", "ben@readers.test"], ["Cat Reader", "cat@readers.test"]]) {
      await owner.post(api("/contacts")).send({ fullName: name, email, consentStatus: "granted", consentSource: "Web form" }).expect(201);
    }
    await owner.post(api("/contacts")).send({ fullName: "Vic Vip", email: "vic@readers.test", tags: ["vip"] }).expect(201);

    for (const access of ["read", "build", "send"] as const) {
      tokens[access] = (await owner.post(api("/mcp/tokens")).send({ name: `MKT ${access}`, access }).expect(201)).body.data.secret;
    }
    reader = await connect(tokens.read);
    builder = await connect(tokens.build);
    sender = await connect(tokens.send);
  });

  afterAll(async () => {
    await Promise.all(clients.map((c) => c.close().catch(() => undefined)));
    await t.close();
    await smtp.close();
  });

  it("lists marketing tools by access level", async () => {
    const names = async (c: Client) => (await c.listTools()).tools.map((x) => x.name);
    const read = await names(reader);
    expect(read).toEqual(expect.arrayContaining(["marketing_setup_status", "list_lists", "get_design", "marketing_campaign_report", "list_suppressions"]));
    expect(read).not.toContain("create_list");
    const build = await names(builder);
    expect(build).toEqual(expect.arrayContaining(["create_list", "add_to_list", "bulk_add_to_list", "create_design", "schedule_marketing_campaign"]));
    // marketing.send is a Send-token permission: test sends and pausing are not offered to a Build token.
    expect(build).not.toContain("send_test_email");
    expect(await names(sender)).toEqual(expect.arrayContaining(["send_test_email", "pause_marketing_campaign"]));
    const prompts = (await builder.listPrompts()).prompts.map((p) => p.name);
    expect(prompts).toEqual(expect.arrayContaining(["plan_newsletter", "campaign_report_summary"]));
  });

  it("marketing_setup_status: ready, with the domain and allowances", async () => {
    const s = data(await call(reader, "marketing_setup_status"));
    expect(s).toMatchObject({ readyToSend: true, missing: [], emailService: { provider: "smtp_relay", status: "connected" }, doubleOptIn: { ready: true } });
    expect(s.sendingDomains).toEqual([expect.objectContaining({ domain: "news.mcpbrand.test", status: "verified" })]);
    expect(s.allowances.marketingEmailsThisMonth).toMatchObject({ used: 0 });
  });

  it("creates a list and adds people by email", async () => {
    listId = data(await call(builder, "create_list", { name: "MCP Newsletter", description: "Monthly" })).id;
    const added = data(await call(builder, "add_to_list", { listId, emails: ["ann@readers.test", "BEN@readers.test", "cat@readers.test", "nobody@readers.test"] }));
    expect(added).toMatchObject({ list: { id: listId }, added: 3, alreadyMember: 0, unknownEmails: ["nobody@readers.test"] });
    const byFilter = data(await call(builder, "add_to_list", { listId, filter: { tag: ["vip"] } }));
    expect(byFilter).toMatchObject({ added: 1 });
    const list = data(await call(reader, "get_list", { listId }));
    expect(list.members).toEqual({ subscribed: 4, unsubscribed: 0, pending: 0 });
    const members = data(await call(reader, "list_list_members", { listId, limit: 2 }));
    expect(members).toMatchObject({ total: 4, hasMore: true, nextPage: 2 });
  });

  it("bulk_add_to_list and remove_from_list only prepare", async () => {
    const bulk = await call(builder, "bulk_add_to_list", { listId, emails: ["ann@readers.test"] });
    expect(text(bulk)).toMatch(/CONFIRMATION NEEDED/);
    expect(text(bulk)).toMatch(/Add up to 1 contacts to the list "MCP Newsletter" \(1 are already subscribed\)/);
    const remove = await call(sender, "remove_from_list", { listId, filter: { tag: ["vip"] } });
    expect(text(remove)).toMatch(/Remove 1 people from the list "MCP Newsletter"/);
    await call(sender, "confirm_action", { confirmationId: idOf(remove) });
    expect(data(await call(reader, "get_list", { listId })).members.subscribed).toBe(3);
  });

  it("creates a design from the library, edits it and previews it", async () => {
    const templates = data(await call(reader, "list_design_templates")).items as { templateId: string; name: string }[];
    expect(templates.length).toBeGreaterThan(0);
    const d = data(await call(builder, "create_design", { templateId: templates[0]!.templateId, name: "October issue" }));
    designId = d.id;
    expect(d).toMatchObject({ name: "October issue", problems: [] });
    const firstId = d.blocks[0].id as string;
    const edited = data(
      await call(builder, "update_design", {
        designId,
        theme: { accent: "#ff5500" },
        blockOps: [{ op: "insert", block: { type: "text", text: "Hi {{first_name|there}}, this came from Claude." }, afterId: firstId }],
      }),
    );
    expect(edited.theme.accent).toBe("#ff5500");
    expect(edited.blocks[1]).toMatchObject({ type: "text", text: "Hi {{first_name|there}}, this came from Claude." });

    const bad = await builder.callTool({ name: "update_design", arguments: { designId, blockOps: [{ op: "update", id: edited.blocks[1].id, fields: { align: "diagonal" } }] } });
    expect(bad.isError).toBe(true);
    expect(text(bad)).toMatch(/blocks\.1\.align/);

    const preview = data(await call(reader, "preview_design", { designId }));
    expect(preview.problems).toEqual([]);
    expect(preview.text).toContain("Hi Alex, this came from Claude.");
    expect(preview.text).toContain("MCP Newsletter Co Ltd");
    expect(preview.htmlBytes).toBeGreaterThan(1000);
    expect(preview).not.toHaveProperty("html");
  });

  it("creates a campaign and checks it is ready", async () => {
    const c = data(
      await call(builder, "create_marketing_campaign", {
        name: "October news",
        subject: "October at MCP Newsletter Co",
        preheader: "What's new",
        fromName: "MCP Newsletter",
        fromEmail: "hello@news.mcpbrand.test",
        designId,
        listIds: [listId],
      }),
    );
    campaignId = c.id;
    expect(c).toMatchObject({ status: "draft", from: "MCP Newsletter <hello@news.mcpbrand.test>", audience: { lists: [{ id: listId, name: "MCP Newsletter" }] }, readiness: { ready: true, recipients: 3 } });
    expect(data(await call(reader, "marketing_campaign_readiness", { campaignId }))).toEqual({ ready: true, problems: [], recipients: 3 });

    const unknownDomain = await builder.callTool({ name: "update_marketing_campaign", arguments: { campaignId, fromEmail: "x@elsewhere.test" } });
    expect(text(unknownDomain)).toMatch(/elsewhere\.test is not one of this workspace's sending domains/);
  });

  it("send_test_email goes to the connected user by default", async () => {
    const before = smtp.accepted.length;
    const r = data(await call(sender, "send_test_email", { campaignId }));
    expect(r.results).toEqual([{ email: OWNER, sent: true }]);
    expect(r.note).toMatch(/count against the monthly marketing email allowance/);
    expect(smtp.accepted.slice(before)).toEqual([OWNER]);
    const tooMany = await sender.callTool({ name: "send_test_email", arguments: { campaignId, emails: ["a@x.test", "b@x.test", "c@x.test", "d@x.test", "e@x.test", "f@x.test"] } });
    expect(tooMany.isError).toBe(true);
    const fromBuilder = await builder.callTool({ name: "send_test_email", arguments: { campaignId } });
    expect(text(fromBuilder)).toMatch(/does not include marketing\.send/);
  });

  it("schedules only after a Send token confirms what the user saw", async () => {
    const at = new Date(Date.now() + 3 * 60 * 60_000);
    at.setUTCSeconds(0, 0);
    const scheduledAt = at.toISOString();

    const tooSoon = await builder.callTool({ name: "schedule_marketing_campaign", arguments: { campaignId, scheduledAt: new Date(Date.now() + 30_000).toISOString() } });
    expect(text(tooSoon)).toMatch(/at least 2 minutes/);

    // A Build token prepares; confirming is refused.
    const prepared = await call(builder, "schedule_marketing_campaign", { campaignId, scheduledAt });
    expect(text(prepared)).toMatch(/CONFIRMATION NEEDED — nothing has happened yet/);
    expect(text(prepared)).toMatch(/Schedule the email campaign "October news" to 3 people \(lists: MCP Newsletter\)/);
    expect(text(prepared)).toMatch(/From: MCP Newsletter <hello@news\.mcpbrand\.test>/);
    expect((prepared as CallToolResult).structuredContent).toMatchObject({ canConfirm: false, details: { recipients: 3, scheduledAt } });
    const refused = await builder.callTool({ name: "confirm_action", arguments: { confirmationId: idOf(prepared) } });
    expect(text(refused)).toMatch(/can't send — .*Send token/);
    expect(data(await call(reader, "get_marketing_campaign", { campaignId })).status).toBe("draft");

    // An edit after preparing voids the prepared action.
    const stale = await call(sender, "schedule_marketing_campaign", { campaignId, scheduledAt });
    await call(builder, "update_marketing_campaign", { campaignId, subject: "October at MCP Newsletter Co!" });
    const voided = await sender.callTool({ name: "confirm_action", arguments: { confirmationId: idOf(stale) } });
    expect(voided.isError).toBe(true);
    expect(text(voided)).toMatch(/was changed after this action was prepared/);

    const fresh = await call(sender, "schedule_marketing_campaign", { campaignId, scheduledAt });
    expect(text(fresh)).toMatch(/Subject: "October at MCP Newsletter Co!"/);
    const done = data(await call(sender, "confirm_action", { confirmationId: idOf(fresh) }));
    expect(done).toMatchObject({ done: true, tool: "schedule_marketing_campaign", result: { status: "scheduled", scheduledAt } });
    const c = data(await call(reader, "get_marketing_campaign", { campaignId }));
    expect(c).toMatchObject({ status: "scheduled", scheduledAt });
    expect(await t.prisma.db.auditEvent.count({ where: { workspaceId: w, action: "marketing.campaign_scheduled", targetId: campaignId } })).toBe(1);

    const again = await sender.callTool({ name: "send_marketing_campaign_now", arguments: { campaignId } });
    expect(text(again)).toMatch(/already scheduled/);
  });

  it("reports on the campaign once it has gone out", async () => {
    await t.app.get(MarketingCampaignsService).start(w, campaignId);
    await t.app.get(MarketingSenderService).batch(w, campaignId);
    await t.app.get(MarketingSenderService).tick();
    expect(smtp.accepted).toEqual(expect.arrayContaining(["ann@readers.test", "ben@readers.test", "cat@readers.test"]));

    const r = data(await call(reader, "marketing_campaign_report", { campaignId }));
    expect(r.campaign).toMatchObject({ id: campaignId, status: "sent" });
    expect(r.numbers).toMatchObject({ recipients: 3, sent: 3, delivered: 3, bounces: 0 });
    expect(r.rates.open).toBe("0.0%");
    expect(r.recipientsByStatus).toEqual({ sent: 3 });

    const rec = data(await call(reader, "list_campaign_recipients", { campaignId, status: "sent", limit: 2 }));
    expect(rec).toMatchObject({ total: 3, hasMore: true });
    expect(rec.items[0]).toMatchObject({ status: "sent", email: expect.stringMatching(/@readers\.test$/) });

    const del = await call(sender, "delete_marketing_campaign", { campaignId });
    expect(text(del)).toMatch(/Delete the sent campaign "October news" \(sent to 3 people/);
    await call(sender, "cancel_action", { confirmationId: idOf(del) });
  });

  it("suppressions: add, list, and remove only with approval", async () => {
    const added = data(await call(builder, "add_suppression", { kind: "email", value: "Gone@Readers.test", scope: "marketing" }));
    expect(added).toMatchObject({ value: "gone@readers.test", scope: "marketing", reason: "manual" });
    const listed = data(await call(reader, "list_suppressions", { search: "gone@" }));
    expect(listed.items).toEqual([expect.objectContaining({ id: added.id, value: "gone@readers.test" })]);
    const removing = await call(sender, "remove_suppression", { suppressionId: added.id });
    expect(text(removing)).toMatch(/Remove gone@readers\.test \(email, scope marketing/);
    expect(await t.prisma.db.suppression.count({ where: { workspaceId: w, id: added.id } })).toBe(1);
    await call(sender, "confirm_action", { confirmationId: idOf(removing) });
    expect(await t.prisma.db.suppression.count({ where: { workspaceId: w, id: added.id } })).toBe(0);
  });

  it("archive_list waits for approval", async () => {
    const r = await call(builder, "archive_list", { listId });
    expect(text(r)).toMatch(/Archive the list "MCP Newsletter"/);
    expect(data(await call(reader, "get_list", { listId })).archived).toBe(false);
  });
});
