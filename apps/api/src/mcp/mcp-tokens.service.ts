import { Injectable } from "@nestjs/common";
import { MAX_MCP_TOKENS, MCP_TOKEN_PREFIX, type McpTokenInput } from "@growthdesk/shared";
import type { z } from "zod";
import type { McpToken } from "../generated/prisma/client.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { EntitlementsService } from "../billing/entitlements.service.js";
import { AuditService } from "../core/audit.service.js";
import { hashToken, newToken } from "../common/crypto.js";
import { badRequest, conflict, notFound } from "../common/errors.js";
import { holds, me, ws, type RequestContext } from "../common/context.js";
import { McpAuthService } from "./mcp-auth.service.js";

type McpTokenInputT = z.infer<typeof McpTokenInput>;

/** Characters of the token kept in clear ("gdm_" + 8), so a person can tell tokens apart. */
const SHOWN_PREFIX = MCP_TOKEN_PREFIX.length + 8;

export type McpTokenStatus = "active" | "expired" | "revoked";

/** An OAuth connection (src/mcp/oauth) lives as long as its refresh token; its hourly access token expiring is routine. */
function statusOf(t: McpToken, now = Date.now()): McpTokenStatus {
  if (t.revokedAt) return "revoked";
  const ends = t.oauthClientId ? t.refreshExpiresAt : t.expiresAt;
  if (ends && ends.getTime() <= now) return "expired";
  return "active";
}

type Person = { id: string; name: string; email: string };

function tokenDto(t: McpToken, user: Person | null, viewerId: string) {
  return {
    id: t.id,
    name: t.name,
    prefix: t.prefix,
    access: t.access,
    status: statusOf(t),
    clientName: t.clientName,
    viaOAuth: Boolean(t.oauthClientId),
    user,
    mine: t.userId === viewerId,
    lastUsedAt: t.lastUsedAt,
    // For an OAuth connection: when it lapses unless the app refreshes it.
    expiresAt: t.oauthClientId ? t.refreshExpiresAt : t.expiresAt,
    revokedAt: t.revokedAt,
    createdAt: t.createdAt,
  };
}

/*
 * Settings → MCP / Claude (docs/MCP.md). Tokens are personal: anyone in the
 * workspace may create one for themselves — it can never do more than their
 * own role (McpAuthService narrows it on every request) — and sees and
 * revokes their own. Holders of apikeys.manage (owners and admins by
 * default) see and revoke everyone's, and see everyone's activity.
 * Like API keys, only a SHA-256 digest is stored and the token is shown once.
 */
