import { Inject, Injectable } from "@nestjs/common";
import type { Response } from "express";
import QRCode from "qrcode";
import { randomBytes } from "node:crypto";
import { APP_CONFIG, type AppConfig } from "../config/config.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { AuditService } from "../core/audit.service.js";
import { BrandingService } from "../core/branding.service.js";
import { SessionService } from "./session.service.js";
import { hashToken, newToken, open, seal, verifyPassword } from "../common/crypto.js";
import { ApiError, badRequest, conflict, forbidden, tooMany } from "../common/errors.js";
import type { RequestContext } from "../common/context.js";
import { matchTotp, newTotpSecret, otpauthUri } from "./totp.js";

/** Holds the pending sign-in between the password (or Google) and the code. HttpOnly: page scripts never see it. */
export const CHALLENGE_COOKIE = "gd_2fa";
const CHALLENGE_TTL_MS = 10 * 60_000;
/** Wrong codes one challenge takes before it is spent and the person must sign in again. */
const CHALLENGE_ATTEMPTS = 5;
/** Wrong codes for one account across every challenge in the window: stops guessing by re-entering the password. */
const ACCOUNT_ATTEMPTS = 10;
const LOCKOUT_WINDOW_MS = 15 * 60_000;
const RECOVERY_CODE_COUNT = 10;
const RECOVERY_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

export type ChallengeStart = { challenge: string; expiresAt: Date };
type FactorUser = { id: string; totpSecret: string | null; totpLastStep: number | null };

const expired = () => new ApiError(401, "two_factor_expired", "This sign-in has expired. Sign in again.");
const wrongCode = () => new ApiError(401, "two_factor_invalid", "That code is not right. Check your authenticator app and try again.", { code: "Incorrect code" });

/** Recovery codes are typed by hand: case, spaces and dashes do not matter. */
const normaliseRecovery = (code: string) => code.toLowerCase().replace(/[^a-z0-9]/g, "");

function newRecoveryCode(): string {
  const bytes = randomBytes(10);
  const chars = Array.from(bytes, (b) => RECOVERY_ALPHABET[b % RECOVERY_ALPHABET.length]).join("");
  return `${chars.slice(0, 5)}-${chars.slice(5)}`;
}

/*
 * TOTP two-factor (docs/GAP_PLAN.md 2.12). The secret is sealed like every
 * other stored credential; recovery codes are stored only as SHA-256 (they
 * carry 49 random bits, so a fast hash is enough) and shown once.
 *
 * Sign-in with two-factor on is two steps: the first factor (password or
 * Google) creates a TwoFactorChallenge instead of a session, and only a
 * correct code against that challenge starts the session. Each challenge
 * allows a few attempts, and the account as a whole is locked for a while
 * after repeated failures, so a code cannot be brute-forced by signing in
 * again and again.
 */
