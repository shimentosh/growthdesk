import { Inject, Injectable } from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../config/config.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { MailService } from "../core/mail.service.js";
import { AuditService } from "../core/audit.service.js";
import { PlatformSettingsService, type PlatformSettings } from "../core/platform-settings.service.js";
import { SessionService } from "./session.service.js";
import { hashPassword, hashToken, newToken, verifyPassword } from "../common/crypto.js";
import { ApiError, badRequest, conflict, forbidden, notFound, tooMany, unauthorized } from "../common/errors.js";
import type { RequestContext } from "../common/context.js";
import type { SignupAttributionT, SignupErrorCode, SignupMode } from "@growthdesk/shared";
import type { Tx } from "../prisma/prisma.service.js";
import { DISPOSABLE_DOMAINS, domainListed } from "./disposable-domains.js";
import { createSignupProfile } from "./signup-profile.js";

const VERIFY_TTL_MS = 24 * 3600_000;
const RESET_TTL_MS = 3600_000;
const LOCKOUT_WINDOW_MS = 15 * 60_000;
const LOCKOUT_AFTER = 8;
/** Failures for one account across every address: stops a brute force spread over many IPs. Higher than the per-address limit, so locking someone out takes real effort. */
const ACCOUNT_LOCKOUT_AFTER = 30;

/** What a sign-up carries besides the account itself. */
export type SignupExtras = { inviteToken?: string; marketingConsent?: boolean; attribution?: SignupAttributionT | null };

const signupRefused = (code: SignupErrorCode, message: string, status = 403) => new ApiError(status, code, message);

/**
 * The sign-up mode in force. signupMode is the source of truth; an install
 * that closed sign-ups before signupMode existed (signupsOpen=false, mode never
 * stored) stays closed rather than silently reopening.
 */
