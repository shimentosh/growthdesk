/*
 * Shapes of the MCP settings responses — apps/api/src/mcp/mcp-tokens.service.ts.
 * The full token is part of a response once, on creation, and never again.
 */
import type { McpAccess } from "@growthdesk/shared";

export type McpTokenStatus = "active" | "expired" | "revoked";

type Person = { id: string; name: string; email: string };

/** One token — `tokenDto()` (active first, then expired, then revoked). */
export type McpToken = {
  id: string;
  name: string;
  /** "gdm_" + the next 8 characters, kept in clear so tokens can be told apart. */
  prefix: string;
  access: McpAccess;
  status: McpTokenStatus;
  /** The MCP client that connected with it ("Claude Code", "claude-ai", …), once one has. */
  clientName: string | null;
  /** Issued by "Connect with your Growthdesk login" (claude.ai) rather than created here. */
  viaOAuth: boolean;
  user: Person | null;
  mine: boolean;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
};

/** GET /mcp/tokens — the caller's tokens (everyone's for holders of apikeys.manage) and the endpoint URL. */
export type McpTokenList = { url: string; seesAll: boolean; items: McpToken[] };

/** POST /mcp/tokens — the token plus its secret (the only time it is returned). */
export type McpTokenWithSecret = McpToken & { secret: string; url: string };

/** GET /mcp/activity — the last 50 tool calls. */
export type McpCall = {
  id: string;
  tool: string;
  ok: boolean;
  error: string | null;
  durationMs: number;
  createdAt: string;
  token: { id: string; name: string; access: McpAccess };
  user: Person | null;
};

/** GET /mcp/pending — important actions waiting for approval in a chat. */
export type McpPendingAction = {
  id: string;
  tool: string;
  summary: string;
  details: Record<string, unknown>;
  createdAt: string;
  expiresAt: string;
  token: { id: string; name: string; access: McpAccess };
  user: Person | null;
};

/** GET /mcp/oauth/consent?request=… — what the consent page shows (apps/api/src/mcp/oauth/mcp-oauth.service.ts). */
export type McpOAuthConsent = {
  client: { id: string; name: string; redirectHost: string };
  user: { name: string; email: string };
  /** The most this app asked for; the page offers nothing above it. */
  maxAccess: McpAccess;
  defaultAccess: McpAccess;
  /** Something about the account that blocks connecting (unconfirmed email), or null. */
  problem: string | null;
  workspaces: { id: string; name: string; role: string; available: boolean; reason: string | null }[];
  expiresAt: string;
};

/** POST /mcp/oauth/consent — where to send the browser: back to the app with a code, or with access_denied. */
export type McpOAuthDecision = { redirectTo: string };
