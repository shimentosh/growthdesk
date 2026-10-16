import type { AddressInfo } from "node:net";
import { Global, Module } from "@nestjs/common";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { AuditService } from "../src/core/audit.service.js";
import { badRequest } from "../src/common/errors.js";
import { MCP_EXTRA_TOOLS } from "../src/mcp/mcp-runtime.service.js";
import { defineTool } from "../src/mcp/tool.js";
import { addMember, bootApp, createWorkspace, setPlan, signUp, type Agent, type TestApp } from "./helpers.js";

/*
 * MCP end to end, through the SDK's own client over Streamable HTTP: bearer
 * auth and its refusals, tools/list per access level, the core tools, audit
 * attribution, and the two-step confirmation (build tokens prepare but cannot
 * confirm; confirmations are single-use, token-bound, cancelable, expiring).
 *
 * Two test-only tools come in through MCP_EXTRA_TOOLS: a write tool that
 * records an audit event, and an important tool whose handler counts runs.
 */

const runs: string[] = [];

const TEST_TOOLS = [
  defineTool({
    name: "test_write",
    title: "Test write",
    description: "Records an audit event.",
    input: z.object({ label: z.string() }),
    permission: "contacts.write",
    risk: "write",
    handler: async (ctx, args, deps) => {
      await deps.get(AuditService).record(ctx, { action: "test.mcp_write", metadata: { label: args.label } });
      return { recorded: args.label };
    },
  }),
  defineTool({
    name: "test_send",
    title: "Test send",
    description: "Pretends to send something important.",
    input: z.object({ message: z.string().min(1), audience: z.number().int().min(0).default(3) }),
    permission: "marketing.send",
    risk: "important",
    preview: async (_ctx, args) => {
      if (args.message === "invalid") throw badRequest("That message cannot be sent", { message: "Not allowed" });
      return { summary: `Send "${args.message}" to ${args.audience} people.`, details: { recipients: args.audience } };
    },
    handler: async (_ctx, args) => {
      runs.push(args.message);
      return { sent: args.message, recipients: args.audience };
    },
  }),
];

@Global()
@Module({ providers: [{ provide: MCP_EXTRA_TOOLS, useValue: TEST_TOOLS }], exports: [MCP_EXTRA_TOOLS] })
class TestMcpToolsModule {}

const text = (r: unknown) => ((r as CallToolResult).content[0] as { text: string }).text;
const data = (r: unknown) => JSON.parse(text(r)) as Record<string, any>;

