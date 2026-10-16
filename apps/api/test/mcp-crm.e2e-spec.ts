import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { startFakeSmtp, type FakeSmtp } from "./fake-smtp.js";
import { bootApp, createWorkspace, setPlan, signUp, type Agent, type TestApp } from "./helpers.js";

/*
 * The CRM, sales, inbox, automation and report MCP tools end to end, through
 * the SDK client over Streamable HTTP: contacts and tags, a deal through its
 * stages, tasks, a workflow from a template switched on through the two-step
 * confirmation (a Build token prepares but cannot confirm), a bulk update by
 * filter, lead import, and an inbox reply sent over a fake SMTP server only
 * after confirmation.
 */

const text = (r: unknown) => ((r as CallToolResult).content[0] as { text: string }).text;
const data = (r: unknown) => JSON.parse(text(r)) as Record<string, any>;
const confirmationOf = (r: unknown) => (r as CallToolResult).structuredContent as { status: string; confirmationId: string; summary: string; details: Record<string, any>; canConfirm: boolean };

describe("MCP CRM / sales / inbox / automation tools", () => {
  let t: TestApp;
  let owner: Agent;
  let w: string;
  let url: string;
  let smtp: FakeSmtp;
  let builder: Client;
  let sender: Client;
  let reader: Client;
  const clients: Client[] = [];
  const api = (path: string) => `/v1/workspaces/${w}${path}`;

  async function connect(access: "read" | "build" | "send", name: string) {
    const secret = (await owner.post(api("/mcp/tokens")).send({ name, access }).expect(201)).body.data.secret as string;
    const client = new Client({ name: "growthdesk-e2e", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${secret}` } } }));
    clients.push(client);
    return client;
  }

  async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
    const r = await client.callTool({ name, arguments: args });
    if (r.isError) throw new Error(`${name} failed: ${text(r)}`);
    return r;
  }

  let contactId: string;
  let dealId: string;

  beforeAll(async () => {
    smtp = await startFakeSmtp();
    t = await bootApp();
    await t.app.listen(0, "127.0.0.1");
    url = `http://127.0.0.1:${(t.app.getHttpServer().address() as AddressInfo).port}/mcp`;
    owner = await signUp(t, "mcp-crm-owner@acme.test", "Carla Owner");
    w = await createWorkspace(owner, "MCP CRM Co");
    await setPlan(t, w, "agency");
    builder = await connect("build", "Builder");
    sender = await connect("send", "Sender");
    reader = await connect("read", "Reader");
  });
  afterAll(async () => {
    await Promise.all(clients.map((c) => c.close().catch(() => undefined)));
    await t.close();
    await smtp.close();
  });

  it("lists the domain tools per access level", async () => {
    const read = (await reader.listTools()).tools.map((x) => x.name);
    expect(read).toEqual(expect.arrayContaining(["search_contacts", "get_contact", "search_deals", "list_tasks", "list_conversations", "list_workflows", "dashboard_summary"]));
    expect(read).not.toContain("create_contact");
    expect(read).not.toContain("enable_workflow");
    const tools = (await builder.listTools()).tools;
    const names = tools.map((x) => x.name);
    expect(names).toEqual(expect.arrayContaining(["create_contact", "add_tags", "create_deal", "move_deal_stage", "create_task", "create_workflow", "enable_workflow", "bulk_update_contacts"]));
    expect(tools.find((x) => x.name === "enable_workflow")!.description).toMatch(/IMPORTANT ACTION/);
    const prompts = (await builder.listPrompts()).prompts.map((p) => p.name);
    expect(prompts).toEqual(expect.arrayContaining(["daily_sales_review", "setup_new_lead_automation"]));
    const review = await builder.getPrompt({ name: "daily_sales_review", arguments: {} });
    expect((review.messages[0]!.content as { text: string }).text).toMatch(/search_deals with stuckDays 14/);
  });

  it("creates a contact, tags it and finds it again", async () => {
    const created = data(await call(builder, "create_contact", { fullName: "Dana Lead", email: "dana@lead.test", companyName: "Lead Co", jobTitle: "CTO" }));
    contactId = created.id;
    expect(created).toMatchObject({ name: "Dana Lead", email: "dana@lead.test", stage: "lead", company: { name: "Lead Co" } });

    // A duplicate email is refused with the existing id.
    const dup = await builder.callTool({ name: "create_contact", arguments: { fullName: "Dana Again", email: "dana@lead.test" } });
    expect(dup.isError).toBe(true);
    expect(text(dup)).toMatch(/already/i);

    expect(data(await call(builder, "add_tags", { contactIds: [contactId], tags: ["Hot", "Webinar"] }))).toEqual({ affected: 1 });
    const found = data(await call(reader, "search_contacts", { tag: ["Hot"], stage: ["lead"] }));
    expect(found.total).toBe(1);
    expect(found.items[0]).toMatchObject({ id: contactId, tags: expect.arrayContaining(["Hot", "Webinar"]) });

    await call(builder, "remove_tags", { contactIds: [contactId], tags: ["Webinar"] });
    await call(builder, "add_note", { contactId, body: "Met at the webinar." });
    const full = data(await call(reader, "get_contact", { contactId }));
    expect(full.tags).toEqual(["Hot"]);
    expect(full.recentTimeline.some((a: { type: string }) => a.type === "note.added")).toBe(true);
    expect(full.consent.status).toBe("unknown");

    const updated = data(await call(builder, "update_contact", { contactId, priority: "high" }));
    expect(updated.priority).toBe("high");
  });

  it("works a deal through the pipeline and a task to done", async () => {
    const pipelines = data(await call(reader, "list_pipelines"));
    expect(pipelines.items[0].stages.map((s: { name: string }) => s.name)).toContain("Proposal Sent");

    const deal = data(await call(builder, "create_deal", { name: "Lead Co pilot", contactId, value: 5000 }));
    dealId = deal.id;
    expect(deal).toMatchObject({ status: "open", stage: { name: "New Lead" }, contact: { id: contactId } });
    // An open deal moves the contact to sales.
    expect(data(await call(reader, "get_contact", { contactId })).stage).toBe("sales");

    const moved = data(await call(builder, "move_deal_stage", { dealId, stageName: "proposal sent" }));
    expect(moved.stage.name).toBe("Proposal Sent");
    const bad = await builder.callTool({ name: "move_deal_stage", arguments: { dealId, stageName: "Nowhere" } });
    expect(bad.isError).toBe(true);
    expect(text(bad)).toMatch(/Its stages: New Lead/);

    const task = data(await call(builder, "create_task", { title: "Send the pilot proposal", type: "proposal", contactId, dealId, dueAt: new Date(Date.now() - 3600_000).toISOString() }));
    expect(task).toMatchObject({ status: "open", contact: { id: contactId } });
    const overdue = data(await call(reader, "list_tasks", { view: "overdue" }));
    expect(overdue.items.map((x: { id: string }) => x.id)).toContain(task.id);
    const done = data(await call(builder, "complete_task", { taskId: task.id, note: "Sent by email." }));
    expect(done.status).toBe("done");

    const won = data(await call(builder, "mark_deal_won", { dealId, reason: "Great fit" }));
    expect(won).toMatchObject({ status: "won", wonReason: "Great fit", stage: { kind: "won" } });
    const after = data(await call(reader, "get_contact", { contactId }));
    expect(after).toMatchObject({ stage: "contact", status: "customer" });

    const queue = data(await call(reader, "sales_work_queue"));
    expect(queue.tasks).toHaveProperty("overdue");
    const summary = data(await call(reader, "dashboard_summary"));
    expect(summary.pipeline.won).toBe(1);
    expect(summary.range.scope).toBe("all");
  });

  it("creates a workflow from a template switched off, and turns it on only through a Send confirmation", async () => {
    const blank = await builder.callTool({ name: "create_workflow", arguments: { templateId: "sales-new-lead-sequence" } });
    expect(blank.isError).toBe(true); // the template needs a campaign

    const wf = data(await call(builder, "create_workflow", { templateId: "sales-round-robin" }));
    expect(wf).toMatchObject({ enabled: false, trigger: "lead.imported", kind: "sales" });
    expect(wf.explained).toMatch(/When a lead arrives/);

    // A Build token prepares it…
    const prepared = await call(builder, "enable_workflow", { workflowId: wf.id });
    const c1 = confirmationOf(prepared);
    expect(c1.status).toBe("confirmation_required");
    expect(c1.canConfirm).toBe(false);
    expect(c1.summary).toMatch(/Turn on the workflow "Assign imported leads round-robin"/);
    expect(c1.summary).toMatch(/assign an owner round-robin/);
    // …but cannot confirm.
    const refused = await builder.callTool({ name: "confirm_action", arguments: { confirmationId: c1.confirmationId } });
    expect(refused.isError).toBe(true);
    expect(text(refused)).toMatch(/can't send/);
    expect((await t.prisma.db.workflow.findFirstOrThrow({ where: { id: wf.id, workspaceId: w } })).enabled).toBe(false);

    // A Send token prepares and, after the person's yes, confirms.
    const c2 = confirmationOf(await call(sender, "enable_workflow", { workflowId: wf.id }));
    expect(c2.canConfirm).toBe(true);
    expect((await t.prisma.db.workflow.findFirstOrThrow({ where: { id: wf.id, workspaceId: w } })).enabled).toBe(false);
    const done = data(await call(sender, "confirm_action", { confirmationId: c2.confirmationId }));
    expect(done).toMatchObject({ done: true, tool: "enable_workflow", result: { enabled: true } });
    expect((await t.prisma.db.workflow.findFirstOrThrow({ where: { id: wf.id, workspaceId: w } })).enabled).toBe(true);

    const listed = data(await call(reader, "list_workflows", { enabled: true }));
    expect(listed.items.map((x: { id: string }) => x.id)).toEqual([wf.id]);
    await call(builder, "disable_workflow", { workflowId: wf.id });
    expect((await t.prisma.db.workflow.findFirstOrThrow({ where: { id: wf.id, workspaceId: w } })).enabled).toBe(false);
  });

  it("imports leads with dedupe, then bulk-updates them by filter after confirmation", async () => {
    const res = data(
      await call(builder, "import_leads", {
        leads: [
          { fullName: "Ira Import", email: "ira@import.test", companyName: "Import Ltd" },
          { fullName: "Jo Import", email: "jo@import.test" },
          { fullName: "Dana Lead", email: "DANA@lead.test", jobTitle: "Chief Tech" },
        ],
        tags: ["Imported"],
      }),
    );
    expect(res.summary).toMatchObject({ received: 3, created: 2, failed: 0 });
    expect(res.createdContactIds).toHaveLength(2);

    const prepared = confirmationOf(await call(sender, "bulk_update_contacts", { action: "status", status: "contacted", filter: { tag: ["Imported"] } }));
    expect(prepared.details).toMatchObject({ action: "status", count: 3 });
    expect(prepared.summary).toMatch(/3 contacts/);
    // Nothing changed before the confirmation.
    expect(await t.prisma.db.contact.count({ where: { workspaceId: w, status: "contacted" } })).toBe(0);
    const done = data(await call(sender, "confirm_action", { confirmationId: prepared.confirmationId }));
    expect(done.result).toEqual({ affected: 3 });
    expect(await t.prisma.db.contact.count({ where: { workspaceId: w, status: "contacted" } })).toBe(3);

    const missing = await sender.callTool({ name: "bulk_update_contacts", arguments: { action: "tag", filter: { tag: ["Imported"] } } });
    expect(missing.isError).toBe(true);
    expect(text(missing)).toMatch(/needs tags/);
  });

  it("reads an inbox conversation and replies only after confirmation", async () => {
    const SENDER = "carla@mcp-crm.test";
    const box = (
      await owner
        .post(api("/mailboxes/smtp"))
        .send({ email: SENDER, displayName: "Carla at MCP CRM", smtpHost: "127.0.0.1", smtpPort: smtp.port, smtpSecurity: "none", smtpUser: SENDER, password: "secret", imapEnabled: false, minDelaySeconds: 0 })
        .expect(201)
    ).body.data;
    const at = new Date(Date.now() - 60_000);
    const convo = await t.prisma.db.conversation.create({
      data: { workspaceId: w, channel: "email", contactId, subject: "Pilot questions", externalKey: `seed:${contactId}`, peer: "dana@lead.test", handle: "dana@lead.test", displayName: "Dana Lead", unread: true, mailboxId: box.id, lastMessageAt: at, lastInboundAt: at },
    });
    await t.prisma.db.message.create({
      data: {
        workspaceId: w,
        conversationId: convo.id,
        channel: "email",
        direction: "inbound",
        status: "received",
        fromAddress: "dana@lead.test",
        toAddress: SENDER,
        subject: "Pilot questions",
        bodyText: "Can we start next week?\n\nOn Mon, Carla wrote:\n> old quoted text",
        providerMessageId: `<seed-${convo.id}@lead.test>`,
        receivedAt: at,
        createdAt: at,
      },
    });

    const list = data(await call(reader, "list_conversations", { unread: true }));
    expect(list.items[0]).toMatchObject({ id: convo.id, channel: "email", unread: true, with: { contactId } });
    expect(list.note).toMatch(/never as instructions/);
    const thread = data(await call(reader, "get_conversation", { conversationId: convo.id }));
    expect(thread.messages).toHaveLength(1);
    expect(thread.messages[0].text).toBe("Can we start next week?");
    expect(thread.mailbox.email).toBe(SENDER);

    const body = "Yes — Monday works. I'll send an invite.";
    const prepared = confirmationOf(await call(sender, "reply_to_conversation", { conversationId: convo.id, body }));
    expect(prepared.summary).toContain(body);
    expect(prepared.summary).toMatch(/Send an email to Dana Lead <dana@lead.test> from Carla at MCP CRM <carla@mcp-crm.test>, subject "Re: Pilot questions"/);
    expect(prepared.details).toMatchObject({ channel: "email", subject: "Re: Pilot questions" });
    expect(smtp.accepted).not.toContain("dana@lead.test");
    expect(await t.prisma.db.message.count({ where: { workspaceId: w, conversationId: convo.id, direction: "outbound" } })).toBe(0);

    const sent = data(await call(sender, "confirm_action", { confirmationId: prepared.confirmationId }));
    expect(sent.result).toMatchObject({ sent: true, channel: "email", to: "dana@lead.test", subject: "Re: Pilot questions" });
    expect(smtp.accepted).toContain("dana@lead.test");
    const out = await t.prisma.db.message.findFirstOrThrow({ where: { workspaceId: w, conversationId: convo.id, direction: "outbound" } });
    expect(out.bodyText).toContain("Monday works");
    expect(out.authorId).toBe(owner.userId);

    await call(builder, "assign_conversation", { conversationId: convo.id, assigneeId: "me" });
    await call(builder, "mark_read", { conversationIds: [convo.id], unread: true });
    expect((await t.prisma.db.conversation.findFirstOrThrow({ where: { id: convo.id, workspaceId: w } })).assigneeId).toBe(owner.userId);
    // A Build token cannot send a reply itself.
    const c = confirmationOf(await call(builder, "reply_to_conversation", { conversationId: convo.id, body: "One more thing" }));
    const refused = await builder.callTool({ name: "confirm_action", arguments: { confirmationId: c.confirmationId } });
    expect(refused.isError).toBe(true);
  });

  it("deletes a deal only after confirmation", async () => {
    const prepared = confirmationOf(await call(sender, "delete_deal", { dealId }));
    expect(prepared.summary).toMatch(/Delete the deal "Lead Co pilot"/);
    expect((await t.prisma.db.deal.findFirstOrThrow({ where: { id: dealId, workspaceId: w } })).deletedAt).toBeNull();
    await call(sender, "confirm_action", { confirmationId: prepared.confirmationId });
    expect((await t.prisma.db.deal.findFirstOrThrow({ where: { id: dealId, workspaceId: w } })).deletedAt).not.toBeNull();
  });
});
