import { createHash, randomBytes } from "node:crypto";
import { hashToken } from "../../common/crypto.js";
import type { PrismaService } from "../../prisma/prisma.service.js";
import type { AuditService } from "../../core/audit.service.js";
import type { PlatformSettingsService } from "../../core/platform-settings.service.js";
import type { EntitlementsService } from "../../billing/entitlements.service.js";
import type { McpAuthService } from "../mcp-auth.service.js";
import { McpOAuthService, REFRESH_TTL_MS } from "./mcp-oauth.service.js";
import { OAuthError } from "./oauth.util.js";

/*
 * The token endpoint's rules against an in-memory stand-in for the three
 * tables it touches: codes are single-use, expire, and are bound to client,
 * redirect URI and PKCE verifier; refresh tokens rotate on the same row.
 */

type Row = Record<string, unknown> & { id: string };

function matches(row: Row, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([k, v]) => {
    if (k === "OR") return (v as Record<string, unknown>[]).some((w) => matches(row, w));
    if (v && typeof v === "object" && !(v instanceof Date)) {
      const op = v as { gt?: Date; in?: unknown[]; not?: unknown };
      if ("gt" in op) return row[k] instanceof Date && (row[k] as Date).getTime() > op.gt!.getTime();
      if ("in" in op) return op.in!.includes(row[k]);
      if ("not" in op) return (row[k] ?? null) !== op.not;
    }
    return (row[k] ?? null) === v;
  });
}

function table(rows: Row[], defaults: () => Record<string, unknown> = () => ({})) {
  let n = 0;
  return {
    rows,
    create: async ({ data }: { data: Record<string, unknown> }) => {
      const row = { id: `row-${++n}`, ...defaults(), ...data } as Row;
      rows.push(row);
      return row;
    },
    findUnique: async ({ where, include }: { where: Record<string, unknown>; include?: Record<string, boolean> }) => {
      const row = rows.find((r) => matches(r, where)) ?? null;
      return row && include?.client ? { ...row, client: CLIENT } : row;
    },
    findFirst: async ({ where }: { where: Record<string, unknown> }) => rows.find((r) => matches(r, where)) ?? null,
    findMany: async ({ where }: { where: Record<string, unknown> }) => rows.filter((r) => matches(r, where)),
    count: async ({ where }: { where: Record<string, unknown> }) => rows.filter((r) => matches(r, where)).length,
    updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      const hit = rows.filter((r) => matches(r, where));
      for (const r of hit) Object.assign(r, data);
      return { count: hit.length };
    },
  };
}

const CLIENT = { id: "mcp_client", name: "Claude", redirectUris: ["https://claude.ai/api/mcp/auth_callback"], createdAt: new Date() };
const REDIRECT = CLIENT.redirectUris[0]!;

function setup() {
  const codes = table([]);
  const tokens = table([], () => ({ revokedAt: null, oauthClientId: null }));
  const pending = table([]);
  const prisma = {
    db: {
      mcpOAuthCode: codes,
      mcpToken: tokens,
      mcpPendingAction: pending,
      membership: {
        findUnique: async () => ({ workspace: { deletedAt: null }, user: { suspendedAt: null, closedAt: null } }),
      },
    },
  } as unknown as PrismaService;
  const service = new McpOAuthService(
    prisma,
    {} as McpAuthService,
    { record: async () => undefined } as unknown as AuditService,
    {} as PlatformSettingsService,
    {} as EntitlementsService,
  );
  const verifier = randomBytes(32).toString("base64url");
  async function code(overrides: Record<string, unknown> = {}) {
    const value = `gdc_${randomBytes(16).toString("base64url")}`;
    await codes.create({
      data: {
        codeHash: hashToken(value),
        clientId: CLIENT.id,
        userId: "u1",
        workspaceId: "w1",
        access: "build",
        redirectUri: REDIRECT,
        codeChallenge: createHash("sha256").update(verifier).digest("base64url"),
        usedAt: null,
        expiresAt: new Date(Date.now() + 60_000),
        ...overrides,
      },
    });
    return value;
  }
  const exchange = (value: string, extra: Record<string, unknown> = {}) =>
    service.token({ grant_type: "authorization_code", code: value, client_id: CLIENT.id, redirect_uri: REDIRECT, code_verifier: verifier, ...extra }, null);
  return { service, codes, tokens, code, exchange };
}

async function oauthError(p: Promise<unknown>): Promise<OAuthError> {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(OAuthError);
  return e as OAuthError;
}