describe("MCP server", () => {
  let t: TestApp;
  let owner: Agent;
  let w: string;
  let url: string;
  const tokens: Record<string, { id: string; secret: string }> = {};
  const clients: Client[] = [];

  const api = (path: string) => `/v1/workspaces/${w}${path}`;

  async function token(name: string, access: "read" | "build" | "send", agent: Agent = owner) {
    const res = await agent.post(api("/mcp/tokens")).send({ name, access }).expect(201);
    return res.body.data as { id: string; secret: string; prefix: string; url: string };
  }

  async function connect(secret: string) {
    const client = new Client({ name: "growthdesk-e2e", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${secret}` } } }));
    clients.push(client);
    return client;
  }

  beforeAll(async () => {
    t = await bootApp([TestMcpToolsModule]);
    await t.app.listen(0, "127.0.0.1");
    url = `http://127.0.0.1:${(t.app.getHttpServer().address() as AddressInfo).port}/mcp`;
    owner = await signUp(t, "mcp-owner@acme.test", "Mona Owner");
    w = await createWorkspace(owner, "MCP Co");
    await setPlan(t, w, "growth");
    for (const [name, access] of [["Reader", "read"], ["Builder", "build"], ["Sender", "send"], ["Sender 2", "send"]] as const) {
      tokens[name] = await token(name, access);
    }
  });
  afterAll(async () => {
    await Promise.all(clients.map((c) => c.close().catch(() => undefined)));
    await t.close();
  });

  describe("tokens", () => {
    it("shows the token once, stores only its digest, and tells where to connect", async () => {
      const created = await token("Once", "read");
      expect(created.secret).toMatch(/^gdm_/);
      expect(created.prefix).toBe(created.secret.slice(0, 12));
      expect(created.url).toBe("http://localhost:3600/api/mcp");
      const row = await t.prisma.db.mcpToken.findUniqueOrThrow({ where: { id: created.id } });
      expect(row.tokenHash).not.toContain(created.secret);
      const list = await owner.get(api("/mcp/tokens")).expect(200);
      expect(list.body.data.items.find((i: { id: string }) => i.id === created.id)).not.toHaveProperty("secret");
      expect(list.body.data.seesAll).toBe(true);
    });

    it("lets any member create their own tokens, and see only their own", async () => {
      const member = await addMember(t, owner, w, "mcp-member@acme.test", "member");
      const mine = await token("Member's", "build", member);
      const list = await member.get(api("/mcp/tokens")).expect(200);
      expect(list.body.data.seesAll).toBe(false);
      expect(list.body.data.items.map((i: { id: string }) => i.id)).toEqual([mine.id]);
      await member.delete(api(`/mcp/tokens/${tokens.Reader!.id}`)).expect(404);
      // Owners and admins see everyone's.
      const all = await owner.get(api("/mcp/tokens")).expect(200);
      expect(all.body.data.items.some((i: { id: string }) => i.id === mine.id)).toBe(true);
    });
  });

  describe("authentication", () => {
    it("answers 401 with a challenge without a valid token", async () => {
      const none = await t.http().post("/mcp").send({ jsonrpc: "2.0", id: 1, method: "tools/list" }).expect(401);
      expect(none.headers["www-authenticate"]).toMatch(/^Bearer /);
      await t.http().post("/mcp").set("Authorization", "Bearer gdm_nope").send({}).expect(401);
    });

    it("answers 405 to GET and DELETE (stateless), and lets any origin preflight", async () => {
      await t.http().get("/mcp").expect(405);
      await t.http().delete("/mcp").expect(405);
      const pre = await t.http().options("/mcp").set("Origin", "https://claude.ai").expect(204);
      expect(pre.headers["access-control-allow-origin"]).toBe("*");
      expect(pre.headers["access-control-allow-headers"]).toMatch(/Authorization/);
    });

    it("refuses a revoked token at once", async () => {
      const doomed = await token("Doomed", "read");
      const client = await connect(doomed.secret);
      await client.callTool({ name: "whoami", arguments: {} });
      await owner.delete(api(`/mcp/tokens/${doomed.id}`)).expect(200);
      await expect(client.callTool({ name: "whoami", arguments: {} })).rejects.toThrow();
    });

    it("refuses the token of a member whose access is paused", async () => {
      const member = await addMember(t, owner, w, "mcp-paused@acme.test", "member");
      const tok = await token("Paused member's", "read", member);
      const membership = await t.prisma.db.membership.findFirstOrThrow({ where: { workspaceId: w, user: { email: "mcp-paused@acme.test" } } });
      await t.prisma.db.membership.update({ where: { id: membership.id }, data: { deactivatedAt: new Date() } });
      const res = await t.http().post("/mcp").set("Authorization", `Bearer ${tok.secret}`).send({}).expect(403);
      expect(res.body.error.code).toBe("member_deactivated");
    });

    it("narrows a member to their own records in team visibility mode, as in the app", async () => {
      const member = await addMember(t, owner, w, "mcp-teamview@acme.test", "member");
      const tok = await token("Team-mode member's", "read", member);
      const ownerId = (await owner.get("/v1/auth/me").expect(200)).body.data.user.id;
      const olga = (await owner.post(api("/contacts")).send({ fullName: "Olga Ownedbyowner", email: "olga@visibility.test", ownerId }).expect(201)).body.data.id as string;
      const client = await connect(tok.secret);
      const found = async () => JSON.stringify((await client.callTool({ name: "search_contacts", arguments: { q: "Ownedbyowner" } })).content);
      expect(await found()).toContain("Olga");
      const ws = await t.prisma.db.workspace.findUniqueOrThrow({ where: { id: w }, select: { settings: true } });
      await t.prisma.db.workspace.update({ where: { id: w }, data: { settings: { ...((ws.settings as object) ?? {}), recordVisibility: "team" } } });
      try {
        expect(await found()).not.toContain("Olga");
      } finally {
        await t.prisma.db.workspace.update({ where: { id: w }, data: { settings: (ws.settings ?? {}) as object } });
        // Later tests count the workspace's contacts.
        await t.prisma.db.contact.update({ where: { id: olga, workspaceId: w }, data: { deletedAt: new Date() } });
      }
    });

    it("refuses every token while the plan lacks API access", async () => {
      await setPlan(t, w, "free");
      try {
        const res = await t.http().post("/mcp").set("Authorization", `Bearer ${tokens.Reader!.secret}`).send({}).expect(402);
        expect(res.body.error.details.feature).toBe("apiAccess");
      } finally {
        await setPlan(t, w, "growth");
      }
    });
  });

  describe("tools", () => {
    it("lists only what each access level can use, with annotations", async () => {
      const names = async (secret: string) => (await (await connect(secret)).listTools()).tools.map((x) => x.name);
      const read = await names(tokens.Reader!.secret);
      expect(read).toEqual(expect.arrayContaining(["whoami", "workspace_overview", "list_workspaces", "list_pending_actions"]));
      expect(read).not.toContain("test_write");
      expect(read).not.toContain("confirm_action");
      expect(read).not.toContain("test_send");

      const build = await names(tokens.Builder!.secret);
      expect(build).toEqual(expect.arrayContaining(["test_write", "test_send", "confirm_action", "cancel_action"]));

      const tools = (await (await connect(tokens.Sender!.secret)).listTools()).tools;
      const confirm = tools.find((x) => x.name === "confirm_action")!;
      expect(confirm.annotations).toMatchObject({ destructiveHint: true, title: expect.stringMatching(/ask the user first/) });
      expect(tools.find((x) => x.name === "whoami")!.annotations).toMatchObject({ readOnlyHint: true });
      expect(tools.find((x) => x.name === "test_send")!.description).toMatch(/IMPORTANT ACTION/);
      expect(tools.find((x) => x.name === "test_send")!.inputSchema).toMatchObject({ type: "object", required: ["message"] });
    });

    it("tells the client who it is and how to start", async () => {
      const client = await connect(tokens.Sender!.secret);
      expect(client.getServerVersion()).toMatchObject({ name: "growthdesk" });
      expect(client.getInstructions()).toMatch(/workspace_overview/);
      expect(client.getInstructions()).toMatch(/confirm_action/);
    });

    it("whoami: the person, workspace, role and token access", async () => {
      const me = data(await (await connect(tokens.Builder!.secret)).callTool({ name: "whoami", arguments: {} }));
      expect(me.user.email).toBe("mcp-owner@acme.test");
      expect(me.workspace).toMatchObject({ id: w, name: "MCP Co" });
      expect(me.role).toBe("owner");
      expect(me.token).toMatchObject({ name: "Builder", access: "build", canConfirmImportantActions: false });
      expect(me.plan.name).toBe("Growth");
      expect(me.permissions).toContain("contacts.write");
      expect(me.permissions).not.toContain("marketing.send");
    });

    it("workspace_overview: counts across the workspace", async () => {
      await owner.post(api("/contacts")).send({ firstName: "Ada", email: "ada@lovelace.test" }).expect(201);
      const o = data(await (await connect(tokens.Reader!.secret)).callTool({ name: "workspace_overview", arguments: {} }));
      expect(o.contacts.total).toBe(1);
      expect(o.tasks).toEqual({ open: 0, overdue: 0 });
      expect(o.inbox.unread).toBe(0);
      expect(o.marketing).toHaveProperty("lists");
      expect(o).toHaveProperty("outreachCampaignsByStatus");
    });

    it("list_workspaces: memberships, this one marked current", async () => {
      const r = data(await (await connect(tokens.Reader!.secret)).callTool({ name: "list_workspaces", arguments: {} }));
      expect(r.items).toEqual([expect.objectContaining({ id: w, current: true, role: "owner" })]);
    });

    it("a read token cannot call a write tool", async () => {
      const r = await (await connect(tokens.Reader!.secret)).callTool({ name: "test_write", arguments: { label: "x" } });
      expect(r.isError).toBe(true);
      expect(text(r)).toMatch(/read-only/);
      expect(await t.prisma.db.auditEvent.count({ where: { action: "test.mcp_write" } })).toBe(0);
    });

    it("validates arguments and reports field errors", async () => {
      const r = await (await connect(tokens.Builder!.secret)).callTool({ name: "test_write", arguments: {} });
      expect(r.isError).toBe(true);
      expect(text(r)).toMatch(/label/);
    });

    it("acts as the person, and the audit log says it came through MCP", async () => {
      const r = await (await connect(tokens.Builder!.secret)).callTool({ name: "test_write", arguments: { label: "hello" } });
      expect(r.isError).toBeFalsy();
      const event = await t.prisma.db.auditEvent.findFirstOrThrow({ where: { action: "test.mcp_write" } });
      expect(event.actorUserId).toBe(owner.userId);
      // The person it acted for, and that an AI agent did it (src/common/actor.ts).
      expect(event.actorType).toBe("ai_agent");
      expect(event.metadata).toMatchObject({ label: "hello", via: "MCP: Builder", mcpTokenId: tokens.Builder!.id });
    });

    it("logs calls for the activity page", async () => {
      const res = await owner.get(api("/mcp/activity")).expect(200);
      const rows = res.body.data as { tool: string; ok: boolean; token: { name: string } }[];
      expect(rows.some((r) => r.tool === "test_write" && !r.ok && r.token.name === "Reader")).toBe(true);
      expect(rows.some((r) => r.tool === "whoami" && r.ok)).toBe(true);
    });
  });

  describe("two-step confirmation", () => {
    const prepare = async (client: Client, message: string) => {
      const r = await client.callTool({ name: "test_send", arguments: { message } });
      expect(r.isError).toBeFalsy();
      return r;
    };
    const idOf = (r: unknown) => (r as CallToolResult).structuredContent!.confirmationId as string;

    it("calling an important tool only prepares it", async () => {
      const r = await prepare(await connect(tokens.Sender!.secret), "prepared only");
      expect(text(r)).toMatch(/CONFIRMATION NEEDED — nothing has happened yet/);
      expect(text(r)).toMatch(/Send "prepared only" to 3 people/);
      expect((r as CallToolResult).structuredContent).toMatchObject({ status: "confirmation_required", canConfirm: true, details: { recipients: 3 } });
      expect(runs).not.toContain("prepared only");
      const pending = await owner.get(api("/mcp/pending")).expect(200);
      expect(pending.body.data.some((p: { id: string }) => p.id === idOf(r))).toBe(true);
    });

    it("a preview can refuse before anything is stored", async () => {
      const before = await t.prisma.db.mcpPendingAction.count({ where: { workspaceId: w } });
      const r = await (await connect(tokens.Sender!.secret)).callTool({ name: "test_send", arguments: { message: "invalid" } });
      expect(r.isError).toBe(true);
      expect(text(r)).toMatch(/cannot be sent/);
      expect(await t.prisma.db.mcpPendingAction.count({ where: { workspaceId: w } })).toBe(before);
    });

    it("a build token can prepare but not confirm", async () => {
      const client = await connect(tokens.Builder!.secret);
      const r = await prepare(client, "from builder");
      expect((r as CallToolResult).structuredContent).toMatchObject({ canConfirm: false });
      const c = await client.callTool({ name: "confirm_action", arguments: { confirmationId: idOf(r) } });
      expect(c.isError).toBe(true);
      expect(text(c)).toMatch(/can't send — .*Send token/);
      expect(runs).not.toContain("from builder");
    });

    it("a send token confirms once; the action runs exactly once", async () => {
      const client = await connect(tokens.Sender!.secret);
      const r = await prepare(client, "go");
      const c = await client.callTool({ name: "confirm_action", arguments: { confirmationId: idOf(r) } });
      expect(c.isError).toBeFalsy();
      expect(data(c)).toMatchObject({ done: true, tool: "test_send", result: { sent: "go", recipients: 3 } });
      const again = await client.callTool({ name: "confirm_action", arguments: { confirmationId: idOf(r) } });
      expect(again.isError).toBe(true);
      expect(text(again)).toMatch(/already confirmed/);
      expect(runs.filter((m) => m === "go")).toHaveLength(1);
      const row = await t.prisma.db.mcpPendingAction.findFirstOrThrow({ where: { id: idOf(r), workspaceId: w } });
      expect(row.confirmedAt).not.toBeNull();
      expect(row.result).toMatchObject({ ok: true });
      expect(await t.prisma.db.auditEvent.count({ where: { action: "mcp.action_confirmed", targetId: idOf(r) } })).toBe(1);
    });

    it("is bound to the token that prepared it", async () => {
      const r = await prepare(await connect(tokens.Sender!.secret), "bound");
      const c = await (await connect(tokens["Sender 2"]!.secret)).callTool({ name: "confirm_action", arguments: { confirmationId: idOf(r) } });
      expect(c.isError).toBe(true);
      expect(text(c)).toMatch(/different connection/);
      expect(runs).not.toContain("bound");
    });

    it("cancel_action drops it for good", async () => {
      const client = await connect(tokens.Sender!.secret);
      const r = await prepare(client, "canceled");
      const listed = data(await client.callTool({ name: "list_pending_actions", arguments: {} }));
      expect(listed.items.some((i: { confirmationId: string }) => i.confirmationId === idOf(r))).toBe(true);
      expect((await client.callTool({ name: "cancel_action", arguments: { confirmationId: idOf(r) } })).isError).toBeFalsy();
      const c = await client.callTool({ name: "confirm_action", arguments: { confirmationId: idOf(r) } });
      expect(text(c)).toMatch(/canceled/);
      expect(runs).not.toContain("canceled");
    });

    it("expires after ten minutes", async () => {
      const client = await connect(tokens.Sender!.secret);
      const r = await prepare(client, "late");
      const row = await t.prisma.db.mcpPendingAction.findFirstOrThrow({ where: { id: idOf(r), workspaceId: w } });
      expect(row.expiresAt.getTime() - row.createdAt.getTime()).toBe(10 * 60_000);
      await t.prisma.db.mcpPendingAction.updateMany({ where: { id: row.id, workspaceId: w }, data: { expiresAt: new Date(Date.now() - 1000) } });
      const c = await client.callTool({ name: "confirm_action", arguments: { confirmationId: idOf(r) } });
      expect(text(c)).toMatch(/expired/);
      expect(runs).not.toContain("late");
    });

    it("can be canceled from the app, and revoking a token drops what it prepared", async () => {
      const client = await connect(tokens.Sender!.secret);
      const fromApp = idOf(await prepare(client, "app-canceled"));
      await owner.delete(api(`/mcp/pending/${fromApp}`)).expect(200);
      expect(text(await client.callTool({ name: "confirm_action", arguments: { confirmationId: fromApp } }))).toMatch(/canceled/);

      const doomed = await token("Short-lived sender", "send");
      const id = idOf(await prepare(await connect(doomed.secret), "orphan"));
      await owner.delete(api(`/mcp/tokens/${doomed.id}`)).expect(200);
      const row = await t.prisma.db.mcpPendingAction.findFirstOrThrow({ where: { id, workspaceId: w } });
      expect(row.canceledAt).not.toBeNull();
    });
  });
});
