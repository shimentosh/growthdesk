import { Injectable } from "@nestjs/common";
import { MAX_MCP_TOKENS, MCP_ACCESS_INFO, MCP_ACCESS_LEVELS, MCP_TOKEN_PREFIX, type McpAccess } from "@growthdesk/shared";
import { PrismaService } from "../../prisma/prisma.service.js";
import { AuditService } from "../../core/audit.service.js";
import { PlatformSettingsService } from "../../core/platform-settings.service.js";
import { EntitlementsService } from "../../billing/entitlements.service.js";
import { derivedKey, hashToken, newToken } from "../../common/crypto.js";
import { ApiError, badRequest, forbidden, notFound } from "../../common/errors.js";
import { me, type Identity, type RequestContext } from "../../common/context.js";
import { McpAuthService } from "../mcp-auth.service.js";
import {
  MCP_SCOPES,
  OAuthError,
  accessRank,
  isS256Challenge,
  maxAccessForScope,
  readPayload,
  redirectUriMatches,
  redirectUriProblem,
  scopeFor,
  signPayload,
  verifyPkce,
  withParams,
} from "./oauth.util.js";

/** How long the consent screen has to be answered. */
const REQUEST_TTL_MS = 10 * 60_000;
/** Authorization codes: single use, five minutes. */
const CODE_TTL_MS = 5 * 60_000;
/** Access tokens are short-lived; the client refreshes. */
export const ACCESS_TTL_S = 60 * 60;
/** Refresh tokens: 60 days, renewed (and rotated) on every use. */
export const REFRESH_TTL_MS = 60 * 86_400_000;
const REFRESH_PREFIX = "gdr_";
const CODE_PREFIX = "gdc_";
const SHOWN_PREFIX = MCP_TOKEN_PREFIX.length + 8;
const MAX_REDIRECT_URIS = 10;
const MAX_STATE = 1024;

/** What the signed consent request carries from GET /oauth/authorize to the consent page and back. */
type ConsentRequest = {
  /** client_id */
  c: string;
  /** redirect_uri, exactly as the client sent it */
  r: string;
  /** PKCE S256 code_challenge */
  cc: string;
  /** state, echoed back */
  s: string | null;
  /** the scope the client asked for */
  sc: string | null;
  /** the most the person may grant (from the scope) */
  m: McpAccess;
  exp: number;
};

export type TokenResponse = {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope: string;
};

type Params = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === "string" && v.length ? v : null);

/*
 * Growthdesk's OAuth 2.1 authorization server for MCP clients (docs/MCP.md →
 * "OAuth / claude.ai"), following the MCP Authorization spec (2025-06-18):
 *
 *   RFC 9728 protected-resource metadata → RFC 8414 server metadata →
 *   RFC 7591 dynamic client registration → authorization code + PKCE (S256
 *   only) → refresh tokens, rotated on every use → RFC 7009 revocation.
 *
 * Clients are public (no secret). /oauth/authorize validates the request and
 * hands the browser to the web app's consent page with a signed, ten-minute
 * request; the person, signed in with their ordinary session, picks the
 * workspace and access level there, and the session-authenticated decision
 * route mints a five-minute, single-use code bound to client, redirect URI,
 * PKCE challenge, person, workspace and access level.
 *
 * Tokens: an OAuth connection is ONE McpToken row (oauthClientId set). The
 * access token is its tokenHash (one hour); the refresh token its
 * refreshTokenHash (60 days). A refresh rotates both digests on the same row,
 * so the connection — its name, its pending confirmations, its activity — is
 * stable and Settings shows one entry per connected app. Re-authorizing the
 * same client for the same person and workspace replaces the earlier row.
 * McpAuthService authenticates these tokens exactly like personal ones, so
 * the role ∩ access-level rules are the same.
 */