describe("authorization codes", () => {
  it("exchange once for an access token and a refresh token on one connection row", async () => {
    const t = setup();
    const res = await t.exchange(await t.code());
    expect(res.access_token).toMatch(/^gdm_/);
    expect(res.refresh_token).toMatch(/^gdr_/);
    expect(res).toMatchObject({ token_type: "Bearer", expires_in: 3600, scope: "mcp:read mcp:build" });
    expect(t.tokens.rows).toHaveLength(1);
    const row = t.tokens.rows[0]!;
    expect(row).toMatchObject({ oauthClientId: CLIENT.id, clientName: "Claude", name: "Claude (OAuth)", access: "build", tokenHash: hashToken(res.access_token) });
    expect(row.refreshTokenHash).toBe(hashToken(res.refresh_token));
    expect((row.refreshExpiresAt as Date).getTime()).toBeGreaterThan(Date.now() + REFRESH_TTL_MS - 5000);
  });

  it("are single-use", async () => {
    const t = setup();
    const value = await t.code();
    await t.exchange(value);
    expect((await oauthError(t.exchange(value))).error).toBe("invalid_grant");
    expect(t.tokens.rows).toHaveLength(1);
  });

  it("expire", async () => {
    const t = setup();
    const e = await oauthError(t.exchange(await t.code({ expiresAt: new Date(Date.now() - 1) })));
    expect(e.error).toBe("invalid_grant");
    expect(e.description).toMatch(/expired/);
  });

  it("need the PKCE verifier, the same client and the same redirect URI — and are spent by a failed try", async () => {
    const t = setup();
    for (const extra of [{ code_verifier: randomBytes(32).toString("base64url") }, { client_id: "mcp_other" }, { redirect_uri: "https://claude.ai/other" }, { code_verifier: undefined }]) {
      const value = await t.code();
      expect((await oauthError(t.exchange(value, extra))).error).toBe("invalid_grant");
      // The code is gone even for the rightful client.
      expect((await oauthError(t.exchange(value))).error).toBe("invalid_grant");
    }
    expect(t.tokens.rows).toHaveLength(0);
  });

  it("refuse an unknown code and an unsupported grant", async () => {
    const t = setup();
    expect((await oauthError(t.exchange("gdc_nope"))).error).toBe("invalid_grant");
    expect((await oauthError(t.service.token({ grant_type: "password" }, null))).error).toBe("unsupported_grant_type");
  });

  it("replace the same app's earlier connection for the person and workspace", async () => {
    const t = setup();
    await t.exchange(await t.code());
    await t.exchange(await t.code());
    expect(t.tokens.rows).toHaveLength(2);
    expect(t.tokens.rows.filter((r) => r.revokedAt === null)).toHaveLength(1);
  });
});

describe("refresh tokens", () => {
  it("rotate on the same row: the old pair stops working, the new one is issued", async () => {
    const t = setup();
    const first = await t.exchange(await t.code());
    const refreshed = await t.service.token({ grant_type: "refresh_token", refresh_token: first.refresh_token, client_id: CLIENT.id }, null);
    expect(refreshed.refresh_token).not.toBe(first.refresh_token);
    expect(refreshed.access_token).not.toBe(first.access_token);
    expect(t.tokens.rows).toHaveLength(1);
    const row = t.tokens.rows[0]!;
    expect(row.tokenHash).toBe(hashToken(refreshed.access_token));
    expect(row.refreshTokenHash).toBe(hashToken(refreshed.refresh_token));
    // Replaying the old refresh token fails.
    expect((await oauthError(t.service.token({ grant_type: "refresh_token", refresh_token: first.refresh_token, client_id: CLIENT.id }, null))).error).toBe("invalid_grant");
    // The new one works once more.
    await t.service.token({ grant_type: "refresh_token", refresh_token: refreshed.refresh_token }, null);
  });

  it("are refused for another client, after expiry, and after revocation", async () => {
    const t = setup();
    const a = await t.exchange(await t.code());
    expect((await oauthError(t.service.token({ grant_type: "refresh_token", refresh_token: a.refresh_token, client_id: "mcp_other" }, null))).error).toBe("invalid_grant");
    t.tokens.rows[0]!.refreshExpiresAt = new Date(Date.now() - 1);
    expect((await oauthError(t.service.token({ grant_type: "refresh_token", refresh_token: a.refresh_token }, null))).error).toBe("invalid_grant");

    const b = await t.exchange(await t.code());
    await t.service.revoke({ token: b.access_token }, null, { requestId: "r", ip: "", userAgent: "" });
    expect((await oauthError(t.service.token({ grant_type: "refresh_token", refresh_token: b.refresh_token }, null))).error).toBe("invalid_grant");
  });
});
