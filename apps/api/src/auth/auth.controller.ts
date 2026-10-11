import { Controller, Delete, Get, HttpCode, Param, Patch, Post, Query as Q, Res } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import type { Response } from "express";
import {
  ATTRIBUTION_COOKIE,
  ChangePasswordInput,
  ForgotPasswordInput,
  LoginInput,
  RegisterInput,
  ResetPasswordInput,
  SignupPolicyQuery,
  UpdateProfileInput,
  VerifyEmailInput,
  WaitlistJoinInput,
} from "@growthdesk/shared";
import { z } from "zod";
import { AllowUnverified, Body, Ctx, Public, Query, Raw } from "../common/decorators.js";
import { me, type RequestContext } from "../common/context.js";
import { derivedKey, hmac, newToken, safeEqual } from "../common/crypto.js";
import { isApiError } from "../common/errors.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { AuthService } from "./auth.service.js";
import { SessionService } from "./session.service.js";
import { parseAttributionCookie } from "./signup-profile.js";

/** Carries a Google sign-up's invitation token and consent tick across the OAuth round-trip (validated again on return). */
const OAUTH_SIGNUP_COOKIE = "gd_oauth_signup";

const attributionFrom = (res: Response) => parseAttributionCookie(res.req.cookies?.[ATTRIBUTION_COOKIE]);

/** Sign-in, sign-up and token endpoints. AUTH_RATE_LIMIT exists for tests; production keeps the default. */
const STRICT = { default: { limit: Number(process.env.AUTH_RATE_LIMIT ?? 10), ttl: 60_000 } };