export function effectiveSignupMode(s: Pick<PlatformSettings, "signupMode" | "signupsOpen">): SignupMode {
  if (!s.signupsOpen && s.signupMode === "open") return "closed";
  return s.signupMode;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionService,
    private readonly mail: MailService,
    private readonly audit: AuditService,
    private readonly platform: PlatformSettingsService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Domain rules: the allow-list (signupDomains), then the admin's blocked domains and, when on, the disposable list. */
  assertEmailDomainAllowed(email: string, s: PlatformSettings) {
    const domain = (email.split("@")[1] ?? "").toLowerCase();
    if (s.signupDomains.length && !s.signupDomains.map((d) => d.toLowerCase()).includes(domain)) {
      throw signupRefused("signup_domain_not_allowed", "Sign-ups are limited to approved email domains on this installation.");
    }
    if (s.extraBlockedDomains.length && domainListed(domain, new Set(s.extraBlockedDomains.map((d) => d.toLowerCase())))) {
      throw signupRefused("signup_domain_blocked", "Sign-ups from this email domain are not accepted. Use your work email address.");
    }
    if (s.blockDisposableDomains && domainListed(domain, DISPOSABLE_DOMAINS)) {
      throw signupRefused("signup_domain_blocked", "Temporary or disposable email addresses can't be used. Sign up with a permanent address.");
    }
  }

  /** A platform sign-up invitation that can still be used, or null. */
  async findUsableInvite(token: string | undefined | null) {
    if (!token || token.length > 200) return null;
    const row = await this.prisma.db.platformSignupInvite.findUnique({ where: { tokenHash: hashToken(token) } });
    if (!row || row.usedAt || row.expiresAt.getTime() <= Date.now()) return null;
    return row;
  }

  /**
   * The sign-up policy for a new account (password or Google). Workspace
   * invitations do not come through here — they stay open in every mode.
   * Returns the platform invitation to claim, if one applies. A valid
   * invitation is the admin's explicit choice, so it skips the domain rules.
   */
  private async assertSignupAllowed(email: string, inviteToken?: string) {
    const s = await this.platform.get();
    const mode = effectiveSignupMode(s);
    if (mode === "closed") throw signupRefused("signup_closed", "New sign-ups are closed on this installation.");
    let invite = await this.findUsableInvite(inviteToken);
    if (invite && invite.email !== email) {
      if (mode === "open") invite = null;
      else throw signupRefused("signup_invite_invalid", `This invitation was sent to a different email address. Sign up with the address it was sent to.`);
    }
    if (!invite && mode !== "open") {
      if (inviteToken) throw signupRefused("signup_invite_invalid", "That invitation link is invalid, already used or expired. Ask for a new one.");
      if (mode === "invite_only") throw signupRefused("signup_invite_required", "Sign-ups are by invitation only on this installation.");
      throw signupRefused("signup_waitlist", "We're onboarding from a waitlist right now. Join it and we'll email you an invitation.");
    }
    if (!invite) this.assertEmailDomainAllowed(email, s);
    return invite;
  }

  /** Marks the invitation used inside the sign-up transaction; a concurrent sign-up with the same link loses. */
  private async claimInvite(tx: Tx, inviteId: string) {
    const claimed = await tx.platformSignupInvite.updateMany({
      where: { id: inviteId, usedAt: null, expiresAt: { gt: new Date() } },
      data: { usedAt: new Date() },
    });
    if (!claimed.count) throw signupRefused("signup_invite_invalid", "That invitation has just been used.", 409);
  }

  /** What the register page needs to know before showing a form. */
  async signupPolicy(inviteToken?: string) {
    const s = await this.platform.get();
    const mode = effectiveSignupMode(s);
    const invite = inviteToken ? await this.findUsableInvite(inviteToken) : null;
    return {
      mode,
      googleEnabled: this.googleEnabled(),
      requiresInvite: mode === "invite_only",
      /** Only when ?invite= was passed: whether that link can still be used, and the address it was sent to. */
      invite: inviteToken ? { valid: Boolean(invite), email: invite?.email ?? null } : null,
    };
  }

  /** Joining the waitlist answers the same way whether or not the address was already on it (or already has an account). */
  async joinWaitlist(input: { email: string; name: string }, attribution: SignupAttributionT | null) {
    const s = await this.platform.get();
    const mode = effectiveSignupMode(s);
    if (mode === "closed") throw signupRefused("signup_closed", "New sign-ups are closed on this installation.");
    if (mode !== "waitlist") throw new ApiError(409, "waitlist_closed", "There is no waitlist right now. Create an account instead.");
    this.assertEmailDomainAllowed(input.email, s);
    const [account, existing] = await Promise.all([
      this.prisma.db.user.findUnique({ where: { email: input.email }, select: { id: true } }),
      this.prisma.db.platformWaitlistEntry.findUnique({ where: { email: input.email } }),
    ]);
    if (account || existing) return { joined: true };
    const utm = Object.fromEntries(Object.entries(attribution ?? {}).filter(([k]) => k.startsWith("utm_")));
    try {
      await this.prisma.db.platformWaitlistEntry.create({ data: { email: input.email, name: input.name, utm } });
    } catch {
      // A concurrent join for the same address: the unique email already holds it.
      return { joined: true };
    }
    await this.mail.sendTemplate("waitlist_confirmed", input.email, { name: input.name });
    return { joined: true };
  }

  /**
   * A new account signs straight in. An address that already has an account
   * gets the same answer (no session) and an email telling its owner, so the
   * form cannot be used to discover who has an account. Null = no session.
   */
  async register(input: { name: string; email: string; password: string; inviteToken?: string; marketingConsent?: boolean }, ctx: RequestContext, attribution: SignupAttributionT | null = null) {
    const invite = await this.assertSignupAllowed(input.email, input.inviteToken);
    // Hashed before the lookup so both answers spend the same scrypt work.
    const passwordHash = await hashPassword(input.password);
    const existing = await this.prisma.db.user.findUnique({ where: { email: input.email } });
    if (existing) {
      await this.notifyAccountExists(existing);
      return null;
    }
    const user = await this.prisma.db.$transaction(async (tx) => {
      if (invite) await this.claimInvite(tx, invite.id);
      // The invitation was emailed to this address, so following it proves the address (as workspace invitations do).
      const created = await tx.user.create({
        data: { email: input.email, name: input.name, passwordHash, ...(invite ? { emailVerifiedAt: new Date() } : {}) },
      });
      await createSignupProfile(tx, created.id, { source: invite ? "invite" : "password", attribution, marketingConsent: input.marketingConsent });
      return created;
    });
    if (!user.emailVerifiedAt) await this.sendVerification(user.id, user.email, user.name);
    await this.audit.record(
      { ...ctx, identity: undefined },
      { action: "auth.registered", targetType: "user", targetId: user.id, metadata: { source: invite ? "invite" : "password" } },
      "user",
    );
    return this.sessions.start(user.id, ctx.ip, ctx.userAgent);
  }

  /** At most three of these an hour per account, so the sign-up form cannot be used to flood someone's inbox. */
  private async notifyAccountExists(user: { id: string; email: string; name: string; suspendedAt: Date | null }) {
    if (user.suspendedAt) return;
    const recent = await this.prisma.db.emailLog.count({
      where: { userId: user.id, template: "account_exists", createdAt: { gt: new Date(Date.now() - 3600_000) } },
    });
    if (recent >= 3) return;
    await this.mail.accountExists(user.email, user.name, user.id);
  }

  async sendVerification(userId: string, email: string, name: string) {
    const token = newToken();
    await this.prisma.db.authToken.create({
      data: { userId, kind: "verify_email", tokenHash: hashToken(token), expiresAt: new Date(Date.now() + VERIFY_TTL_MS) },
    });
    await this.mail.verifyEmail(email, name, token);
  }

  async resendVerification(userId: string) {
    const user = await this.prisma.db.user.findUniqueOrThrow({ where: { id: userId } });
    if (user.emailVerifiedAt) return { alreadyVerified: true };
    const recent = await this.prisma.db.authToken.count({
      where: { userId, kind: "verify_email", createdAt: { gt: new Date(Date.now() - 10 * 60_000) } },
    });
    if (recent >= 3) throw tooMany("Several links were sent in the last few minutes — check your inbox and spam folder.");
    await this.sendVerification(user.id, user.email, user.name);
    return { alreadyVerified: false };
  }

  async verifyEmail(token: string) {
    const row = await this.prisma.db.authToken.findUnique({ where: { tokenHash: hashToken(token) } });
    if (!row || row.kind !== "verify_email" || row.usedAt || row.expiresAt.getTime() < Date.now()) {
      throw badRequest("That link is invalid or has expired. Request a new one from the app.");
    }
    await this.prisma.db.$transaction([
      this.prisma.db.authToken.update({ where: { id: row.id }, data: { usedAt: new Date() } }),
      this.prisma.db.user.update({ where: { id: row.userId }, data: { emailVerifiedAt: new Date() } }),
    ]);
    return { verified: true };
  }

  async login(email: string, password: string, ctx: RequestContext) {
    const key = { email_ip: { email, ip: ctx.ip || "unknown" } };
    const failures = await this.prisma.db.signInFailure.findUnique({ where: key });
    const inWindow = failures && Date.now() - failures.firstAt.getTime() < LOCKOUT_WINDOW_MS;
    if (inWindow && failures.count >= LOCKOUT_AFTER) {
      throw tooMany("Too many failed sign-ins from this network. Wait 15 minutes or reset your password.");
    }
    const acrossAddresses = await this.prisma.db.signInFailure.aggregate({ where: { email, firstAt: { gt: new Date(Date.now() - LOCKOUT_WINDOW_MS) } }, _sum: { count: true } });
    if ((acrossAddresses._sum.count ?? 0) >= ACCOUNT_LOCKOUT_AFTER) {
      throw tooMany("Too many failed sign-ins for this account. Wait 15 minutes or reset your password.");
    }

    const user = await this.prisma.db.user.findUnique({ where: { email } });
    // verifyPassword spends the same scrypt work for unknown accounts, so timing does not reveal which emails exist.
    const ok = await verifyPassword(password, user?.passwordHash);
    if (!user || !ok) {
      await this.prisma.db.signInFailure.upsert({
        where: key,
        create: { email, ip: ctx.ip || "unknown", count: 1, userId: user?.id ?? null },
        update: inWindow ? { count: { increment: 1 }, lastAt: new Date() } : { count: 1, firstAt: new Date(), lastAt: new Date() },
      });
      throw unauthorized("That email and password do not match.");
    }
    if (user.suspendedAt) throw forbidden("This account is suspended. Contact support.");
    await this.prisma.db.signInFailure.deleteMany({ where: { email, ip: ctx.ip || "unknown" } });
    const session = await this.sessions.start(user.id, ctx.ip, ctx.userAgent);
    await this.audit.record({ ...ctx, identity: undefined }, { action: "auth.signed_in", targetType: "user", targetId: user.id }, "user");
    return session;
  }

  /** Always answers the same way, so it cannot be used to discover accounts. */
  async forgotPassword(email: string) {
    const user = await this.prisma.db.user.findUnique({ where: { email } });
    if (!user || user.suspendedAt) return;
    await this.issuePasswordReset(user.id, user.email);
  }

  /** Sends the normal reset email. False when three links already went out in the last 10 minutes. */
  async issuePasswordReset(userId: string, email: string): Promise<boolean> {
    const recent = await this.prisma.db.authToken.count({
      where: { userId, kind: "reset_password", createdAt: { gt: new Date(Date.now() - 10 * 60_000) } },
    });
    if (recent >= 3) return false;
    const token = newToken();
    await this.prisma.db.authToken.create({
      data: { userId, kind: "reset_password", tokenHash: hashToken(token), expiresAt: new Date(Date.now() + RESET_TTL_MS) },
    });
    await this.mail.resetPassword(email, token);
    return true;
  }

  async resetPassword(token: string, password: string) {
    const row = await this.prisma.db.authToken.findUnique({ where: { tokenHash: hashToken(token) } });
    if (!row || row.kind !== "reset_password" || row.usedAt || row.expiresAt.getTime() < Date.now()) {
      throw badRequest("That reset link is invalid or has expired. Ask for a new one.");
    }
    await this.prisma.db.$transaction([
      // Every outstanding reset link dies with this one, not just the link that was followed.
      this.prisma.db.authToken.updateMany({ where: { userId: row.userId, kind: "reset_password", usedAt: null }, data: { usedAt: new Date() } }),
      // Proving control of the mailbox also verifies it.
      this.prisma.db.user.update({
        where: { id: row.userId },
        data: { passwordHash: await hashPassword(password), emailVerifiedAt: new Date() },
      }),
    ]);
    await this.sessions.revokeAllFor(row.userId);
    await this.prisma.db.signInFailure.deleteMany({ where: { userId: row.userId } });
    return { reset: true };
  }

  async changePassword(userId: string, sessionId: string, current: string | undefined, next: string) {
    const user = await this.prisma.db.user.findUniqueOrThrow({ where: { id: userId } });
    if (user.passwordHash && !(current && (await verifyPassword(current, user.passwordHash)))) {
      throw badRequest("Your current password is not right.", { currentPassword: "Incorrect" });
    }
    await this.prisma.db.$transaction([
      this.prisma.db.user.update({ where: { id: userId }, data: { passwordHash: await hashPassword(next) } }),
      // A reset link requested earlier must not undo the new password.
      this.prisma.db.authToken.updateMany({ where: { userId, kind: "reset_password", usedAt: null }, data: { usedAt: new Date() } }),
    ]);
    await this.sessions.revokeAllFor(userId, sessionId);
    return { changed: true };
  }

  async me(userId: string, sessionId: string) {
    const user = await this.prisma.db.user.findUniqueOrThrow({
      where: { id: userId },
      include: {
        memberships: {
          include: { workspace: { select: { id: true, name: true, slug: true, status: true, timezone: true, billingAccountId: true } } },
          orderBy: { createdAt: "asc" },
        },
      },
    });
    const [session, settings] = await Promise.all([this.prisma.db.session.findUnique({ where: { id: sessionId } }), this.platform.get()]);
    return {
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        timezone: user.timezone,
        emailVerified: Boolean(user.emailVerifiedAt),
        platformRole: user.platformRole,
        hasPassword: Boolean(user.passwordHash),
        googleLinked: Boolean(user.googleSub),
      },
      workspaces: user.memberships.map((m) => ({ ...m.workspace, role: m.role })),
      lastWorkspaceId: session?.workspaceId ?? null,
      /** Platform setting: false lets unconfirmed accounts work (the access guard skips its check). */
      emailVerificationRequired: settings.requireEmailVerification,
    };
  }

  async rememberWorkspace(sessionId: string, userId: string, workspaceId: string) {
    const member = await this.prisma.db.membership.findUnique({ where: { workspaceId_userId: { workspaceId, userId } } });
    if (!member) throw notFound("That workspace");
    await this.prisma.db.session.update({ where: { id: sessionId }, data: { workspaceId } });
  }

  async listSessions(userId: string, currentId: string) {
    const rows = await this.prisma.db.session.findMany({
      where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { lastSeenAt: "desc" },
    });
    return rows.map((s) => ({ id: s.id, ip: s.ip, userAgent: s.userAgent, createdAt: s.createdAt, lastSeenAt: s.lastSeenAt, current: s.id === currentId }));
  }

  async revokeSession(userId: string, id: string) {
    const s = await this.prisma.db.session.findFirst({ where: { id, userId } });
    if (!s) throw notFound("That session");
    await this.sessions.revoke(id);
  }

  // ─── Google sign-in (optional; enabled by GOOGLE_CLIENT_ID/SECRET) ─────────

  googleEnabled() {
    return Boolean(this.config.GOOGLE_CLIENT_ID && this.config.GOOGLE_CLIENT_SECRET);
  }

  googleAuthUrl(state: string) {
    const params = new URLSearchParams({
      client_id: this.config.GOOGLE_CLIENT_ID ?? "",
      redirect_uri: `${this.config.PUBLIC_APP_URL.replace(/\/$/, "")}/api/auth/google/callback`,
      response_type: "code",
      scope: "openid email profile",
      state,
      prompt: "select_account",
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
  }

  async googleCallback(code: string, ctx: RequestContext, extras: SignupExtras = {}) {
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: this.config.GOOGLE_CLIENT_ID ?? "",
        client_secret: this.config.GOOGLE_CLIENT_SECRET ?? "",
        redirect_uri: `${this.config.PUBLIC_APP_URL.replace(/\/$/, "")}/api/auth/google/callback`,
        grant_type: "authorization_code",
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const tokens = (await tokenRes.json().catch(() => ({}))) as { access_token?: string; error_description?: string };
    if (!tokenRes.ok || !tokens.access_token) throw badRequest(tokens.error_description ?? "Google sign-in failed");
    const infoRes = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
      headers: { authorization: `Bearer ${tokens.access_token}` },
      signal: AbortSignal.timeout(15_000),
    });
    const info = (await infoRes.json().catch(() => ({}))) as { sub?: string; email?: string; email_verified?: boolean; name?: string };
    if (!info.sub || !info.email || !info.email_verified) throw badRequest("Google did not confirm an email address for that account");
    const email = info.email.toLowerCase();

    let user = await this.prisma.db.user.findUnique({ where: { googleSub: info.sub } });
    if (!user) {
      const byEmail = await this.prisma.db.user.findUnique({ where: { email } });
      if (byEmail && !byEmail.emailVerifiedAt) {
        // Nobody ever proved they own this address, so the password account may
        // be someone else's squat (pre-hijack). Google has proved ownership: the
        // account becomes Google-only and every session and link from before ends.
        user = await this.prisma.db.$transaction(async (tx) => {
          await tx.authToken.updateMany({ where: { userId: byEmail.id, usedAt: null }, data: { usedAt: new Date() } });
          return tx.user.update({ where: { id: byEmail.id }, data: { googleSub: info.sub, emailVerifiedAt: new Date(), passwordHash: null } });
        });
        await this.sessions.revokeAllFor(byEmail.id);
      } else if (byEmail) {
        user = await this.prisma.db.user.update({ where: { id: byEmail.id }, data: { googleSub: info.sub } });
      } else {
        const invite = await this.assertSignupAllowed(email, extras.inviteToken);
        const name = info.name ?? "";
        const sub = info.sub;
        user = await this.prisma.db.$transaction(async (tx) => {
          if (invite) await this.claimInvite(tx, invite.id);
          const created = await tx.user.create({ data: { email, name, googleSub: sub, emailVerifiedAt: new Date() } });
          await createSignupProfile(tx, created.id, {
            source: invite ? "invite" : "google",
            attribution: extras.attribution,
            marketingConsent: extras.marketingConsent,
          });
          return created;
        });
        await this.audit.record(
          { ...ctx, identity: undefined },
          { action: "auth.registered", targetType: "user", targetId: user.id, metadata: { source: invite ? "invite" : "google" } },
          "user",
        );
      }
    }
    if (user.suspendedAt) throw forbidden("This account is suspended. Contact support.");
    return this.sessions.start(user.id, ctx.ip, ctx.userAgent);
  }
}
