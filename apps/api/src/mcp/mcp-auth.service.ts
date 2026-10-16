import { Inject, Injectable } from "@nestjs/common";
import { mcpPermissions, permissionsFor, type RolePermissionOverrides } from "@growthdesk/shared";
import { APP_CONFIG, type AppConfig } from "../config/config.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { PlatformSettingsService } from "../core/platform-settings.service.js";
import { EntitlementsService } from "../billing/entitlements.service.js";
import { hashToken } from "../common/crypto.js";
import { applyTeamVisibility } from "../common/visibility.js";
import { ApiError, forbidden, locked, unauthorized } from "../common/errors.js";
import type { Req } from "../common/context.js";
import { SETTINGS_PATH } from "./access.js";
import type { McpCtx } from "./tool.js";

/*
 * Bearer authentication for POST /mcp. The controller is @Public() to the
 * global AccessGuard (which still sets req.ctx: request id, trusted IP, user
 * agent); this service does the rest, mirroring what the guard does for a
 * signed-in person on a workspace route:
 *
 *   token exists, not revoked, not expired → person not suspended or closed →
 *   still a member → workspace not deleted or suspended → two-factor and email
 *   verification requirements → the plan includes API access.
 *
 * The context it builds acts AS the person (identity = the user, so ownership
 * scopes, audit and "created by" all name them), with their role's
 * permissions narrowed by the token's access level. Session cookies are
 * ignored here: MCP is bearer-only.
 *
 * OAuth (claude.ai custom connectors, src/mcp/oauth) issues McpToken rows too,
 * so this is the one place every MCP request is authenticated; challenge() is
 * the WWW-Authenticate value a 401 carries, pointing at the OAuth metadata.
 */
