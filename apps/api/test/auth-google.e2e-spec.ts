import request from "supertest";
import type { App } from "supertest/types.js";
import { bootApp, signUp, type TestApp } from "./helpers.js";
import { AuthService } from "../src/auth/auth.service.js";

/*
 * Google sign-in linking (docs/GAP_PLAN.md §0.5). Google's endpoints are
 * faked by stubbing fetch for their two URLs.
 */
describe("Google sign-in linking", () => {
  let t: TestApp;
  const realFetch = globalThis.fetch;
  const googleSays = (email: string, sub: string) => {
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.startsWith("https://oauth2.googleapis.com/token")) return new Response(JSON.stringify({ access_token: "tok" }), { status: 200 });
      if (url.startsWith("https://openidconnect.googleapis.com/")) return new Response(JSON.stringify({ sub, email, email_verified: true, name: "Victim" }), { status: 200 });
      return realFetch(input, init);
    }) as typeof fetch;
  };
  const ctx = { requestId: "test", ip: "127.0.0.1", userAgent: "test" };

  beforeAll(async () => {
    t = await bootApp();
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });
  afterAll(async () => t.close());

  it("an unverified password account squatting the email is taken over by Google, ending the squatter's access", async () => {
    const squatter = request.agent(t.app.getHttpServer() as App);
    await squatter.post("/v1/auth/register").send({ name: "Squatter", email: "victim@corp.test", password: "Squatter-pass-9" }).expect(201);
    await squatter.get("/v1/auth/me").expect(200);

    googleSays("victim@corp.test", "google-sub-1");
    await t.app.get(AuthService).googleCallback("code", ctx);

    await squatter.get("/v1/auth/me").expect(401);
    await t.http().post("/v1/auth/login").send({ email: "victim@corp.test", password: "Squatter-pass-9" }).expect(401);
    const user = await t.prisma.db.user.findUniqueOrThrow({ where: { email: "victim@corp.test" } });
    expect(user).toMatchObject({ googleSub: "google-sub-1", passwordHash: null });
    expect(user.emailVerifiedAt).toBeTruthy();
  });

  it("a verified account keeps its password and sessions when Google is linked", async () => {
    const owner = await signUp(t, "owner@corp.test", "Owner", "Owner-pass-99");
    googleSays("owner@corp.test", "google-sub-2");
    await t.app.get(AuthService).googleCallback("code", ctx);
    await owner.get("/v1/auth/me").expect(200);
    await t.http().post("/v1/auth/login").send({ email: "owner@corp.test", password: "Owner-pass-99" }).expect(200);
    expect((await t.prisma.db.user.findUniqueOrThrow({ where: { email: "owner@corp.test" } })).googleSub).toBe("google-sub-2");
  });
});