@Injectable()
export class TwoFactorService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
    private readonly branding: BrandingService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  // ─── Enrolment and management ─────────────────────────────────────────────

  async status(userId: string) {
    const [user, remaining, requiredBy] = await Promise.all([
      this.prisma.db.user.findUniqueOrThrow({ where: { id: userId }, select: { totpEnabledAt: true } }),
      this.prisma.db.recoveryCode.count({ where: { userId, usedAt: null } }),
      this.workspacesRequiring(userId),
    ]);
    return {
      enabled: Boolean(user.totpEnabledAt),
      enabledAt: user.totpEnabledAt,
      recoveryCodesRemaining: user.totpEnabledAt ? remaining : 0,
      /** Workspaces this person belongs to that require two-factor. */
      requiredBy,
    };
  }

  /** A fresh secret for the authenticator app. Nothing changes until confirm() sees a code from it. */
  async startEnrolment(userId: string) {
    const user = await this.prisma.db.user.findUniqueOrThrow({ where: { id: userId } });
    if (user.totpEnabledAt) throw conflict("Two-factor authentication is already on. Turn it off first to set up a new app.");
    const secret = newTotpSecret();
    await this.prisma.db.user.update({ where: { id: userId }, data: { totpPendingSecret: seal(secret) } });
    const { productName } = await this.branding.get();
    const uri = otpauthUri(productName, user.email, secret);
    const qrSvg = await QRCode.toString(uri, { type: "svg", margin: 1, errorCorrectionLevel: "M" });
    return { secret, otpauthUri: uri, qrSvg };
  }

  /** The first code proves the app holds the secret; two-factor goes on and the recovery codes are shown, once. */
  async confirmEnrolment(ctx: RequestContext, userId: string, code: string) {
    const user = await this.prisma.db.user.findUniqueOrThrow({ where: { id: userId } });
    if (user.totpEnabledAt) throw conflict("Two-factor authentication is already on.");
    const secret = open(user.totpPendingSecret);
    if (!secret) throw badRequest("Start the setup again — no authenticator app is waiting to be confirmed.");
    const step = matchTotp(secret, code.replace(/\s/g, ""), null);
    if (step === null) throw badRequest("That code is not right. Check the time on your phone and try the newest code.", { code: "Incorrect code" });
    const codes = Array.from({ length: RECOVERY_CODE_COUNT }, newRecoveryCode);
    await this.prisma.db.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: userId },
        data: { totpSecret: user.totpPendingSecret, totpPendingSecret: null, totpEnabledAt: new Date(), totpLastStep: step },
      });
      await tx.recoveryCode.deleteMany({ where: { userId } });
      await tx.recoveryCode.createMany({ data: codes.map((c) => ({ userId, codeHash: hashToken(normaliseRecovery(c)) })) });
    });
    await this.audit.record(ctx, { action: "auth.two_factor_enabled", targetType: "user", targetId: userId }, this.actorType(ctx));
    return { recoveryCodes: codes };
  }

  /** Needs a current code, a recovery code or the password. Refused while a workspace the person belongs to requires it. */
  async disable(ctx: RequestContext, userId: string, proof: { code?: string; password?: string }) {
    const user = await this.prisma.db.user.findUniqueOrThrow({ where: { id: userId } });
    if (!user.totpEnabledAt) return { disabled: true };
    let ok = false;
    if (proof.code) ok = (await this.checkFactor(ctx, user, proof.code)) !== null;
    else if (proof.password) ok = await verifyPassword(proof.password, user.passwordHash);
    if (!ok) {
      throw badRequest(
        proof.code ? "That code is not right." : "Your password is not right.",
        proof.code ? { code: "Incorrect code" } : { password: "Incorrect" },
      );
    }
    const requiredBy = await this.workspacesRequiring(userId);
    if (requiredBy.length) {
      throw conflict(`${requiredBy.map((w) => w.name).join(", ")} ${requiredBy.length === 1 ? "requires" : "require"} two-factor authentication for members, so it can't be turned off.`);
    }
    await this.prisma.db.$transaction([
      this.prisma.db.user.update({ where: { id: userId }, data: { totpSecret: null, totpPendingSecret: null, totpEnabledAt: null, totpLastStep: null } }),
      this.prisma.db.recoveryCode.deleteMany({ where: { userId } }),
    ]);
    await this.audit.record(ctx, { action: "auth.two_factor_disabled", targetType: "user", targetId: userId, metadata: { proof: proof.code ? "code" : "password" } }, this.actorType(ctx));
    return { disabled: true };
  }

  /** New codes replace every old one. Needs a current code from the app. */
  async regenerateRecoveryCodes(ctx: RequestContext, userId: string, code: string) {
    const user = await this.prisma.db.user.findUniqueOrThrow({ where: { id: userId } });
    if (!user.totpEnabledAt) throw conflict("Turn on two-factor authentication first.");
    const step = this.totpStep(user, code);
    if (step === null || !(await this.claimStep(userId, step))) throw badRequest("That code is not right.", { code: "Incorrect code" });
    const codes = Array.from({ length: RECOVERY_CODE_COUNT }, newRecoveryCode);
    await this.prisma.db.$transaction([
      this.prisma.db.recoveryCode.deleteMany({ where: { userId } }),
      this.prisma.db.recoveryCode.createMany({ data: codes.map((c) => ({ userId, codeHash: hashToken(normaliseRecovery(c)) })) }),
    ]);
    await this.audit.record(ctx, { action: "auth.two_factor_recovery_codes_regenerated", targetType: "user", targetId: userId }, this.actorType(ctx));
    return { recoveryCodes: codes };
  }

  // ─── Sign-in challenge ────────────────────────────────────────────────────

  /** Called by AuthService once the first factor is proved, instead of starting a session. */
  async startChallenge(userId: string, ctx: RequestContext, method: "password" | "google"): Promise<ChallengeStart> {
    const challenge = newToken();
    const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS);
    await this.prisma.db.twoFactorChallenge.create({ data: { userId, tokenHash: hashToken(challenge), method, ip: ctx.ip, expiresAt } });
    return { challenge, expiresAt };
  }

  /** A correct TOTP or recovery code against a live challenge starts the session. */
  async completeChallenge(token: string | undefined, code: string, ctx: RequestContext) {
    if (!token || token.length > 200) throw expired();
    const row = await this.prisma.db.twoFactorChallenge.findUnique({ where: { tokenHash: hashToken(token) } });
    if (!row || row.usedAt || row.expiresAt.getTime() <= Date.now()) throw expired();
    const recent = await this.prisma.db.twoFactorChallenge.aggregate({
      where: { userId: row.userId, createdAt: { gt: new Date(Date.now() - LOCKOUT_WINDOW_MS) } },
      _sum: { attempts: true },
    });
    if ((recent._sum.attempts ?? 0) >= ACCOUNT_ATTEMPTS) {
      throw tooMany("Too many wrong codes for this account. Wait 15 minutes, then sign in again.");
    }
    // The attempt is taken before the code is checked, so parallel guesses cannot exceed the limit.
    const took = await this.prisma.db.twoFactorChallenge.updateMany({
      where: { id: row.id, usedAt: null, attempts: { lt: CHALLENGE_ATTEMPTS } },
      data: { attempts: { increment: 1 } },
    });
    if (!took.count) throw new ApiError(401, "two_factor_expired", "Too many wrong codes. Sign in again.");

    const user = await this.prisma.db.user.findUniqueOrThrow({ where: { id: row.userId } });
    if (!user.totpEnabledAt) throw expired();
    const factor = await this.checkFactor({ ...ctx, identity: undefined }, user, code);
    if (!factor) throw wrongCode();
    const spent = await this.prisma.db.twoFactorChallenge.updateMany({ where: { id: row.id, usedAt: null }, data: { usedAt: new Date(), attempts: 0 } });
    if (!spent.count) throw expired();
    if (user.suspendedAt) throw forbidden("This account is suspended. Contact support.");
    const session = await this.sessions.start(user.id, ctx.ip, ctx.userAgent);
    await this.audit.record(
      { ...ctx, identity: undefined },
      { action: "auth.signed_in", targetType: "user", targetId: user.id, metadata: { method: row.method, twoFactor: factor } },
      "user",
    );
    return session;
  }

  setChallengeCookie(res: Response, token: string) {
    res.cookie(CHALLENGE_COOKIE, token, { ...this.cookieOptions(), maxAge: CHALLENGE_TTL_MS });
  }

  clearChallengeCookie(res: Response) {
    res.clearCookie(CHALLENGE_COOKIE, this.cookieOptions());
  }

  // ─── Internals ────────────────────────────────────────────────────────────

  private cookieOptions() {
    return { httpOnly: true, sameSite: "lax" as const, secure: this.config.PUBLIC_APP_URL.startsWith("https://"), path: "/" };
  }

  private actorType(ctx: RequestContext) {
    return ctx.identity && ctx.identity.platformRole !== "none" ? ("platform_admin" as const) : ("user" as const);
  }

  private async workspacesRequiring(userId: string) {
    const rows = await this.prisma.db.membership.findMany({
      where: { userId, workspace: { requireTwoFactor: true } },
      select: { workspace: { select: { id: true, name: true } } },
    });
    return rows.map((r) => r.workspace);
  }

  private totpStep(user: FactorUser, code: string): number | null {
    const secret = open(user.totpSecret);
    if (!secret) return null;
    return matchTotp(secret, code.replace(/\s/g, ""), user.totpLastStep);
  }

  /** Records the step as used; false when a concurrent request already used it (or a later one). */
  private async claimStep(userId: string, step: number) {
    const claimed = await this.prisma.db.user.updateMany({
      where: { id: userId, OR: [{ totpLastStep: null }, { totpLastStep: { lt: step } }] },
      data: { totpLastStep: step },
    });
    return claimed.count === 1;
  }

  /** "totp" or "recovery" when the code is good (and now used), else null. A used recovery code is audited. */
  private async checkFactor(ctx: RequestContext, user: FactorUser, raw: string): Promise<"totp" | "recovery" | null> {
    const code = raw.trim();
    if (/^\d{3}\s?\d{3}$/.test(code)) {
      const step = this.totpStep(user, code);
      return step !== null && (await this.claimStep(user.id, step)) ? "totp" : null;
    }
    const normalised = normaliseRecovery(code);
    if (normalised.length !== 10) return null;
    const used = await this.prisma.db.recoveryCode.updateMany({
      where: { userId: user.id, codeHash: hashToken(normalised), usedAt: null },
      data: { usedAt: new Date() },
    });
    if (!used.count) return null;
    const remaining = await this.prisma.db.recoveryCode.count({ where: { userId: user.id, usedAt: null } });
    await this.audit.record(
      ctx,
      { action: "auth.two_factor_recovery_code_used", targetType: "user", targetId: user.id, metadata: { remaining } },
      ctx.identity ? this.actorType(ctx) : "user",
    );
    return "recovery";
  }
}
