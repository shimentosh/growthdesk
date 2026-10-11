import { type CanActivate, type ExecutionContext, Inject, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { randomUUID } from "node:crypto";
import type { Response } from "express";
import { permissionsFor, type RolePermissionOverrides } from "@growthdesk/shared";
import { APP_CONFIG, type AppConfig } from "../config/config.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { SESSION_COOKIE, SessionService } from "../auth/session.service.js";
import { PlatformSettingsService } from "../core/platform-settings.service.js";
import { BrandingService } from "../core/branding.service.js";
import { EntitlementsService } from "../billing/entitlements.service.js";
import { hashToken } from "./crypto.js";
import { PLATFORM_RANK, type Req, type RequestContext, clientIpFrom } from "./context.js";
import {
  ALLOW_SUSPENDED,
  ALLOW_UNVERIFIED,
  API_KEY_SCOPE,
  IS_PUBLIC,
  NEEDS_PERMISSION,
  NEEDS_PLATFORM,
} from "./decorators.js";
import { ApiError, forbidden, locked, notFound, unauthorized, unavailable } from "./errors.js";

const UNSAFE = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const API_KEY_PREFIX = "gd_";

/** What each API key scope may do, expressed as workspace permissions. */
const SCOPE_PERMISSIONS: Record<string, string[]> = {
  "leads:write": ["contacts.read", "contacts.write", "contacts.import"],
  "contacts:read": ["contacts.read", "records.view_all"],
  "contacts:write": ["contacts.read", "contacts.write"],
  "campaigns:read": ["campaigns.read"],
};

/*
 * One global guard, in this order:
 *   1. request context (id, trusted client IP, user agent)
 *   2. API key (Bearer) for routes that accept one, else the session cookie
 *   3. cross-site write refusal (Origin must be ours for cookie-authenticated writes)
 *   4. maintenance mode (writes refused except for platform admins)
 *   5. platform-admin rank, for /admin routes
 *   6. workspace membership, from the :workspaceId in the path — never from
 *      anything the browser can claim — then workspace status and permission.
 *
 * A workspace the caller does not belong to answers 404, not 403, so ids
 * cannot be probed for existence.
 */
@Injectable()
export class AccessGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
    private readonly sessions: SessionService,
    private readonly platform: PlatformSettingsService,
    private readonly entitlements: EntitlementsService,
    private readonly branding: BrandingService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== "http") return true;
    const req = context.switchToHttp().getRequest<Req>();
    const res = context.switchToHttp().getResponse<Response>();
    const targets = [context.getHandler(), context.getClass()];
    const meta = <T>(key: string) => this.reflector.getAllAndOverride<T>(key, targets);

    const forwarded = req.headers["x-forwarded-for"];
    req.ctx = {
      requestId: String(req.headers["x-request-id"] ?? randomUUID()).slice(0, 100),
      ip: clientIpFrom(req.socket?.remoteAddress, Array.isArray(forwarded) ? forwarded[0] : forwarded, this.config.TRUSTED_PROXY_HOPS),
      userAgent: String(req.headers["user-agent"] ?? "").slice(0, 500),
    };
    const ctx = req.ctx;

    const isPublic = meta<boolean>(IS_PUBLIC);
    const apiKeyScope = meta<string>(API_KEY_SCOPE);
    const bearer = this.bearer(req);

    if (apiKeyScope && bearer?.startsWith(API_KEY_PREFIX)) {
      await this.resolveApiKey(ctx, bearer, apiKeyScope, req);
      return true;
    }

    const token = req.cookies?.[SESSION_COOKIE] as string | undefined;
    const resolved = await this.sessions.resolve(token);
    if (resolved) {
      ctx.identity = resolved.identity;
      if (resolved.renew && token) this.sessions.setCookie(res, token);
    }
    if (isPublic) return true;
    if (!ctx.identity) throw unauthorized();

    if (UNSAFE.has(req.method)) {
      const origin = req.headers.origin;
      if (origin && !this.config.allowedOrigins.includes(origin.replace(/\/$/, ""))) {
        throw forbidden("Cross-site requests are not accepted");
      }
    }

    const platformMin = meta<"support" | "admin" | "owner">(NEEDS_PLATFORM);
    if (platformMin) {
      if (PLATFORM_RANK[ctx.identity.platformRole] < PLATFORM_RANK[platformMin]) {
        throw forbidden("Platform administration is not open to this account");
      }
      return true;
    }

    if (UNSAFE.has(req.method) && ctx.identity.platformRole === "none") {
      const settings = await this.platform.get();
      if (settings.maintenanceMode) {
        const message =
          settings.maintenanceMessage ||
          `${(await this.branding.get()).productName} is in maintenance for a few minutes — nothing can be changed until it is back.`;
        throw unavailable(message);
      }
    }

    const rawWorkspace = req.params?.workspaceId;
    const workspaceId = Array.isArray(rawWorkspace) ? rawWorkspace[0] : rawWorkspace;
    // The platform setting requireEmailVerification (default on) decides whether an unconfirmed address holds anything back.
    const mustVerify = !ctx.identity.emailVerified && (await this.platform.get()).requireEmailVerification;
    if (!workspaceId) {
      if (meta<string[]>(NEEDS_PERMISSION)) throw new ApiError(500, "server_error", "Route misconfigured");
      if (mustVerify && !meta<boolean>(ALLOW_UNVERIFIED) && UNSAFE.has(req.method)) {
        throw forbidden("Confirm your email address first — check your inbox for the link.");
      }
      return true;
    }

    if (mustVerify) throw forbidden("Confirm your email address first — check your inbox for the link.");
    if (!/^[0-9a-f-]{36}$/i.test(workspaceId)) throw notFound("That workspace");

    const membership = await this.prisma.db.membership.findUnique({
      where: { workspaceId_userId: { workspaceId, userId: ctx.identity.userId } },
      include: { workspace: true },
    });
    if (!membership) throw notFound("That workspace");
    const w = membership.workspace;
    ctx.workspace = {
      id: w.id,
      name: w.name,
      role: membership.role,
      permissions: permissionsFor(membership.role, w.rolePermissions as RolePermissionOverrides | null),
      billingAccountId: w.billingAccountId,
      status: w.status,
      timezone: w.timezone,
      currency: w.currency,
    };
    // The owner's two-factor requirement: the web app sends a member refused here to enrol.
    if (w.requireTwoFactor && !ctx.identity.twoFactor) {
      throw new ApiError(403, "two_factor_required", `${w.name} requires two-factor authentication. Turn it on in your account settings to continue.`);
    }
    if (w.status === "suspended" && !meta<boolean>(ALLOW_SUSPENDED)) {
      throw locked(`This workspace is suspended${w.suspendedReason ? `: ${w.suspendedReason}` : ""}. Contact support.`);
    }
    this.checkPermission(ctx, meta<string[]>(NEEDS_PERMISSION));
    return true;
  }

  private checkPermission(ctx: RequestContext, needed: string[] | undefined) {
    if (!needed?.length) return;
    const held = ctx.workspace?.permissions ?? [];
    if (!needed.some((p) => held.includes(p))) {
      throw forbidden(`Your role (${ctx.workspace?.role}) cannot do that`);
    }
  }

  private bearer(req: Req): string | null {
    const header = req.headers.authorization;
    if (!header?.toLowerCase().startsWith("bearer ")) return null;
    return header.slice(7).trim() || null;
  }

  private async resolveApiKey(ctx: RequestContext, token: string, scope: string, req: Req) {
    // Unscoped by necessity: the key is what tells us the workspace.
    const key = await this.prisma.unscoped.apiKey.findUnique({
      where: { keyHash: hashToken(token) },
      include: { workspace: true },
    });
    if (!key || key.revokedAt || (key.expiresAt && key.expiresAt.getTime() <= Date.now())) {
      throw unauthorized("That API key is not valid");
    }
    if (!key.scopes.includes(scope)) throw forbidden(`This API key lacks the "${scope}" scope`);
    const w = key.workspace;
    if (w.status === "suspended") throw locked("This workspace is suspended");
    // The effective plan, so a lapsed trial falls back exactly as it does everywhere else (docs/BILLING.md).
    await this.entitlements.assertFeature(w.billingAccountId, "apiAccess");
    const rawParam = req.params?.workspaceId;
    const workspaceParam = Array.isArray(rawParam) ? rawParam[0] : rawParam;
    if (workspaceParam && workspaceParam !== w.id) throw notFound("That workspace");
    ctx.apiKey = { id: key.id, workspaceId: w.id, scopes: key.scopes, name: key.name };
    ctx.workspace = {
      id: w.id,
      name: w.name,
      role: "api",
      permissions: [...new Set(key.scopes.flatMap((s) => SCOPE_PERMISSIONS[s] ?? []))],
      billingAccountId: w.billingAccountId,
      status: w.status,
      timezone: w.timezone,
      currency: w.currency,
    };
    if (!key.lastUsedAt || Date.now() - key.lastUsedAt.getTime() > 60_000) {
      await this.prisma.db.apiKey.update({ where: { id: key.id }, data: { lastUsedAt: new Date() } }).catch(() => undefined);
    }
  }
}

export { API_KEY_PREFIX, SCOPE_PERMISSIONS };
