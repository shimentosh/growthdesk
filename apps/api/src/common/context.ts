import type { Request } from "express";
import type { McpAccess, PlatformRole, WorkspaceRole } from "@growthdesk/shared";
import { forbidden, unauthorized } from "./errors.js";

export type Identity = {
  userId: string;
  email: string;
  name: string;
  platformRole: PlatformRole;
  emailVerified: boolean;
  /** Two-factor is on for the account (a workspace can require it). */
  twoFactor: boolean;
  sessionId: string;
};

export type WorkspaceContext = {
  id: string;
  name: string;
  role: WorkspaceRole | "api";
  permissions: string[];
  billingAccountId: string;
  status: "active" | "suspended";
  timezone: string;
  currency: string;
  /** Team visibility (common/visibility.ts): the people whose records this request may see; unset = no team narrowing. */
  visibleUserIds?: string[];
};

export type ApiKeyContext = { id: string; workspaceId: string; scopes: string[]; name: string };

/**
 * Set when the request came through MCP (src/mcp): the person in `identity` is
 * acting through one of their MCP tokens. `rolePermissions` is what their role
 * holds; `workspace.permissions` is that, narrowed by the token's access level.
 */
export type McpTokenContext = {
  tokenId: string;
  tokenName: string;
  access: McpAccess;
  clientName: string | null;
  rolePermissions: string[];
};

/** Everything the guard learned about a request. Handlers read it with @Ctx(). */
export type RequestContext = {
  requestId: string;
  ip: string;
  userAgent: string;
  identity?: Identity;
  apiKey?: ApiKeyContext;
  /** The request came through MCP, as `identity`, with this token. */
  mcp?: McpTokenContext;
  workspace?: WorkspaceContext;
};

export type Req = Request & { ctx: RequestContext; rawBody?: Buffer };

export function me(ctx: RequestContext): Identity {
  if (!ctx.identity) throw unauthorized();
  return ctx.identity;
}

export function ws(ctx: RequestContext): WorkspaceContext {
  if (!ctx.workspace) throw forbidden("This request has no workspace");
  return ctx.workspace;
}

/** The acting user's id, or null when an API key is acting. */
export const actorId = (ctx: RequestContext): string | null => ctx.identity?.userId ?? null;

export const holds = (ctx: RequestContext, permission: string) => Boolean(ctx.workspace?.permissions.includes(permission));

/**
 * Rows a person may see when they lack records.view_all: their own (and
 * unowned, for triage) — or, under team visibility, their teams' too.
 */
export function ownershipScope(ctx: RequestContext, field: "ownerId" | "assigneeId" = "ownerId"): Record<string, unknown> {
  if (!ctx.workspace || holds(ctx, "records.view_all") || !ctx.identity) return {};
  const people = ctx.workspace.visibleUserIds;
  if (people && people.length > 1) return { OR: [{ [field]: { in: people } }, { [field]: null }] };
  return { OR: [{ [field]: ctx.identity.userId }, { [field]: null }] };
}

export const PLATFORM_RANK: Record<PlatformRole, number> = { none: 0, support: 1, admin: 2, owner: 3 };

/** A trusted client address: the socket, plus as many trailing X-Forwarded-For entries as we put there ourselves (LinkDesk clientIpFrom). */
export function clientIpFrom(socketAddress: string | undefined, forwardedFor: string | undefined, hops: number): string {
  const norm = (v: string) => v.trim().replace(/^::ffff:/, "");
  const peer = norm(socketAddress ?? "");
  if (hops <= 0) return peer;
  const chain = (forwardedFor ?? "").split(",").map(norm).filter(Boolean);
  const index = chain.length - hops;
  return index >= 0 && index < chain.length ? (chain[index] ?? peer) : peer;
}