@Injectable()
export class McpAuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly platform: PlatformSettingsService,
    private readonly entitlements: EntitlementsService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /**
   * The WWW-Authenticate header for a refused request (RFC 6750 + RFC 9728):
   * `resource_metadata` is where an MCP client starts OAuth discovery
   * (src/mcp/oauth). `error="invalid_token"` when a token was sent but refused.
   */
  challenge(req?: Req, tokenSent = false): string {
    const parts = [`realm="growthdesk"`, `resource_metadata="${this.resourceMetadataUrl(this.resourceFor(req))}"`];
    if (tokenSent) parts.push(`error="invalid_token"`);
    return `Bearer ${parts.join(", ")}`;
  }

  /**
   * The API's public base: PUBLIC_API_URL, else the web app's /api proxy.
   * It is also the OAuth issuer, so /oauth/* and /.well-known/* hang off it.
   */
  apiBase(): string {
    return this.config.PUBLIC_API_URL ? this.config.PUBLIC_API_URL.replace(/\/+$/, "") : `${this.appBase()}/api`;
  }

  appBase(): string {
    return this.config.PUBLIC_APP_URL.replace(/\/+$/, "");
  }

  /** Where clients connect: the API's own public URL when it has one, else through the web app's /api proxy. */
  endpointUrl(): string {
    return `${this.apiBase()}/mcp`;
  }

  /**
   * Every public URL the MCP endpoint answers at — the OAuth "resource"
   * values a client may name: the canonical endpointUrl(), and the web app's
   * /api/mcp alias when the API also has its own public URL.
   */
  resourceUrls(): string[] {
    return [...new Set([this.endpointUrl(), `${this.appBase()}/api/mcp`])];
  }

  /** The resource a request was addressed to: the web alias when it came through the web app's proxy, else the canonical URL. */
  resourceFor(req?: Req): string {
    const forwardedHost = req?.headers["x-forwarded-host"];
    const host = Array.isArray(forwardedHost) ? forwardedHost[0] : forwardedHost;
    if (this.config.PUBLIC_API_URL && host && host === new URL(this.config.PUBLIC_APP_URL).host) return `${this.appBase()}/api/mcp`;
    return this.endpointUrl();
  }

  /** RFC 9728 §3.1: /.well-known/oauth-protected-resource inserted between the resource's origin and its path. */
  resourceMetadataUrl(resource = this.endpointUrl()): string {
    const u = new URL(resource);
    return `${u.origin}/.well-known/oauth-protected-resource${u.pathname.replace(/\/+$/, "")}`;
  }

  async authenticate(req: Req): Promise<McpCtx> {
    const header = req.headers.authorization;
    const bearer = header?.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
    if (!bearer || bearer.length > 400) {
      throw unauthorized(`Send an MCP token as "Authorization: Bearer <token>". Create one in ${SETTINGS_PATH}.`);
    }
    // Unscoped by necessity: the token is what tells us the workspace (as for API keys).
    const token = await this.prisma.unscoped.mcpToken.findUnique({ where: { tokenHash: hashToken(bearer) }, include: { user: true, workspace: true } });
    const now = Date.now();
    if (!token || token.revokedAt || (token.expiresAt && token.expiresAt.getTime() <= now)) {
      throw unauthorized(`That MCP token is not valid (revoked, expired or mistyped). Create a new one in ${SETTINGS_PATH}.`);
    }
    const { user, workspace: w } = token;
    if (user.suspendedAt || user.closedAt) throw unauthorized("This account cannot sign in");
    if (w.deletedAt) throw unauthorized("That MCP token is not valid");
    const membership = await this.prisma.db.membership.findUnique({ where: { workspaceId_userId: { workspaceId: w.id, userId: user.id } } });
    if (!membership) throw unauthorized(`${user.name || user.email} is no longer a member of ${w.name}, so this token no longer works.`);
    // As AccessGuard: a paused member's tokens stop working with them.
    if (membership.deactivatedAt) throw new ApiError(403, "member_deactivated", `Your access to ${w.name} is paused. Ask a workspace admin to turn it back on.`);
    if (w.status === "suspended") throw locked(`This workspace is suspended${w.suspendedReason ? `: ${w.suspendedReason}` : ""}. Contact support.`);
    if (w.requireTwoFactor && !user.totpEnabledAt) {
      throw new ApiError(403, "two_factor_required", `${w.name} requires two-factor authentication. Turn it on in your account settings to continue.`);
    }
    if (!user.emailVerifiedAt && (await this.platform.get()).requireEmailVerification) {
      throw forbidden("Confirm your email address first — check your inbox for the link.");
    }
    // The effective plan, so a lapsed trial falls back exactly as it does for API keys.
    await this.entitlements.assertFeature(w.billingAccountId, "apiAccess");

    const rolePermissions = permissionsFor(membership.role, w.rolePermissions as RolePermissionOverrides | null);
    const base = req.ctx ?? { requestId: "", ip: "", userAgent: "" };
    const ctx: McpCtx = {
      requestId: base.requestId,
      ip: base.ip,
      userAgent: base.userAgent,
      identity: {
        userId: user.id,
        email: user.email,
        name: user.name,
        platformRole: user.platformRole,
        emailVerified: Boolean(user.emailVerifiedAt),
        twoFactor: Boolean(user.totpEnabledAt),
        // No browser session: services that key on it (sign-out, session lists) are not reachable from MCP.
        sessionId: `mcp:${token.id}`,
      },
      workspace: {
        id: w.id,
        name: w.name,
        role: membership.role,
        permissions: mcpPermissions(rolePermissions, token.access),
        billingAccountId: w.billingAccountId,
        status: w.status,
        timezone: w.timezone,
        currency: w.currency,
      },
      mcp: { tokenId: token.id, tokenName: token.name, access: token.access, clientName: token.clientName, rolePermissions },
    };
    // Team visibility ("team" mode) narrows members to their own, their teams' and unowned records,
    // exactly as for a browser session — and the role permissions important actions are prepared
    // against lose records.view_all the same way.
    await applyTeamVisibility(this.prisma.db, ctx.workspace, w.settings, membership.role, user.id);
    if (ctx.workspace.visibleUserIds) ctx.mcp.rolePermissions = rolePermissions.filter((p) => p !== "records.view_all");
    req.ctx = ctx;

    const clientName = clientInfoName(req.body);
    if (!token.lastUsedAt || now - token.lastUsedAt.getTime() > 60_000 || (clientName && !token.clientName)) {
      await this.prisma.unscoped.mcpToken
        .update({ where: { id: token.id }, data: { lastUsedAt: new Date(now), ...(clientName && !token.clientName ? { clientName } : {}) } })
        .catch(() => undefined);
    }
    return ctx;
  }
}

/** The client's name from an initialize request ("claude-code", "claude-ai", …), to show next to the token. */
function clientInfoName(body: unknown): string | null {
  const msg = body as { method?: unknown; params?: { clientInfo?: { name?: unknown; title?: unknown } } } | null;
  if (!msg || msg.method !== "initialize") return null;
  const info = msg.params?.clientInfo;
  const name = typeof info?.title === "string" && info.title.trim() ? info.title : typeof info?.name === "string" ? info.name : "";
  return name.trim().slice(0, 100) || null;
}
