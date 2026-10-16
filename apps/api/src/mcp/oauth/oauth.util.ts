import { createHash } from "node:crypto";
import { MCP_ACCESS_LEVELS, type McpAccess } from "@growthdesk/shared";
import { hmac, safeEqual } from "../../common/crypto.js";

/*
 * The pure parts of Growthdesk's OAuth 2.1 authorization server for MCP
 * (docs/MCP.md → "OAuth / claude.ai"), unit-tested in oauth.util.spec.ts:
 * PKCE, redirect URI rules, scopes ↔ access levels, and the signed consent
 * request that carries an authorization request from the API to the web
 * app's consent page and back.
 */

/** One scope per access level; a token's scope string lists every level it includes. */
export const MCP_SCOPES = ["mcp:read", "mcp:build", "mcp:send"] as const;
const SCOPE_OF: Record<McpAccess, (typeof MCP_SCOPES)[number]> = { read: "mcp:read", build: "mcp:build", send: "mcp:send" };

/** "mcp:read mcp:build" for a Build connection. */
export function scopeFor(access: McpAccess): string {
  return MCP_ACCESS_LEVELS.slice(0, MCP_ACCESS_LEVELS.indexOf(access) + 1)
    .map((a) => SCOPE_OF[a])
    .join(" ");
}

/**
 * The most a client may be granted for the scope it asked for: the highest
 * level named. No recognised scope (or none at all) leaves the choice to the
 * person, up to Build + Send. Unknown scopes are ignored rather than refused,
 * so a client that asks for something extra still connects.
 */
export function maxAccessForScope(scope: string | null | undefined): McpAccess {
  const asked = new Set((scope ?? "").split(/\s+/).filter(Boolean));
  const named = MCP_ACCESS_LEVELS.filter((a) => asked.has(SCOPE_OF[a]));
  return named.length ? named[named.length - 1]! : "send";
}

export const accessRank = (a: McpAccess) => MCP_ACCESS_LEVELS.indexOf(a);

/** RFC 7636 S256: BASE64URL(SHA256(verifier)) must equal the challenge. Verifiers are 43–128 unreserved characters. */
export function verifyPkce(verifier: string | null | undefined, challenge: string): boolean {
  if (!verifier || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return false;
  const computed = createHash("sha256").update(verifier).digest("base64url");
  return safeEqual(computed, challenge);
}

/** A S256 code_challenge is 43 base64url characters (a SHA-256 digest). */
export const isS256Challenge = (challenge: string | null | undefined): challenge is string => typeof challenge === "string" && /^[A-Za-z0-9_-]{43}$/.test(challenge);

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Why a redirect URI cannot be registered, or null when it can: an absolute
 * https URL (claude.ai's https://claude.ai/api/mcp/auth_callback), or http on
 * a loopback host for desktop and command-line clients (Claude Code, Claude
 * Desktop). No fragments, no credentials.
 */
export function redirectUriProblem(value: unknown): string | null {
  if (typeof value !== "string" || !value || value.length > 2000) return "must be a URL of at most 2000 characters";
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return "must be an absolute URL";
  }
  if (u.hash || value.includes("#")) return "must not contain a fragment";
  if (u.username || u.password) return "must not contain credentials";
  if (u.protocol === "https:") return null;
  if (u.protocol === "http:" && LOOPBACK_HOSTS.has(u.hostname)) return null;
  return "must use https (or http on localhost / 127.0.0.1 for desktop apps)";
}

/**
 * Exact string match against a registered URI. One allowance, from RFC 8252
 * §7.3: for an http loopback URI the port may differ, because a native app
 * listens on whatever port is free when it signs in.
 */
export function redirectUriMatches(registered: readonly string[], asked: string): boolean {
  if (registered.includes(asked)) return true;
  let a: URL;
  try {
    a = new URL(asked);
  } catch {
    return false;
  }
  if (a.protocol !== "http:" || !LOOPBACK_HOSTS.has(a.hostname)) return false;
  return registered.some((r) => {
    try {
      const u = new URL(r);
      return u.protocol === "http:" && u.hostname === a.hostname && u.pathname === a.pathname && u.search === a.search;
    } catch {
      return false;
    }
  });
}

/** The redirect URI with OAuth response parameters added (keeps any query it already has). */
export function withParams(uri: string, params: Record<string, string | null | undefined>): string {
  const u = new URL(uri);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) u.searchParams.set(k, v);
  return u.toString();
}

/** A compact signed, expiring value: base64url(JSON).hmac. Tamper-evident, not secret. */
export function signPayload(key: Buffer, payload: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${hmac(key, body, "base64url")}`;
}

/** The payload, or null when the signature is wrong, it does not parse, or `exp` (ms) has passed. */
export function readPayload<T extends { exp: number }>(key: Buffer, token: unknown, now = Date.now()): T | null {
  if (typeof token !== "string" || token.length > 8000) return null;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  if (!safeEqual(hmac(key, body, "base64url"), token.slice(dot + 1))) return null;
  try {
    const value = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as T;
    if (typeof value?.exp !== "number" || value.exp <= now) return null;
    return value;
  } catch {
    return null;
  }
}

/** An OAuth error response (RFC 6749 §5.2), thrown inside the OAuth service and written by its controller. */
export class OAuthError extends Error {
  constructor(
    readonly error: string,
    readonly description: string,
    readonly status = 400,
  ) {
    super(description);
    this.name = "OAuthError";
  }
}