@ApiTags("auth")
@Controller("auth")
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
    private readonly prisma: PrismaService,
  ) {}

  @Public()
  @Get("providers")
  providers() {
    return { google: this.auth.googleEnabled() };
  }

  /** The register page asks first: open form, invitation needed, waitlist form, or closed. */
  @Public()
  @Get("signup-policy")
  signupPolicy(@Query(SignupPolicyQuery) q: z.infer<typeof SignupPolicyQuery>) {
    return this.auth.signupPolicy(q.invite);
  }

  @Public()
  @Throttle(STRICT)
  @Post("register")
  async register(@Body(RegisterInput) body: z.infer<typeof RegisterInput>, @Ctx() ctx: RequestContext, @Res({ passthrough: true }) res: Response) {
    const session = await this.auth.register(body, ctx, attributionFrom(res));
    this.sessions.setCookie(res, session.token);
    return { registered: true };
  }

  @Public()
  @Throttle(STRICT)
  @HttpCode(202)
  @Post("waitlist")
  waitlist(@Body(WaitlistJoinInput) body: z.infer<typeof WaitlistJoinInput>, @Res({ passthrough: true }) res: Response) {
    return this.auth.joinWaitlist(body, attributionFrom(res));
  }

  @Public()
  @Throttle(STRICT)
  @HttpCode(200)
  @Post("login")
  async login(@Body(LoginInput) body: z.infer<typeof LoginInput>, @Ctx() ctx: RequestContext, @Res({ passthrough: true }) res: Response) {
    const session = await this.auth.login(body.email, body.password, ctx);
    this.sessions.setCookie(res, session.token);
    return { signedIn: true };
  }

  @Public()
  @HttpCode(200)
  @Post("logout")
  async logout(@Ctx() ctx: RequestContext, @Res({ passthrough: true }) res: Response) {
    if (ctx.identity) await this.sessions.revoke(ctx.identity.sessionId);
    this.sessions.clearCookie(res);
    return { signedOut: true };
  }

  @AllowUnverified()
  @Get("me")
  me(@Ctx() ctx: RequestContext) {
    const id = me(ctx);
    return this.auth.me(id.userId, id.sessionId);
  }

  @AllowUnverified()
  @Patch("me")
  async updateMe(@Ctx() ctx: RequestContext, @Body(UpdateProfileInput) body: z.infer<typeof UpdateProfileInput>) {
    await this.prisma.db.user.update({ where: { id: me(ctx).userId }, data: body });
    return { updated: true };
  }

  @HttpCode(200)
  @Post("me/workspace/:workspaceId")
  async remember(@Ctx() ctx: RequestContext, @Param("workspaceId") workspaceId: string) {
    const id = me(ctx);
    await this.auth.rememberWorkspace(id.sessionId, id.userId, workspaceId);
    return { ok: true };
  }

  @Public()
  @Throttle(STRICT)
  @HttpCode(200)
  @Post("verify-email")
  verify(@Body(VerifyEmailInput) body: z.infer<typeof VerifyEmailInput>) {
    return this.auth.verifyEmail(body.token);
  }

  @AllowUnverified()
  @Throttle(STRICT)
  @HttpCode(200)
  @Post("resend-verification")
  resend(@Ctx() ctx: RequestContext) {
    return this.auth.resendVerification(me(ctx).userId);
  }

  @Public()
  @Throttle(STRICT)
  @HttpCode(202)
  @Post("forgot-password")
  async forgot(@Body(ForgotPasswordInput) body: z.infer<typeof ForgotPasswordInput>) {
    await this.auth.forgotPassword(body.email);
    return { sent: true };
  }

  @Public()
  @Throttle(STRICT)
  @HttpCode(200)
  @Post("reset-password")
  reset(@Body(ResetPasswordInput) body: z.infer<typeof ResetPasswordInput>) {
    return this.auth.resetPassword(body.token, body.password);
  }

  @AllowUnverified()
  @Throttle(STRICT)
  @HttpCode(200)
  @Post("change-password")
  change(@Ctx() ctx: RequestContext, @Body(ChangePasswordInput) body: z.infer<typeof ChangePasswordInput>) {
    const id = me(ctx);
    return this.auth.changePassword(id.userId, id.sessionId, body.currentPassword, body.newPassword);
  }

  @AllowUnverified()
  @Get("sessions")
  listSessions(@Ctx() ctx: RequestContext) {
    const id = me(ctx);
    return this.auth.listSessions(id.userId, id.sessionId);
  }

  @AllowUnverified()
  @Delete("sessions/:id")
  async revokeSession(@Ctx() ctx: RequestContext, @Param("id") sessionId: string) {
    await this.auth.revokeSession(me(ctx).userId, sessionId);
    return { revoked: true };
  }

  @AllowUnverified()
  @HttpCode(200)
  @Post("sessions/revoke-others")
  async revokeOthers(@Ctx() ctx: RequestContext) {
    const id = me(ctx);
    await this.sessions.revokeAllFor(id.userId, id.sessionId);
    return { revoked: true };
  }

  // ─── Google ────────────────────────────────────────────────────────────────

  @Public()
  @Raw()
  @Get("google/start")
  googleStart(@Res() res: Response, @Q("invite") invite?: string, @Q("consent") consent?: string) {
    if (!this.auth.googleEnabled()) return res.redirect(302, "/login?error=google_unavailable");
    const nonce = newToken(16);
    const state = `${nonce}.${hmac(derivedKey("oauth-state"), nonce, "base64url")}`;
    res.cookie("gd_oauth_state", state, { httpOnly: true, sameSite: "lax", maxAge: 10 * 60_000, path: "/" });
    // From the register page: kept for the callback, where the invitation is checked like any other.
    const signup = { invite: typeof invite === "string" ? invite.slice(0, 200) : "", consent: consent === "1" };
    if (signup.invite || signup.consent) {
      res.cookie(OAUTH_SIGNUP_COOKIE, JSON.stringify(signup), { httpOnly: true, sameSite: "lax", maxAge: 10 * 60_000, path: "/" });
    } else {
      res.clearCookie(OAUTH_SIGNUP_COOKIE, { path: "/" });
    }
    return res.redirect(302, this.auth.googleAuthUrl(state));
  }

  @Public()
  @Raw()
  @Get("google/callback")
  async googleCallback(@Q("code") code: string, @Q("state") state: string, @Ctx() ctx: RequestContext, @Res() res: Response) {
    const cookie = (res.req.cookies?.gd_oauth_state as string | undefined) ?? "";
    res.clearCookie("gd_oauth_state", { path: "/" });
    const signup = readSignupCookie(res.req.cookies?.[OAUTH_SIGNUP_COOKIE]);
    res.clearCookie(OAUTH_SIGNUP_COOKIE, { path: "/" });
    const [nonce, sig] = (state ?? "").split(".");
    const valid = nonce && sig && cookie === state && safeEqual(sig, hmac(derivedKey("oauth-state"), nonce, "base64url"));
    if (!valid || !code) return res.redirect(302, "/login?error=google_state");
    try {
      const session = await this.auth.googleCallback(code, ctx, {
        inviteToken: signup.invite || undefined,
        marketingConsent: signup.consent,
        attribution: attributionFrom(res),
      });
      this.sessions.setCookie(res, session.token);
      return res.redirect(302, "/");
    } catch (e) {
      // A sign-up the policy refused goes back to the register page, which explains the code.
      if (isApiError(e) && e.code.startsWith("signup_")) return res.redirect(302, `/register?error=${encodeURIComponent(e.code)}`);
      return res.redirect(302, "/login?error=google_failed");
    }
  }
}

function readSignupCookie(raw: unknown): { invite: string; consent: boolean } {
  if (typeof raw !== "string" || raw.length > 400) return { invite: "", consent: false };
  try {
    const v = JSON.parse(raw) as { invite?: unknown; consent?: unknown };
    return { invite: typeof v.invite === "string" ? v.invite.slice(0, 200) : "", consent: v.consent === true };
  } catch {
    return { invite: "", consent: false };
  }
}
