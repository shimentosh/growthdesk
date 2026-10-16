import { z } from "zod";
import { ALL_PERMISSIONS, DEFAULT_ROLE_PERMISSIONS, MCP_SEND_PERMISSIONS, mcpPermissions, permissionsFor, type McpAccess } from "@growthdesk/shared";
import { annotationsFor, confirmRefusal, toolRefusal, toolVisible } from "./access.js";
import { defineTool, type McpCtx } from "./tool.js";

const owner = [...ALL_PERMISSIONS];
const member = [...DEFAULT_ROLE_PERMISSIONS.member];

function ctxFor(role: "owner" | "member" | "viewer", access: McpAccess): Pick<McpCtx, "mcp" | "workspace"> {
  const rolePermissions = permissionsFor(role);
  return {
    mcp: { tokenId: "t1", tokenName: "Claude", access, clientName: null, rolePermissions },
    workspace: { id: "w1", name: "Acme", role, permissions: mcpPermissions(rolePermissions, access), billingAccountId: "b1", status: "active", timezone: "UTC", currency: "USD" },
  };
}

const tool = (risk: "read" | "write" | "important", permission: string | null) =>
  risk === "important"
    ? defineTool({ name: "t", title: "T", description: "d", input: z.object({}), permission, risk, preview: async () => ({ summary: "s" }), handler: async () => null })
    : defineTool({ name: "t", title: "T", description: "d", input: z.object({}), permission, risk, handler: async () => null });

describe("MCP access levels (mcpPermissions)", () => {
  it("send keeps exactly the role's permissions", () => {
    expect(mcpPermissions(owner, "send")).toEqual(owner);
    expect(mcpPermissions(member, "send")).toEqual(member);
  });

  it("read keeps only *.read and records.view_all", () => {
    const read = mcpPermissions(owner, "read");
    expect(read.length).toBeGreaterThan(5);
    expect(read.every((p) => p.endsWith(".read") || p === "records.view_all")).toBe(true);
    expect(read).toContain("contacts.read");
    expect(read).toContain("records.view_all");
    expect(read).not.toContain("contacts.write");
    expect(read).not.toContain("ai.use");
  });

  it("build drops every send permission and keeps the rest", () => {
    const build = mcpPermissions(owner, "build");
    for (const p of MCP_SEND_PERMISSIONS) expect(build).not.toContain(p);
    expect(build).toContain("contacts.write");
    expect(build).toContain("marketing.write");
    expect(build).toContain("campaigns.write");
    expect(build).not.toContain("marketing.send");
    expect(build).not.toContain("campaigns.launch");
    expect(build.length + MCP_SEND_PERMISSIONS.filter((p) => owner.includes(p)).length).toBe(owner.length);
  });

  it("never grants more than the role holds", () => {
    const viewer = permissionsFor("viewer");
    for (const access of ["read", "build", "send"] as const) {
      for (const p of mcpPermissions(viewer, access)) expect(viewer).toContain(p);
      for (const p of mcpPermissions(member, access)) expect(member).toContain(p);
    }
    expect(mcpPermissions(member, "send")).not.toContain("members.manage");
  });

  it("names only real permissions in the send set", () => {
    for (const p of MCP_SEND_PERMISSIONS) expect(ALL_PERMISSIONS).toContain(p);
  });
});

describe("toolRefusal", () => {
  it("lets a read token call only read tools", () => {
    const ctx = ctxFor("owner", "read");
    expect(toolRefusal(tool("read", "contacts.read"), ctx)).toBeNull();
    expect(toolRefusal(tool("write", "contacts.write"), ctx)).toMatch(/read-only/);
    expect(toolRefusal(tool("important", "marketing.send"), ctx)).toMatch(/read-only/);
    expect(toolVisible(tool("write", null), ctx)).toBe(false);
  });

  it("lets a build token write, and prepare an important action its role could do", () => {
    const ctx = ctxFor("owner", "build");
    expect(toolRefusal(tool("write", "contacts.write"), ctx)).toBeNull();
    expect(toolRefusal(tool("important", "marketing.send"), ctx)).toBeNull();
  });

  it("refuses a write tool whose permission the access level removed, naming the level", () => {
    const ctx = ctxFor("owner", "build");
    expect(toolRefusal(tool("write", "contacts.delete"), ctx)).toMatch(/access level \(Build/);
  });

  it("refuses what the role itself cannot do, even for a send token", () => {
    const ctx = ctxFor("member", "send");
    expect(toolRefusal(tool("write", "members.manage"), ctx)).toMatch(/Your role \(member\)/);
    expect(toolRefusal(tool("important", "marketing.send"), ctx)).toMatch(/Your role/);
    expect(toolVisible(tool("important", "marketing.send"), ctx)).toBe(false);
  });

  it("accepts any one of several permissions", () => {
    const ctx = ctxFor("member", "send");
    expect(toolRefusal(tool("read", null), ctx)).toBeNull();
    expect(toolRefusal({ ...tool("read", null), permission: ["members.manage", "contacts.read"] }, ctx)).toBeNull();
  });
});

describe("confirmRefusal", () => {
  it("only a send token can confirm", () => {
    expect(confirmRefusal("send")).toBeNull();
    expect(confirmRefusal("build")).toMatch(/can't send — .*Send token/);
    expect(confirmRefusal("read")).toMatch(/can't send/);
  });
});

describe("annotationsFor", () => {
  it("derives hints from risk, with overrides", () => {
    expect(annotationsFor(tool("read", null))).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true });
    expect(annotationsFor(tool("important", null))).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: false });
    expect(annotationsFor({ ...tool("write", null), annotations: { openWorldHint: true } })).toMatchObject({ openWorldHint: true, title: "T" });
  });
});
