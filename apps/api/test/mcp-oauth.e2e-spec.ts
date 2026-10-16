import { createHash, randomBytes } from "node:crypto";
import net, { type AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { auth, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { bootApp, createWorkspace, setPlan, signUp, type Agent, type TestApp } from "./helpers.js";

/*
 * OAuth 2.1 for MCP clients end to end (src/mcp/oauth, docs/MCP.md → "OAuth /
 * claude.ai"): discovery metadata, the 401 challenge, dynamic registration,
 * /oauth/authorize → the consent request → approval by a signed-in person →
 * code exchange with PKCE → MCP calls with the access token → refresh
 * rotation → revocation. The main flow is driven by the SDK's own client
 * (auth() + an OAuthClientProvider) to prove interoperability.
 *
 * PUBLIC_API_URL is set to the test server's own address, so the issuer and
 * the resource are URLs the SDK can actually reach.
 */

const CLAUDE_AI = "https://claude.ai/api/mcp/auth_callback";

async function freePort(): Promise<number> {
  const srv = net.createServer();
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const port = (srv.address() as AddressInfo).port;
  await new Promise<void>((r) => srv.close(() => r()));
  return port;
}

const pkce = () => {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
};

/** An in-memory OAuthClientProvider, as Claude Code or Claude Desktop keep one on disk. */
class MemoryProvider implements OAuthClientProvider {
  client?: OAuthClientInformationMixed;
  saved?: OAuthTokens;
  verifier = "";
  authorizationUrl?: URL;
  constructor(readonly redirect: string) {}
  get redirectUrl() {
    return this.redirect;
  }
  get clientMetadata(): OAuthClientMetadata {
    return { client_name: "Claude Code (e2e)", redirect_uris: [this.redirect], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" };
  }
  clientInformation() {
    return this.client;
  }
  saveClientInformation(info: OAuthClientInformationMixed) {
    this.client = info;
  }
  tokens() {
    return this.saved;
  }
  saveTokens(tokens: OAuthTokens) {
    this.saved = tokens;
  }
  redirectToAuthorization(url: URL) {
    this.authorizationUrl = url;
  }
  saveCodeVerifier(v: string) {
    this.verifier = v;
  }
  codeVerifier() {
    return this.verifier;
  }
}

describe("MCP OAuth", () => {
  let t: TestApp;
  let owner: Agent;
  let w: string;
  let base: string;
  let url: string;
  const clients: Client[] = [];
  const previousApiUrl = process.env.PUBLIC_API_URL;

  const mcpStatus = (token: string) =>
    t
      .http()
      .post("/mcp")
      .set("Authorization", `Bearer ${token}`)
      .set("Accept", "application/json, text/event-stream")
      .send({ jsonrpc: "2.0", id: 1, method: "tools/list" })
      .then((r) => r.status);

  /** Steps a client takes by hand: register, authorize, consent (as `agent`), and the redirect back. */
  async function authorizeManually(opts: { scope?: string; approve?: boolean; access?: "read" | "build" | "send"; agent?: Agent; name?: string } = {}) {
    const reg = await t
      .http()
      .post("/oauth/register")
      .send({ client_name: opts.name ?? "claude.ai", redirect_uris: [CLAUDE_AI] })
      .expect(201);
    const clientId = reg.body.client_id as string;
    const { verifier, challenge } = pkce();
    const res = await t
      .http()
      .get("/oauth/authorize")
      .query({ response_type: "code", client_id: clientId, redirect_uri: CLAUDE_AI, code_challenge: challenge, code_challenge_method: "S256", state: "st-123", resource: url, ...(opts.scope ? { scope: opts.scope } : {}) })
      .expect(302);
    const consent = new URL(res.headers.location!);
    expect(consent.origin + consent.pathname).toBe("http://localhost:3600/oauth/consent");
    const request = consent.searchParams.get("request")!;
    const agent = opts.agent ?? owner;
    const decision = await agent
      .post("/v1/mcp/oauth/consent")
      .send({ request, approve: opts.approve ?? true, workspaceId: w, access: opts.access ?? "build" });
    return { clientId, verifier, request, decision };
  }

  async function exchange(clientId: string, code: string, verifier: string, json = false) {
    const body = { grant_type: "authorization_code", code, redirect_uri: CLAUDE_AI, client_id: clientId, code_verifier: verifier };
    const req = t.http().post("/oauth/token");
    return json ? req.send(body) : req.type("form").send(body);
  }

  beforeAll(async () => {
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    url = `${base}/mcp`;
    process.env.PUBLIC_API_URL = base;
    t = await bootApp();
    await t.app.listen(port, "127.0.0.1");
    owner = await signUp(t, "oauth-owner@acme.test", "Olga Owner");
    w = await createWorkspace(owner, "OAuth Co");
    await setPlan(t, w, "growth");
  });
  afterAll(async () => {
    await Promise.all(clients.map((c) => c.close().catch(() => undefined)));
    await t.close();
    if (previousApiUrl === undefined) delete process.env.PUBLIC_API_URL;
    else process.env.PUBLIC_API_URL = previousApiUrl;
  });

  describe("discovery", () => {
    it("serves protected-resource metadata at the root and path-suffixed URLs", async () => {
      for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
        const res = await t.http().get(path).set("Origin", "https://claude.ai").expect(200);
        expect(res.body).toMatchObject({ resource: url, authorization_servers: [base], bearer_methods_supported: ["header"], scopes_supported: ["mcp:read", "mcp:build", "mcp:send"] });
        expect(res.headers["access-control-allow-origin"]).toBe("*");
      }
      // The web app's /api/mcp alias names itself as the resource.
      const alias = await t.http().get("/.well-known/oauth-protected-resource/api/mcp").expect(200);
      expect(alias.body.resource).toBe("http://localhost:3600/api/mcp");
      // Outside /v1.
      await t.http().get("/v1/.well-known/oauth-protected-resource").expect(404);
    });

    it("serves authorization server metadata", async () => {
      const res = await t.http().get("/.well-known/oauth-authorization-server").expect(200);
      expect(res.body).toMatchObject({
        issuer: base,
        authorization_endpoint: `${base}/oauth/authorize`,
        token_endpoint: `${base}/oauth/token`,
        registration_endpoint: `${base}/oauth/register`,
        revocation_endpoint: `${base}/oauth/revoke`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
        scopes_supported: ["mcp:read", "mcp:build", "mcp:send"],
      });
      // RFC 8414's path-inserted form, for an issuer with a path (PUBLIC_APP_URL/api).
      await t.http().get("/.well-known/oauth-authorization-server/api").expect(200);
    });

    it("answers 401 from /mcp with a resource_metadata challenge", async () => {
      const res = await t.http().post("/mcp").send({ jsonrpc: "2.0", id: 1, method: "tools/list" }).expect(401);
      expect(res.headers["www-authenticate"]).toBe(`Bearer realm="growthdesk", resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`);
      const bad = await t.http().post("/mcp").set("Authorization", "Bearer gdm_nope").send({}).expect(401);
      expect(bad.headers["www-authenticate"]).toContain('error="invalid_token"');
      // Through the web app's proxy, the challenge points at the web alias.
      const proxied = await t.http().post("/mcp").set("x-forwarded-host", "localhost:3600").send({}).expect(401);
      expect(proxied.headers["www-authenticate"]).toContain('resource_metadata="http://localhost:3600/.well-known/oauth-protected-resource/api/mcp"');
    });

    it("lets any origin preflight the token endpoint", async () => {
      const pre = await t.http().options("/oauth/token").set("Origin", "https://claude.ai").set("Access-Control-Request-Method", "POST").expect(204);
      expect(pre.headers["access-control-allow-origin"]).toBe("*");
    });
  });

  describe("registration and authorization requests", () => {
    it("registers public clients with https or loopback redirect URIs only", async () => {
      const ok = await t
        .http()
        .post("/oauth/register")
        .send({ client_name: "Claude", redirect_uris: [CLAUDE_AI, "https://claude.com/api/mcp/auth_callback"], token_endpoint_auth_method: "client_secret_post" })
        .expect(201);
      expect(ok.body).toMatchObject({ client_name: "Claude", token_endpoint_auth_method: "none", redirect_uris: [CLAUDE_AI, "https://claude.com/api/mcp/auth_callback"] });
      expect(ok.body.client_id).toMatch(/^mcp_/);
      expect(ok.body).not.toHaveProperty("client_secret");
      expect(ok.headers["cache-control"]).toBe("no-store");
      for (const bad of [["http://evil.example/cb"], [], ["https://claude.ai/cb#x"], "https://claude.ai/cb"]) {
        const res = await t.http().post("/oauth/register").send({ redirect_uris: bad }).expect(400);
        expect(res.body.error).toBe("invalid_redirect_uri");
      }
    });

    it("refuses unknown clients and unregistered redirect URIs without redirecting to them", async () => {
      const unknown = await t.http().get("/oauth/authorize").query({ client_id: "mcp_nope", redirect_uri: CLAUDE_AI }).expect(302);
      expect(unknown.headers.location).toBe("http://localhost:3600/oauth/consent?error=invalid_client");
      const reg = await t.http().post("/oauth/register").send({ redirect_uris: [CLAUDE_AI] }).expect(201);
      const wrong = await t.http().get("/oauth/authorize").query({ client_id: reg.body.client_id, redirect_uri: "https://evil.example/cb" }).expect(302);
      expect(wrong.headers.location).toBe("http://localhost:3600/oauth/consent?error=invalid_redirect_uri");
    });

    it("sends other problems back to the client, with the state", async () => {
      const reg = await t.http().post("/oauth/register").send({ redirect_uris: [CLAUDE_AI] }).expect(201);
      const q = { client_id: reg.body.client_id, redirect_uri: CLAUDE_AI, response_type: "code", state: "s1" };
      const noPkce = new URL((await t.http().get("/oauth/authorize").query(q).expect(302)).headers.location!);
      expect(noPkce.origin + noPkce.pathname).toBe(CLAUDE_AI);
      expect(noPkce.searchParams.get("error")).toBe("invalid_request");
      expect(noPkce.searchParams.get("state")).toBe("s1");
      const plain = new URL((await t.http().get("/oauth/authorize").query({ ...q, code_challenge: pkce().challenge, code_challenge_method: "plain" }).expect(302)).headers.location!);
      expect(plain.searchParams.get("error")).toBe("invalid_request");
      const target = new URL(
        (await t.http().get("/oauth/authorize").query({ ...q, code_challenge: pkce().challenge, code_challenge_method: "S256", resource: "https://other.example/mcp" }).expect(302)).headers.location!,
      );
      expect(target.searchParams.get("error")).toBe("invalid_target");
    });

    it("needs a signed-in person, and an untampered request, for the consent screen", async () => {
      const { request } = await authorizeManually({ approve: false });
      await t.http().get("/v1/mcp/oauth/consent").query({ request }).expect(401);
      await t.http().post("/v1/mcp/oauth/consent").send({ request, approve: true, workspaceId: w, access: "build" }).expect(401);
      const info = await owner.get("/v1/mcp/oauth/consent").query({ request }).expect(200);
      expect(info.body.data).toMatchObject({ client: { name: "claude.ai", redirectHost: "claude.ai" }, maxAccess: "send", defaultAccess: "build", problem: null });
      expect(info.body.data.workspaces).toEqual([expect.objectContaining({ id: w, name: "OAuth Co", available: true })]);
      const res = await owner.get("/v1/mcp/oauth/consent").query({ request: `${request.slice(0, -2)}xx` }).expect(400);
      expect(res.body.error.code).toBe("oauth_request_expired");
      // A cross-site form cannot approve on the person's behalf.
      await owner.post("/v1/mcp/oauth/consent").set("Origin", "https://evil.example").send({ request, approve: true, workspaceId: w }).expect(403);
    });

    it("returns access_denied when the person declines", async () => {
      const { decision } = await authorizeManually({ approve: false });
      expect(decision.status).toBe(200);
      const back = new URL(decision.body.data.redirectTo);
      expect(back.origin + back.pathname).toBe(CLAUDE_AI);
      expect(back.searchParams.get("error")).toBe("access_denied");
      expect(back.searchParams.get("state")).toBe("st-123");
      expect(back.searchParams.has("code")).toBe(false);
    });

    it("never grants more than the scope asked for", async () => {
      const { decision, request } = await authorizeManually({ scope: "mcp:read", access: "build" });
      expect(decision.status).toBe(400);
      const info = await owner.get("/v1/mcp/oauth/consent").query({ request }).expect(200);
      expect(info.body.data).toMatchObject({ maxAccess: "read", defaultAccess: "read" });
    });
  });

  describe("tokens", () => {
    it("connects through the SDK's OAuth client: register → authorize → consent → token → tools → refresh → revoke", async () => {
      const provider = new MemoryProvider("http://127.0.0.1:65530/callback");
      expect(await auth(provider, { serverUrl: url })).toBe("REDIRECT");
      expect(provider.client?.client_id).toMatch(/^mcp_/);
      const authUrl = provider.authorizationUrl!;
      expect(authUrl.origin + authUrl.pathname).toBe(`${base}/oauth/authorize`);
      expect(authUrl.searchParams.get("code_challenge_method")).toBe("S256");
      expect(authUrl.searchParams.get("resource")).toBe(url);

      // The browser: /oauth/authorize → the consent page → approve as the signed-in owner.
      const toConsent = await t.http().get(`${authUrl.pathname}${authUrl.search}`).expect(302);
      const request = new URL(toConsent.headers.location!).searchParams.get("request")!;
      const info = await owner.get("/v1/mcp/oauth/consent").query({ request }).expect(200);
      expect(info.body.data.client.name).toBe("Claude Code (e2e)");
      const decision = await owner.post("/v1/mcp/oauth/consent").send({ request, approve: true, workspaceId: w, access: "build" }).expect(200);
      const back = new URL(decision.body.data.redirectTo);
      expect(back.origin + back.pathname).toBe("http://127.0.0.1:65530/callback");
      expect(back.searchParams.get("state")).toBe(authUrl.searchParams.get("state"));
      const code = back.searchParams.get("code")!;
      expect(code).toBeTruthy();
      const stored = await t.prisma.db.mcpOAuthCode.findFirstOrThrow({ where: { clientId: provider.client!.client_id } });
      expect(stored.codeHash).not.toContain(code);

      // The app exchanges the code (with its PKCE verifier).
      expect(await auth(provider, { serverUrl: url, authorizationCode: code })).toBe("AUTHORIZED");
      const first = provider.saved!;
      expect(first.access_token).toMatch(/^gdm_/);
      expect(first.refresh_token).toMatch(/^gdr_/);
      expect(first.scope).toBe("mcp:read mcp:build");

      // A code works once.
      const again = await exchange(provider.client!.client_id, code, provider.verifier);
      expect(again.status).toBe(400);
      expect(again.body.error).toBe("invalid_grant");

      // MCP with the access token.
      const client = new Client({ name: "growthdesk-oauth-e2e", version: "1.0.0" });
      await client.connect(new StreamableHTTPClientTransport(new URL(url), { authProvider: provider }));
      clients.push(client);
      const tools = await client.listTools();
      expect(tools.tools.map((x) => x.name)).toContain("whoami");
      const whoami = (await client.callTool({ name: "whoami", arguments: {} })) as CallToolResult;
      expect(whoami.isError).toBeFalsy();
      expect((whoami.content[0] as { text: string }).text).toContain("build");

      // Settings shows one connection for the app.
      const list = await owner.get(`/v1/workspaces/${w}/mcp/tokens`).expect(200);
      const conn = list.body.data.items.filter((i: { viaOAuth: boolean }) => i.viaOAuth);
      expect(conn).toEqual([expect.objectContaining({ name: "Claude Code (e2e) (OAuth)", clientName: "Claude Code (e2e)", access: "build", status: "active" })]);
      const audit = await t.prisma.db.auditEvent.findFirst({ where: { workspaceId: w, action: "mcp.app_connected" } });
      expect(audit?.actorUserId).toBe(owner.userId);

      // Refresh: the SDK uses the refresh token; both tokens rotate on the same row.
      expect(await auth(provider, { serverUrl: url })).toBe("AUTHORIZED");
      const second = provider.saved!;
      expect(second.access_token).not.toBe(first.access_token);
      expect(second.refresh_token).not.toBe(first.refresh_token);
      expect(await mcpStatus(first.access_token)).toBe(401);
      expect(await mcpStatus(second.access_token)).toBe(200);
      const replay = await t.http().post("/oauth/token").type("form").send({ grant_type: "refresh_token", refresh_token: first.refresh_token, client_id: provider.client!.client_id });
      expect(replay.status).toBe(400);
      expect(replay.body.error).toBe("invalid_grant");
      const rows = await t.prisma.db.mcpToken.findMany({ where: { oauthClientId: provider.client!.client_id } });
      expect(rows).toHaveLength(1);
      expect(rows[0]!.id).toBe(conn[0].id);

      // Revocation (RFC 7009): the connection ends, whichever of its tokens is presented.
      await t.http().post("/oauth/revoke").type("form").send({ token: second.refresh_token, client_id: provider.client!.client_id }).expect(200);
      expect(await mcpStatus(second.access_token)).toBe(401);
      const refreshAfter = await t.http().post("/oauth/token").type("form").send({ grant_type: "refresh_token", refresh_token: second.refresh_token });
      expect(refreshAfter.body.error).toBe("invalid_grant");
      // Unknown tokens are fine.
      await t.http().post("/oauth/revoke").type("form").send({ token: "gdm_unknown" }).expect(200);
      expect(await t.prisma.db.auditEvent.count({ where: { workspaceId: w, action: "mcp.app_disconnected" } })).toBe(1);
    });

    it("exchanges codes sent as JSON, refuses a wrong verifier, and never caches", async () => {
      const a = await authorizeManually({ name: "JSON client" });
      const code = new URL(a.decision.body.data.redirectTo).searchParams.get("code")!;
      const wrong = await exchange(a.clientId, code, pkce().verifier, true);
      expect(wrong.status).toBe(400);
      expect(wrong.body).toMatchObject({ error: "invalid_grant", error_description: expect.stringMatching(/PKCE/) });

      const b = await authorizeManually({ name: "JSON client" });
      const ok = await exchange(b.clientId, new URL(b.decision.body.data.redirectTo).searchParams.get("code")!, b.verifier, true);
      expect(ok.status).toBe(200);
      expect(ok.headers["cache-control"]).toBe("no-store");
      expect(ok.body).toMatchObject({ token_type: "Bearer", expires_in: 3600, scope: "mcp:read mcp:build" });

      const unsupported = await t.http().post("/oauth/token").type("form").send({ grant_type: "client_credentials" });
      expect(unsupported.body.error).toBe("unsupported_grant_type");
    });

    it("refuses an expired code", async () => {
      const a = await authorizeManually();
      const code = new URL(a.decision.body.data.redirectTo).searchParams.get("code")!;
      await t.prisma.db.mcpOAuthCode.updateMany({ where: { clientId: a.clientId }, data: { expiresAt: new Date(Date.now() - 1000) } });
      const res = await exchange(a.clientId, code, a.verifier);
      expect(res.body).toMatchObject({ error: "invalid_grant", error_description: expect.stringMatching(/expired/) });
    });

    it("can be disconnected from Settings", async () => {
      const a = await authorizeManually({ name: "Desktop", access: "read" });
      const exchanged = await exchange(a.clientId, new URL(a.decision.body.data.redirectTo).searchParams.get("code")!, a.verifier);
      expect(exchanged.status).toBe(200);
      const tokens = exchanged.body as OAuthTokens;
      expect(tokens.scope).toBe("mcp:read");
      expect(await mcpStatus(tokens.access_token)).toBe(200);
      const row = await t.prisma.db.mcpToken.findFirstOrThrow({ where: { oauthClientId: a.clientId } });
      await owner.delete(`/v1/workspaces/${w}/mcp/tokens/${row.id}`).expect(200);
      expect(await mcpStatus(tokens.access_token)).toBe(401);
      const refresh = await t.http().post("/oauth/token").type("form").send({ grant_type: "refresh_token", refresh_token: tokens.refresh_token });
      expect(refresh.body.error).toBe("invalid_grant");
      expect(await t.prisma.db.auditEvent.count({ where: { workspaceId: w, action: "mcp.app_disconnected", targetId: row.id } })).toBe(1);
    });
  });
});
