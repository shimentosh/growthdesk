import { Inject, Injectable } from "@nestjs/common";
import type { Response } from "express";
import { APP_CONFIG, type AppConfig } from "../config/config.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { hashToken, newToken } from "../common/crypto.js";
import type { Identity } from "../common/context.js";

export const SESSION_COOKIE = "gd_session";
const SLIDE_EVERY_MS = 10 * 60_000;

/*
 * Opaque, server-side sessions (LinkDesk's model): the cookie holds 32 random
 * bytes, the database holds only their SHA-256, so a stolen sessions table
 * cannot be replayed. Sessions slide while in use and can be revoked one at a
 * time or all at once (password change/reset, suspension).
 *
 * Unlike LinkDesk, a session is not pinned to one workspace: the workspace is
 * part of each request's path and membership is checked per request, which
 * is what lets one person work in several workspaces.
 */
@Injectable()
export class SessionService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  private get maxAgeMs() {
    return this.config.SESSION_DAYS * 86_400_000;
  }

  async start(userId: string, ip: string, userAgent: string): Promise<{ token: string; expiresAt: Date; id: string }> {
    const token = newToken();
    const expiresAt = new Date(Date.now() + this.maxAgeMs);
    const row = await this.prisma.db.session.create({
      data: { userId, tokenHash: hashToken(token), ip, userAgent: userAgent.slice(0, 500), expiresAt },
    });
    await this.prisma.db.user.update({ where: { id: userId }, data: { lastLoginAt: new Date() } });
    return { token, expiresAt, id: row.id };
  }

  /** The signed-in person for a cookie token, sliding its expiry when due. Null when invalid, expired, revoked or suspended. */
  async resolve(token: string | undefined | null): Promise<{ identity: Identity; renew: boolean } | null> {
    if (!token || token.length > 200) return null;
    const session = await this.prisma.db.session.findUnique({
      where: { tokenHash: hashToken(token) },
      include: { user: true },
    });
    if (!session || session.revokedAt || session.expiresAt.getTime() <= Date.now()) return null;
    if (session.user.suspendedAt) return null;
    let renew = false;
    if (Date.now() - session.lastSeenAt.getTime() > SLIDE_EVERY_MS) {
      await this.prisma.db.session.update({
        where: { id: session.id },
        data: { lastSeenAt: new Date(), expiresAt: new Date(Date.now() + this.maxAgeMs) },
      });
      renew = true;
    }
    return {
      renew,
      identity: {
        userId: session.userId,
        email: session.user.email,
        name: session.user.name,
        platformRole: session.user.platformRole,
        emailVerified: Boolean(session.user.emailVerifiedAt),
        sessionId: session.id,
      },
    };
  }

  async revoke(sessionId: string) {
    await this.prisma.db.session.updateMany({ where: { id: sessionId, revokedAt: null }, data: { revokedAt: new Date() } });
  }

  async revokeAllFor(userId: string, exceptSessionId?: string) {
    await this.prisma.db.session.updateMany({
      where: { userId, revokedAt: null, ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}) },
      data: { revokedAt: new Date() },
    });
  }

  setCookie(res: Response, token: string) {
    res.cookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: "lax",
      secure: this.config.PUBLIC_APP_URL.startsWith("https://"),
      path: "/",
      maxAge: this.maxAgeMs,
    });
  }

  clearCookie(res: Response) {
    res.clearCookie(SESSION_COOKIE, { path: "/", httpOnly: true, sameSite: "lax", secure: this.config.PUBLIC_APP_URL.startsWith("https://") });
  }
}
