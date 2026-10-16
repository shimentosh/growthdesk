import { createHash, randomBytes } from "node:crypto";
import {
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

const verifier = randomBytes(32).toString("base64url"); // 43 characters
const challenge = createHash("sha256").update(verifier).digest("base64url");

describe("PKCE (S256)", () => {
  it("accepts the verifier the challenge was made from", () => {
    expect(isS256Challenge(challenge)).toBe(true);
    expect(verifyPkce(verifier, challenge)).toBe(true);
  });

  it("refuses a different, missing or malformed verifier", () => {
    expect(verifyPkce(randomBytes(32).toString("base64url"), challenge)).toBe(false);
    expect(verifyPkce(undefined, challenge)).toBe(false);
    expect(verifyPkce("", challenge)).toBe(false);
    expect(verifyPkce("short", challenge)).toBe(false);
    expect(verifyPkce(`${verifier}!`, challenge)).toBe(false);
    // "plain" (verifier === challenge) is not S256.
    expect(verifyPkce(challenge, challenge)).toBe(false);
  });

  it("recognises only a 43-character base64url challenge", () => {
    expect(isS256Challenge("abc")).toBe(false);
    expect(isS256Challenge(`${challenge}=`)).toBe(false);
    expect(isS256Challenge(null)).toBe(false);
  });
});

describe("redirect URIs", () => {
  it("registers https and loopback http only", () => {
    expect(redirectUriProblem("https://claude.ai/api/mcp/auth_callback")).toBeNull();
    expect(redirectUriProblem("https://claude.com/api/mcp/auth_callback")).toBeNull();
    expect(redirectUriProblem("http://localhost:33418/callback")).toBeNull();
    expect(redirectUriProblem("http://127.0.0.1:6274/oauth/callback")).toBeNull();
    expect(redirectUriProblem("http://[::1]:9000/cb")).toBeNull();
    expect(redirectUriProblem("http://evil.example/cb")).toMatch(/https/);
    expect(redirectUriProblem("javascript:alert(1)")).toMatch(/https/);
    expect(redirectUriProblem("https://claude.ai/cb#frag")).toMatch(/fragment/);
    expect(redirectUriProblem("https://user:pw@claude.ai/cb")).toMatch(/credentials/);
    expect(redirectUriProblem("/relative")).toMatch(/absolute/);
    expect(redirectUriProblem(42)).not.toBeNull();
  });

  it("matches exactly, except the port of a loopback URI", () => {
    const registered = ["https://claude.ai/api/mcp/auth_callback", "http://localhost:33418/callback"];
    expect(redirectUriMatches(registered, "https://claude.ai/api/mcp/auth_callback")).toBe(true);
    expect(redirectUriMatches(registered, "https://claude.ai/api/mcp/auth_callback/")).toBe(false);
    expect(redirectUriMatches(registered, "https://claude.ai/api/mcp/auth_callback?x=1")).toBe(false);
    expect(redirectUriMatches(registered, "https://CLAUDE.ai.evil.com/api/mcp/auth_callback")).toBe(false);
    expect(redirectUriMatches(registered, "https://claude.ai:444/api/mcp/auth_callback")).toBe(false);
    expect(redirectUriMatches(registered, "http://localhost:50000/callback")).toBe(true);
    expect(redirectUriMatches(registered, "http://localhost:50000/other")).toBe(false);
    expect(redirectUriMatches(registered, "http://127.0.0.1:33418/callback")).toBe(false);
    expect(redirectUriMatches(registered, "not a url")).toBe(false);
  });

  it("adds response parameters without losing the URI's own query", () => {
    expect(withParams("https://claude.ai/cb?x=1", { code: "c", state: "s&t", skip: null })).toBe("https://claude.ai/cb?x=1&code=c&state=s%26t");
  });
});

describe("scopes and access levels", () => {
  it("lists every level a connection includes", () => {
    expect(scopeFor("read")).toBe("mcp:read");
    expect(scopeFor("build")).toBe("mcp:read mcp:build");
    expect(scopeFor("send")).toBe("mcp:read mcp:build mcp:send");
  });

  it("caps the grant at the highest scope asked for, and leaves it open when none is", () => {
    expect(maxAccessForScope("mcp:read")).toBe("read");
    expect(maxAccessForScope("mcp:read mcp:build")).toBe("build");
    expect(maxAccessForScope("mcp:send")).toBe("send");
    expect(maxAccessForScope("openid profile")).toBe("send");
    expect(maxAccessForScope(undefined)).toBe("send");
  });
});

describe("signed consent requests", () => {
  const key = randomBytes(32);

  it("round-trips, and refuses tampering, another key, or expiry", () => {
    const token = signPayload(key, { c: "client", exp: Date.now() + 60_000 });
    expect(readPayload<{ c: string; exp: number }>(key, token)?.c).toBe("client");
    const [body, sig] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ c: "other", exp: Date.now() + 60_000 })).toString("base64url");
    expect(readPayload(key, `${forged}.${sig}`)).toBeNull();
    expect(readPayload(randomBytes(32), token)).toBeNull();
    expect(readPayload(key, `${body}.`)).toBeNull();
    expect(readPayload(key, signPayload(key, { exp: Date.now() - 1 }))).toBeNull();
    expect(readPayload(key, 123)).toBeNull();
  });
});