@Injectable()
export class McpTokensService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService,
    private readonly auth: McpAuthService,
  ) {}

  private seesAll(ctx: RequestContext) {
    return holds(ctx, "apikeys.manage");
  }

  /** The rows this person may see: their own, or everyone's for an admin. */
  private visible(ctx: RequestContext) {
    return { workspaceId: ws(ctx).id, ...(this.seesAll(ctx) ? {} : { userId: me(ctx).userId }) };
  }

  private async people(ids: string[]): Promise<Map<string, Person>> {
    const unique = [...new Set(ids)];
    if (!unique.length) return new Map();
    const users = await this.prisma.db.user.findMany({ where: { id: { in: unique } }, select: { id: true, name: true, email: true } });
    return new Map(users.map((u) => [u.id, u]));
  }

  async list(ctx: RequestContext) {
    const rows = await this.prisma.db.mcpToken.findMany({ where: this.visible(ctx), orderBy: { createdAt: "desc" }, take: 200 });
    const people = await this.people(rows.map((r) => r.userId));
    const order: Record<McpTokenStatus, number> = { active: 0, expired: 1, revoked: 2 };
    const viewer = me(ctx).userId;
    const items = rows.map((r) => tokenDto(r, people.get(r.userId) ?? null, viewer)).sort((a, b) => order[a.status] - order[b.status]);
    return { url: this.auth.endpointUrl(), seesAll: this.seesAll(ctx), items };
  }

  async create(ctx: RequestContext, input: McpTokenInputT) {
    const w = ws(ctx);
    const person = me(ctx);
    await this.entitlements.assertFeature(w.billingAccountId, "apiAccess");
    if (input.expiresAt && input.expiresAt.getTime() <= Date.now()) {
      throw badRequest("The expiry date must be in the future", { expiresAt: "Must be in the future" });
    }
    const now = new Date();
    const active = await this.prisma.db.mcpToken.count({
      // Personal tokens only: OAuth connections have their own cap (McpOAuthService).
      where: { workspaceId: w.id, userId: person.userId, oauthClientId: null, revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
    });
    if (active >= MAX_MCP_TOKENS) throw conflict(`You can have up to ${MAX_MCP_TOKENS} active MCP tokens in a workspace. Revoke one you no longer use.`);

    const secret = `${MCP_TOKEN_PREFIX}${newToken(32)}`;
    const row = await this.prisma.db.mcpToken.create({
      data: {
        workspaceId: w.id,
        userId: person.userId,
        name: input.name,
        prefix: secret.slice(0, SHOWN_PREFIX),
        tokenHash: hashToken(secret),
        access: input.access,
        expiresAt: input.expiresAt ?? null,
      },
    });
    await this.audit.record(ctx, {
      action: "mcp_token.created",
      targetType: "mcp_token",
      targetId: row.id,
      metadata: { name: row.name, prefix: row.prefix, access: row.access, expiresAt: row.expiresAt },
    });
    // The only time the token is readable.
    return { ...tokenDto(row, { id: person.userId, name: person.name, email: person.email }, person.userId), secret, url: this.auth.endpointUrl() };
  }

  /** Immediate: the next request with the token is refused, and what it had prepared is dropped. Revoking twice is harmless. */
  async revoke(ctx: RequestContext, id: string) {
    const existing = await this.prisma.db.mcpToken.findFirst({ where: { id, ...this.visible(ctx) } });
    if (!existing) throw notFound("That MCP token");
    if (existing.revokedAt) return { revoked: true };
    const now = new Date();
    await this.prisma.db.mcpToken.updateMany({ where: { id, workspaceId: existing.workspaceId, revokedAt: null }, data: { revokedAt: now } });
    await this.prisma.db.mcpPendingAction.updateMany({
      where: { workspaceId: existing.workspaceId, tokenId: id, confirmedAt: null, canceledAt: null },
      data: { canceledAt: now },
    });
    await this.audit.record(ctx, {
      // Disconnecting an app connected with "Add custom connector" (OAuth) revokes its connection.
      action: existing.oauthClientId ? "mcp.app_disconnected" : "mcp_token.revoked",
      targetType: "mcp_token",
      targetId: existing.id,
      metadata: { name: existing.name, prefix: existing.prefix, owner: existing.userId, ...(existing.oauthClientId ? { client: existing.clientName, by: "settings" } : {}) },
    });
    return { revoked: true };
  }

  /** The last 50 tool calls (the call log keeps 90 days). */
  async activity(ctx: RequestContext) {
    const rows = await this.prisma.db.mcpCall.findMany({
      where: this.visible(ctx),
      orderBy: { createdAt: "desc" },
      take: 50,
      include: { token: { select: { name: true, access: true } } },
    });
    const people = await this.people(rows.map((r) => r.userId));
    return rows.map((r) => ({
      id: r.id,
      tool: r.tool,
      ok: r.ok,
      error: r.error,
      durationMs: r.durationMs,
      createdAt: r.createdAt,
      token: { id: r.tokenId, name: r.token.name, access: r.token.access },
      user: people.get(r.userId) ?? null,
    }));
  }

  /** Important actions prepared through MCP that still wait for the person's go-ahead in their chat. */
  async pending(ctx: RequestContext) {
    const rows = await this.prisma.db.mcpPendingAction.findMany({
      where: { ...this.visible(ctx), confirmedAt: null, canceledAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: "desc" },
      take: 50,
      include: { token: { select: { name: true, access: true } } },
    });
    const people = await this.people(rows.map((r) => r.userId));
    return rows.map((r) => ({
      id: r.id,
      tool: r.tool,
      summary: r.summary,
      details: r.preview,
      createdAt: r.createdAt,
      expiresAt: r.expiresAt,
      token: { id: r.tokenId, name: r.token.name, access: r.token.access },
      user: people.get(r.userId) ?? null,
    }));
  }

  /** Cancels a pending action from the app (Claude can no longer confirm it). */
  async cancelPending(ctx: RequestContext, id: string) {
    const row = await this.prisma.db.mcpPendingAction.findFirst({ where: { id, ...this.visible(ctx) } });
    if (!row) throw notFound("That pending action");
    await this.prisma.db.mcpPendingAction.updateMany({
      where: { id, workspaceId: row.workspaceId, confirmedAt: null, canceledAt: null },
      data: { canceledAt: new Date() },
    });
    await this.audit.record(ctx, { action: "mcp.action_canceled", targetType: "mcp_action", targetId: row.id, metadata: { tool: row.tool, summary: row.summary } });
    return { canceled: true };
  }
}
