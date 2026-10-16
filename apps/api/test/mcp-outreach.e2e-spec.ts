import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { startFakeSmtp, type FakeSmtp } from "./fake-smtp.js";
import { bootApp, createWorkspace, setPlan, signUp, type Agent, type TestApp } from "./helpers.js";

/*
 * The outreach MCP tools end to end through the SDK client: mailboxes,
 * templates, a sequence, an always-on campaign built and checked by a Build
 * token, a test send caught by the fake SMTP server, and the important
 * actions (launch, enroll, resume) that only a Send token can confirm.
 */

const ALWAYS_OPEN = { timezone: "UTC", days: [0, 1, 2, 3, 4, 5, 6], from: "00:00", to: "00:00" };

const text = (r: unknown) => ((r as CallToolResult).content[0] as { text: string }).text;
const data = (r: unknown) => JSON.parse(text(r)) as Record<string, any>;
const confirmationOf = (r: unknown) => (r as CallToolResult).structuredContent!.confirmationId as string;

describe("MCP outreach tools", () => {
  let t: TestApp;
  let smtp: FakeSmtp;
  let owner: Agent;
  let w: string;
  let url: string;
  let builder: Client;
  let sender: Client;
  let mailboxId: string;
  let templateId: string;
  let sequenceId: string;
  let campaignId: string;
  const contacts: Record<string, string> = {};
  const clients: Client[] = [];

  const api = (path: string) => `/v1/workspaces/${w}${path}`;

  async function connect(access: "build" | "send", name: string) {
    const tok = (await owner.post(api("/mcp/tokens")).send({ name, access }).expect(201)).body.data as { secret: string };
    const client = new Client({ name: "growthdesk-e2e", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${tok.secret}` } } }));
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
    owner = await signUp(t, "out-owner@acme.test", "Olive Owner");
    w = await createWorkspace(owner, "Outreach MCP Co");
    await setPlan(t, w, "growth");
    builder = await connect("build", "Builder");
    sender = await connect("send", "Sender");
    mailboxId = (
      await owner
        .post(api("/mailboxes/smtp"))
        .send({ email: "sam@fake.test", displayName: "Sam Sender", smtpHost: "127.0.0.1", smtpPort: smtp.port, smtpSecurity: "none", smtpUser: "sam@fake.test", password: "secret", imapEnabled: false, minDelaySeconds: 0 })
        .expect(201)
    ).body.data.id;
    for (const [key, body] of Object.entries({
      ada: { firstName: "Ada", lastName: "Lovelace", email: "ada@prospect.test" },
      grace: { firstName: "Grace", lastName: "Hopper", email: "grace@prospect.test" },
    })) {
      contacts[key] = (await owner.post(api("/contacts")).send(body).expect(201)).body.data.id;
    }
  });
  afterAll(async () => {
    await Promise.all(clients.map((c) => c.close().catch(() => undefined)));
    await t.close();
    await smtp.close();
  });

  it("lists the tools by access level", async () => {
    const build = (await builder.listTools()).tools.map((x) => x.name);
    expect(build).toEqual(expect.arrayContaining(["list_mailboxes", "create_campaign", "launch_campaign", "enroll_contacts", "send_test_step"]));
    // Pausing needs campaigns.launch, which only a Send token holds.
    expect(build).not.toContain("pause_campaign");
    const send = (await sender.listTools()).tools;
    expect(send.map((x) => x.name)).toContain("pause_campaign");
    expect(send.find((x) => x.name === "launch_campaign")!.description).toMatch(/IMPORTANT ACTION/);
    const prompts = (await sender.listPrompts()).prompts.map((p) => p.name);
    expect(prompts).toEqual(expect.arrayContaining(["build_cold_sequence", "outreach_report"]));
  });

  it("list_mailboxes and channel_status", async () => {
    const boxes = data(await call(builder, "list_mailboxes", { checkDns: false }));
    expect(boxes.items).toEqual([
      expect.objectContaining({ id: mailboxId, email: "sam@fake.test", status: "connected", dailyLimit: 50, sentToday: 0, replyTracking: expect.objectContaining({ on: false }) }),
    ]);
    expect(boxes.items[0].replyTracking.problem).toMatch(/Reply tracking \(IMAP\) is off/);
    expect(data(await call(builder, "channel_status"))).toMatchObject({ whatsapp: false, telegram: false });
  });

  it("templates and a library sequence", async () => {
    const ref = data(await call(builder, "get_step_reference"));
    expect(ref.variables.standard).toContain("{{first_name}}");

    const tpl = data(await call(builder, "create_template", { name: "Opener", subject: "Quick question, {{first_name|there}}", body: "Hi {{first_name|there}}, are you the right person at {{company|your team}}?" }));
    templateId = tpl.id;
    expect(tpl).toMatchObject({ channel: "email", version: 1 });
    expect(data(await call(builder, "list_templates", { search: "opener" })).items.map((x: { id: string }) => x.id)).toEqual([templateId]);

    const bad = await builder.callTool({ name: "create_sequence", arguments: { name: "Bad", steps: [{ type: "email", config: { subject: "Hi {{favourite_colour}}", body: "x" } }] } });
    expect(bad.isError).toBe(true);
    expect(text(bad)).toMatch(/Unknown personalization/);

    const seq = data(
      await call(builder, "create_sequence", {
        name: "Two touch",
        steps: [
          { type: "email", config: { templateId } },
          { type: "wait", config: { delayMinutes: 2880 } },
          { type: "email", config: { body: "Bumping this, {{first_name|there}}." } },
        ],
      }),
    );
    sequenceId = seq.id;
    expect(seq.stepCount).toBe(3);
    expect(seq.outline).toMatch(/wait 2d/);
  });

  it("builds an always-on campaign as a draft and checks its readiness", async () => {
    const c = data(
      await call(builder, "create_campaign", {
        name: "Inbound leads",
        fromSequenceId: sequenceId,
        audience: { type: "contacts", contactIds: [contacts.ada] },
        schedule: ALWAYS_OPEN,
        settings: { keepOpen: true, dailyNewLimit: 20, gapSeconds: 0 },
        mailboxIds: [mailboxId],
      }),
    );
    campaignId = c.id;
    expect(c).toMatchObject({ status: "draft", alwaysOn: true, stepCount: 3, mailboxes: [{ id: mailboxId, email: "sam@fake.test", status: "connected" }] });
    expect(c.settings).toMatchObject({ keepOpen: true, dailyNewLimit: 20, stopOnReply: true });

    // Settings merge: only what is given changes.
    const s = data(await call(builder, "update_campaign_settings", { campaignId, settings: { trackOpens: false, dailyNewLimit: 25 } }));
    expect(s.settings).toMatchObject({ keepOpen: true, dailyNewLimit: 25 });

    const r = data(await call(builder, "campaign_readiness", { campaignId }));
    expect(r.ready).toBe(true);
    expect(r.audience).toMatchObject({ candidates: 1, eligible: 1 });
    expect(r.warnings.join(" ")).toMatch(/Reply tracking/);

    const got = data(await call(builder, "get_campaign", { campaignId }));
    expect(got.next).toMatch(/launch_campaign/);
    expect(got.steps.map((x: { type: string }) => x.type)).toEqual(["email", "wait", "email"]);
  });

  it("send_test_step mails the token's person, and only the team", async () => {
    const r = data(await call(builder, "send_test_step", { campaignId, position: 0, contactId: contacts.ada }));
    expect(r.results).toEqual([expect.objectContaining({ sent: true, to: "out-owner@acme.test", from: "sam@fake.test", missing: [] })]);
    expect(smtp.accepted).toContain("out-owner@acme.test");

    const outside = await builder.callTool({ name: "send_test_step", arguments: { campaignId, position: 0, to: ["stranger@else.test"] } });
    expect(outside.isError).toBe(true);
    expect(text(outside)).toMatch(/only to workspace members/);
    expect(smtp.accepted).not.toContain("stranger@else.test");
  });

  it("launch needs a confirmation that only a Send token can give", async () => {
    const prepared = await call(builder, "launch_campaign", { campaignId });
    expect(text(prepared)).toMatch(/CONFIRMATION NEEDED/);
    expect(text(prepared)).toMatch(/enrolls 1 of 1 contact/);
    expect(text(prepared)).toMatch(/sam@fake\.test/);
    expect(text(prepared)).toMatch(/at most 25 new contacts a day/);
    expect(text(prepared)).toMatch(/Always on/);
    const refused = await builder.callTool({ name: "confirm_action", arguments: { confirmationId: confirmationOf(prepared) } });
    expect(refused.isError).toBe(true);
    expect(text(refused)).toMatch(/can't send/);
    expect((await t.prisma.db.campaign.findFirstOrThrow({ where: { id: campaignId, workspaceId: w } })).status).toBe("draft");

    const mine = await call(sender, "launch_campaign", { campaignId });
    const done = data(await call(sender, "confirm_action", { confirmationId: confirmationOf(mine) }));
    expect(done).toMatchObject({ done: true, tool: "launch_campaign", result: { status: "running", enrolled: 1 } });
    expect(await t.prisma.db.enrollment.count({ where: { workspaceId: w, campaignId } })).toBe(1);
  });

  it("enroll_contacts resolves emails and enrolls after confirmation", async () => {
    const prepared = await call(sender, "enroll_contacts", { campaignId, emails: ["grace@prospect.test", "ada@prospect.test", "nobody@nowhere.test"] });
    expect(text(prepared)).toMatch(/Enroll 1 contact/);
    expect(text(prepared)).toMatch(/1 already enrolled/);
    expect(text(prepared)).toMatch(/Not found: nobody@nowhere\.test/);
    expect(await t.prisma.db.enrollment.count({ where: { workspaceId: w, campaignId } })).toBe(1);
    const done = data(await call(sender, "confirm_action", { confirmationId: confirmationOf(prepared) }));
    expect(done.result).toMatchObject({ enrolled: 1 });

    const list = data(await call(builder, "list_enrollments", { campaignId }));
    expect(list.total).toBe(2);
    expect(list.items.map((e: { contact: { email: string } }) => e.contact.email).sort()).toEqual(["ada@prospect.test", "grace@prospect.test"]);
  });

  it("pauses at once, resumes after confirmation", async () => {
    expect(data(await call(sender, "pause_campaign", { campaignId }))).toMatchObject({ status: "paused" });
    const refused = await builder.callTool({ name: "pause_campaign", arguments: { campaignId } });
    expect(refused.isError).toBe(true);

    const prepared = await call(sender, "resume_campaign", { campaignId });
    expect(text(prepared)).toMatch(/Resume the outreach campaign “Inbound leads”/);
    expect((await t.prisma.db.campaign.findFirstOrThrow({ where: { id: campaignId, workspaceId: w } })).status).toBe("paused");
    const done = data(await call(sender, "confirm_action", { confirmationId: confirmationOf(prepared) }));
    expect(done.result).toMatchObject({ status: "running" });

    const health = data(await call(builder, "campaign_health", { campaignId }));
    expect(health).toMatchObject({ status: "running", issues: [] });
    expect(health.steps).toHaveLength(3);
  });

  it("delete_template previews an archive while steps use it", async () => {
    const prepared = await call(sender, "delete_template", { templateId });
    expect(text(prepared)).toMatch(/Archive the email template “Opener”/);
    const stop = await sender.callTool({ name: "delete_campaign", arguments: { campaignId } });
    expect(stop.isError).toBe(true);
    expect(text(stop)).toMatch(/Pause or stop it/);
  });
});
