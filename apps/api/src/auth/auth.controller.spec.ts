import type { Response } from "express";
import { AuthController } from "./auth.controller.js";
import type { AuthService } from "./auth.service.js";
import type { SessionService } from "./session.service.js";
import type { PrismaService } from "../prisma/prisma.service.js";
import type { TwoFactorService } from "./two-factor.service.js";

/** The Google sign-in cookies follow the session cookie: Secure whenever the app is served over https. */
describe("Google sign-in cookies", () => {
  // The state is signed with a key derived from ENCRYPTION_KEY (a test-only value).
  beforeAll(() => vi.stubEnv("ENCRYPTION_KEY", "dGVzdC1vbmx5LWtleS0zMi1ieXRlcy1sb25nLW9rISE="));
  afterAll(() => vi.unstubAllEnvs());

  async function start(secureCookies: boolean) {
    const auth = { googleEnabled: () => true, googleAuthUrl: (state: string) => `https://accounts.google.com/?state=${state}` } as unknown as AuthService;
    const sessions = { secureCookies } as unknown as SessionService;
    const controller = new AuthController(auth, sessions, {} as PrismaService, {} as TwoFactorService);
    const cookie = vi.fn();
    const res = { cookie, clearCookie: vi.fn(), redirect: vi.fn() } as unknown as Response;
    await controller.googleStart(res, "invite-token", "1");
    return cookie.mock.calls as [string, string, { secure?: boolean; httpOnly?: boolean }][];
  }

  it("marks the state and sign-up cookies Secure in production (https)", async () => {
    const calls = await start(true);
    expect(calls.map(([name]) => name).sort()).toEqual(["gd_oauth_signup", "gd_oauth_state"]);
    for (const [, , options] of calls) expect(options).toMatchObject({ secure: true, httpOnly: true });
  });

  it("leaves them usable on plain-http development installs", async () => {
    for (const [, , options] of await start(false)) expect(options.secure).toBe(false);
  });
});