@Injectable()
export class McpOAuthService {
  private requestKey: Buffer | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: McpAuthService,
    private readonly audit: AuditService,
    private readonly platform: PlatformSettingsService,
    private readonly entitlements: EntitlementsService,
  ) {}

  private key(): Buffer {
    this.requestKey ??= derivedKey("mcp-oauth-consent-request");
    return this.requestKey;
  }

  // ── Metadata ────────────────────────────────────────────────────────────

  issuer(): string {
    return this.auth.apiBase();
  }

  /** RFC 8414. The issuer is the API's public base (PUBLIC_API_URL, else PUBLIC_APP_URL/api). */
  serverMetadata() {
    const issuer = this.issuer();
    return {
      issuer,
      authorization_endpoint: `${issuer}/oauth/authorize`,
      token_endpoint: `${issuer}/oauth/token`,
      registration_endpoint: `${issuer}/oauth/register`,
      revocation_endpoint: `${issuer}/oauth/revoke`,
      response_types_supported: ["code"],
      response_modes_supported: ["query"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      revocation_endpoint_auth_methods_supported: ["none"],
      scopes_supported: [...MCP_SCOPES],
      service_documentation: `${this.auth.appBase()}/`,
    };
  }

  /**
   * RFC 9728. `suffix` is the path after /.well-known/oauth-protected-resource:
   * "/mcp" or "/api/mcp" name a resource; anything else gets the canonical one.
   */
  resourceMetadata(suffix: string) {
    const clean = `/${suffix.replace(/^\/+|\/+$/g, "")}`;
    const resource = this.auth.resourceUrls().find((r) => new URL(r).pathname === clean) ?? this.auth.endpointUrl();
    return {
      resource,
      authorization_servers: [this.issuer()],
      bearer_methods_supported: ["header"],
      scopes_supported: [...MCP_SCOPES],
      resource_name: "Growthdesk",
      resource_documentation: `${this.auth.appBase()}/`,
    };
  }

  // ── Dynamic client registration (RFC 7591) ──────────────────────────────

  async register(body: Params) {
    const uris = body.redirect_uris;
    if (!Array.isArray(uris) || !uris.length) throw new OAuthError("invalid_redirect_uri", "redirect_uris must list at least one redirect URI");
    if (uris.length > MAX_REDIRECT_URIS) throw new OAuthError("invalid_redirect_uri", `At most ${MAX_REDIRECT_URIS} redirect URIs`);
    for (const u of uris) {
      const problem = redirectUriProblem(u);
      if (problem) throw new OAuthError("invalid_redirect_uri", `Redirect URI ${String(u).slice(0, 200)} ${problem}`);
    }
    const grants = body.grant_types;
    if (grants !== undefined && (!Array.isArray(grants) || !grants.includes("authorization_code"))) {
      throw new OAuthError("invalid_client_metadata", "grant_types must include authorization_code");
    }
    const responses = body.response_types;
    if (responses !== undefined && (!Array.isArray(responses) || responses.some((r) => r !== "code"))) {
      throw new OAuthError("invalid_client_metadata", 'Only the "code" response type is supported');
    }
    // Public clients only. A client asking for a secret gets "none" back (RFC 7591 §3.2.1 lets the server choose).
    const name = (str(body.client_name) ?? "MCP client").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 100) || "MCP client";
    const client = await this.prisma.db.mcpOAuthClient.create({
      data: { id: `mcp_${newToken(18)}`, name, redirectUris: [...new Set(uris as string[])] },
    });
    return {
      client_id: client.id,
      client_id_issued_at: Math.floor(client.createdAt.getTime() / 1000),
      client_name: client.name,
      redirect_uris: client.redirectUris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: MCP_SCOPES.join(" "),
    };
  }

  // ── Authorization endpoint ──────────────────────────────────────────────

  /** Where GET /oauth/authorize sends the browser: the consent page, or back to the client with an error. */
  async authorize(q: Params): Promise<string> {
    const consentPage = `${this.auth.appBase()}/oauth/consent`;
    const clientId = str(q.client_id);
    const client = clientId ? await this.prisma.db.mcpOAuthClient.findUnique({ where: { id: clientId } }) : null;
    // Without a known client and a registered redirect URI there is nowhere safe to send an error: show it ourselves.
    if (!client) return `${consentPage}?error=invalid_client`;
    const asked = str(q.redirect_uri);
    const redirectUri = asked ?? (client.redirectUris.length === 1 ? client.redirectUris[0]! : null);
    if (!redirectUri || !redirectUriMatches(client.redirectUris, redirectUri)) return `${consentPage}?error=invalid_redirect_uri`;

    const state = str(q.state);
    const fail = (error: string, description: string) => withParams(redirectUri, { error, error_description: description, state });
    if (state && state.length > MAX_STATE) return fail("invalid_request", "state is too long");
    if (q.response_type !== "code") return fail("unsupported_response_type", 'response_type must be "code"');
    if (!isS256Challenge(str(q.code_challenge))) return fail("invalid_request", "A PKCE code_challenge (S256) is required");
    if (q.code_challenge_method !== "S256") return fail("invalid_request", 'code_challenge_method must be "S256"');
    const resource = str(q.resource);
    if (resource && !this.resourceAllowed(resource)) return fail("invalid_target", "Unknown resource");
    const scope = str(q.scope);

    const request: ConsentRequest = {
      c: client.id,
      r: redirectUri,
      cc: q.code_challenge as string,
      s: state,
      sc: scope,
      m: maxAccessForScope(scope),
      exp: Date.now() + REQUEST_TTL_MS,
    };
    return `${consentPage}?request=${encodeURIComponent(signPayload(this.key(), request))}`;
  }

  private resourceAllowed(resource: string): boolean {
    const norm = (u: string) => u.replace(/\/+$/, "");
    return this.auth.resourceUrls().some((r) => norm(r) === norm(resource));
  }

  private readRequest(token: unknown): ConsentRequest {
    const request = readPayload<ConsentRequest>(this.key(), token);
    if (!request || !MCP_ACCESS_LEVELS.includes(request.m)) {
      throw new ApiError(400, "oauth_request_expired", "This connection request has expired or is not valid. Start connecting again from your app.");
    }
    return request;
  }

  // ── Consent (the web app's /oauth/consent, signed in) ───────────────────

  /** Why a workspace cannot be connected now, or null when it can. */
  private async workspaceProblem(identity: Identity, w: { status: string; requireTwoFactor: boolean; billingAccountId: string; name: string }): Promise<string | null> {
    if (w.status === "suspended") return "This workspace is suspended.";
    if (w.requireTwoFactor && !identity.twoFactor) return `${w.name} requires two-factor authentication — turn it on in your account settings first.`;
    const ent = await this.entitlements.forAccount(w.billingAccountId);
    if (!ent.features.apiAccess) return `The ${ent.effectivePlan.name} plan does not include API access.`;
    return null;
  }

  async consentInfo(ctx: RequestContext, token: string) {
    const request = this.readRequest(token);
    const person = me(ctx);
    const client = await this.prisma.db.mcpOAuthClient.findUnique({ where: { id: request.c } });
    if (!client) throw new ApiError(400, "oauth_request_expired", "This app is no longer registered. Start connecting again from your app.");
    const memberships = await this.prisma.db.membership.findMany({ where: { userId: person.userId }, include: { workspace: true }, orderBy: { createdAt: "asc" } });
    const workspaces = [];
    for (const m of memberships) {
      if (m.workspace.deletedAt) continue;
      const problem = await this.workspaceProblem(person, m.workspace);
      workspaces.push({ id: m.workspace.id, name: m.workspace.name, role: m.role, available: !problem, reason: problem });
    }
    const verify = !person.emailVerified && (await this.platform.get()).requireEmailVerification;
    return {
      client: { id: client.id, name: client.name, redirectHost: new URL(request.r).host },
      user: { name: person.name, email: person.email },
      maxAccess: request.m,
      defaultAccess: (accessRank(request.m) < accessRank("build") ? request.m : "build") as McpAccess,
      problem: verify ? "Confirm your email address first — check your inbox for the link." : null,
      workspaces,
      expiresAt: new Date(request.exp).toISOString(),
    };
  }

  /** Approve → a single-use code for the client; deny → access_denied. Either way, the URL to send the browser to. */
  async decide(ctx: RequestContext, input: { request: string; approve: boolean; workspaceId?: string | null; access?: McpAccess | null }) {
    const request = this.readRequest(input.request);
    const person = me(ctx);
    const client = await this.prisma.db.mcpOAuthClient.findUnique({ where: { id: request.c } });
    if (!client) throw new ApiError(400, "oauth_request_expired", "This app is no longer registered. Start connecting again from your app.");
    if (!input.approve) {
      return { redirectTo: withParams(request.r, { error: "access_denied", error_description: "The request was declined", state: request.s }) };
    }
    if (!input.workspaceId) throw badRequest("Choose a workspace", { workspaceId: "Choose a workspace" });
    const access = input.access ?? "build";
    if (accessRank(access) > accessRank(request.m)) {
      throw badRequest(`${client.name} asked for at most ${MCP_ACCESS_INFO[request.m].label}`, { access: "More than the app asked for" });
    }
    const membership = await this.prisma.db.membership.findUnique({
      where: { workspaceId_userId: { workspaceId: input.workspaceId, userId: person.userId } },
      include: { workspace: true },
    });
    if (!membership || membership.workspace.deletedAt) throw notFound("That workspace");
    const problem = await this.workspaceProblem(person, membership.workspace);
    if (problem) throw forbidden(problem);

    const code = `${CODE_PREFIX}${newToken(32)}`;
    await this.prisma.db.mcpOAuthCode.create({
      data: {
        codeHash: hashToken(code),
        clientId: client.id,
        userId: person.userId,
        workspaceId: membership.workspaceId,
        access,
        redirectUri: request.r,
        codeChallenge: request.cc,
        codeChallengeMethod: "S256",
        scope: scopeFor(access),
        expiresAt: new Date(Date.now() + CODE_TTL_MS),
      },
    });
    await this.audit.record(ctx, {
      workspaceId: membership.workspaceId,
      action: "mcp.app_connected",
      targetType: "mcp_oauth_client",
      targetId: client.id,
      metadata: { client: client.name, access, redirectHost: new URL(request.r).host },
    });
    return { redirectTo: withParams(request.r, { code, state: request.s }) };
  }

  // ── Token endpoint ──────────────────────────────────────────────────────

  async token(body: Params, basicClientId: string | null): Promise<TokenResponse> {
    const clientId = str(body.client_id) ?? basicClientId;
    switch (body.grant_type) {
      case "authorization_code":
        return this.exchangeCode(body, clientId);
      case "refresh_token":
        return this.refresh(body, clientId);
      default:
        throw new OAuthError("unsupported_grant_type", 'grant_type must be "authorization_code" or "refresh_token"');
    }
  }

  private async exchangeCode(body: Params, clientId: string | null): Promise<TokenResponse> {
    const code = str(body.code);
    if (!code || code.length > 200) throw new OAuthError("invalid_request", "code is required");
    if (!clientId) throw new OAuthError("invalid_client", "client_id is required", 401);
    const resource = str(body.resource);
    if (resource && !this.resourceAllowed(resource)) throw new OAuthError("invalid_target", "Unknown resource");

    const row = await this.prisma.db.mcpOAuthCode.findUnique({ where: { codeHash: hashToken(code) }, include: { client: true } });
    if (!row) throw new OAuthError("invalid_grant", "The authorization code is not valid");
    const now = new Date();
    // Spent on first presentation, whatever follows: a code is never worth a second try.
    const claimed = await this.prisma.db.mcpOAuthCode.updateMany({ where: { id: row.id, usedAt: null }, data: { usedAt: now } });
    if (!claimed.count) throw new OAuthError("invalid_grant", "The authorization code has already been used");
    if (row.expiresAt.getTime() <= now.getTime()) throw new OAuthError("invalid_grant", "The authorization code has expired");
    if (row.clientId !== clientId) throw new OAuthError("invalid_grant", "The authorization code was issued to another client");
    const redirectUri = str(body.redirect_uri);
    if (redirectUri !== row.redirectUri) throw new OAuthError("invalid_grant", "redirect_uri does not match the authorization request");
    if (!verifyPkce(str(body.code_verifier), row.codeChallenge)) throw new OAuthError("invalid_grant", "PKCE verification failed");
    await this.assertStillAllowed(row.userId, row.workspaceId);

    const where = { oauthClientId: row.clientId, userId: row.userId, workspaceId: row.workspaceId, revokedAt: null };
    // The same app signing in again replaces its earlier connection (one entry per app in Settings).
    const replaced = await this.prisma.db.mcpToken.findMany({ where, select: { id: true } });
    if (replaced.length) await this.revokeRows(replaced.map((r) => r.id), row.workspaceId, now);
    const active = await this.prisma.db.mcpToken.count({
      where: { userId: row.userId, workspaceId: row.workspaceId, oauthClientId: { not: null }, revokedAt: null, refreshExpiresAt: { gt: now } },
    });
    if (active >= MAX_MCP_TOKENS) throw new OAuthError("invalid_grant", `Up to ${MAX_MCP_TOKENS} apps can be connected in a workspace. Disconnect one in Settings → MCP / Claude.`);

    const access = row.access;
    const pair = this.newPair();
    await this.prisma.db.mcpToken.create({
      data: {
        workspaceId: row.workspaceId,
        userId: row.userId,
        name: `${row.client.name} (OAuth)`.slice(0, 120),
        clientName: row.client.name,
        oauthClientId: row.clientId,
        access,
        prefix: pair.prefix,
        tokenHash: hashToken(pair.access),
        refreshTokenHash: hashToken(pair.refresh),
        expiresAt: pair.expiresAt,
        refreshExpiresAt: pair.refreshExpiresAt,
      },
    });
    return this.response(pair, access);
  }

  private async refresh(body: Params, clientId: string | null): Promise<TokenResponse> {
    const refresh = str(body.refresh_token);
    if (!refresh || refresh.length > 200) throw new OAuthError("invalid_request", "refresh_token is required");
    const oldHash = hashToken(refresh);
    const row = await this.prisma.db.mcpToken.findUnique({ where: { refreshTokenHash: oldHash } });
    const now = new Date();
    if (!row || !row.oauthClientId || row.revokedAt || !row.refreshExpiresAt || row.refreshExpiresAt.getTime() <= now.getTime()) {
      throw new OAuthError("invalid_grant", "The refresh token is not valid (expired, revoked or already used)");
    }
    if (clientId && clientId !== row.oauthClientId) throw new OAuthError("invalid_grant", "The refresh token was issued to another client");
    await this.assertStillAllowed(row.userId, row.workspaceId);

    const pair = this.newPair();
    // Rotation: the old refresh token (and access token) stop working the moment the new pair exists.
    const rotated = await this.prisma.db.mcpToken.updateMany({
      where: { id: row.id, refreshTokenHash: oldHash, revokedAt: null },
      data: {
        tokenHash: hashToken(pair.access),
        refreshTokenHash: hashToken(pair.refresh),
        prefix: pair.prefix,
        expiresAt: pair.expiresAt,
        refreshExpiresAt: pair.refreshExpiresAt,
      },
    });
    if (!rotated.count) throw new OAuthError("invalid_grant", "The refresh token is not valid (expired, revoked or already used)");
    return this.response(pair, row.access);
  }

  /** The person must still be able to sign in and still belong to the workspace. */
  private async assertStillAllowed(userId: string, workspaceId: string) {
    const membership = await this.prisma.db.membership.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
      include: { workspace: true, user: true },
    });
    if (!membership || membership.workspace.deletedAt || membership.user.suspendedAt || membership.user.closedAt) {
      throw new OAuthError("invalid_grant", "This person can no longer use that workspace");
    }
  }

  private newPair() {
    const now = Date.now();
    const access = `${MCP_TOKEN_PREFIX}${newToken(32)}`;
    return {
      access,
      refresh: `${REFRESH_PREFIX}${newToken(32)}`,
      prefix: access.slice(0, SHOWN_PREFIX),
      expiresAt: new Date(now + ACCESS_TTL_S * 1000),
      refreshExpiresAt: new Date(now + REFRESH_TTL_MS),
    };
  }

  private response(pair: { access: string; refresh: string }, access: McpAccess): TokenResponse {
    return { access_token: pair.access, token_type: "Bearer", expires_in: ACCESS_TTL_S, refresh_token: pair.refresh, scope: scopeFor(access) };
  }

  // ── Revocation (RFC 7009) ───────────────────────────────────────────────

  /** Revokes the connection an access or refresh token belongs to. Unknown tokens are not an error (RFC 7009 §2.2). */
  async revoke(body: Params, basicClientId: string | null, base: Pick<RequestContext, "requestId" | "ip" | "userAgent">) {
    const token = str(body.token);
    if (!token || token.length > 200) throw new OAuthError("invalid_request", "token is required");
    const h = hashToken(token);
    const row = await this.prisma.db.mcpToken.findFirst({ where: { OR: [{ tokenHash: h }, { refreshTokenHash: h }], oauthClientId: { not: null } } });
    const clientId = str(body.client_id) ?? basicClientId;
    if (!row || row.revokedAt || (clientId && clientId !== row.oauthClientId)) return;
    await this.revokeRows([row.id], row.workspaceId, new Date());
    await this.audit.record(
      { ...base, identity: { userId: row.userId } as Identity },
      { workspaceId: row.workspaceId, action: "mcp.app_disconnected", targetType: "mcp_token", targetId: row.id, metadata: { name: row.name, client: row.clientName, by: "client" } },
      "user",
    );
  }

  /** Revokes connections and drops what they had prepared, as revoking a token in Settings does. */
  private async revokeRows(ids: string[], workspaceId: string, now: Date) {
    await this.prisma.db.mcpToken.updateMany({ where: { id: { in: ids }, workspaceId, revokedAt: null }, data: { revokedAt: now } });
    await this.prisma.db.mcpPendingAction.updateMany({
      where: { workspaceId, tokenId: { in: ids }, confirmedAt: null, canceledAt: null },
      data: { canceledAt: now },
    });
  }
}
