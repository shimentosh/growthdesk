import { Injectable } from "@nestjs/common";
import { INTEGRATION_APP_INFO, MAX_API_KEYS, type ApiKeyInput } from "@growthdesk/shared";
import type { z } from "zod";
import type { ApiKey } from "../generated/prisma/client.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { EntitlementsService } from "../billing/entitlements.service.js";
import { AuditService } from "../core/audit.service.js";
import { API_KEY_PREFIX } from "../common/access.guard.js";
import { hashToken, newToken } from "../common/crypto.js";
import { badRequest, conflict, notFound } from "../common/errors.js";
import { actorId, ws, type RequestContext } from "../common/context.js";

type ApiKeyInputT = z.infer<typeof ApiKeyInput>;

/** Characters of the key kept in clear ("gd_" + 8), so a person can tell keys apart. */
const SHOWN_PREFIX = API_KEY_PREFIX.length + 8;

export type ApiKeyStatus = "active" | "expired" | "revoked";

function statusOf(k: ApiKey, now = Date.now()): ApiKeyStatus {
  if (k.revokedAt) return "revoked";
  if (k.expiresAt && k.expiresAt.getTime() <= now) return "expired";
  return "active";
}

function keyDto(k: ApiKey, createdBy: { id: string; name: string } | null) {
  return {
    id: k.id,
    name: k.name,
    prefix: k.prefix,
    scopes: k.scopes,
    app: k.app || null,
    status: statusOf(k),
    createdBy,
    lastUsedAt: k.lastUsedAt,
    expiresAt: k.expiresAt,
    revokedAt: k.revokedAt,
    createdAt: k.createdAt,
  };
}

/*
 * Workspace API keys. A key is `gd_` + 32 random bytes (base64url). Only its
 * SHA-256 digest (`hashToken`, the same digest AccessGuard looks keys up by)
 * and the first characters are stored, so the full key is shown once, on
 * creation, and can never be read back — a lost key is revoked and replaced.
 * Revoking keeps the row, so the list and the audit trail still name it.
 */
@Injectable()
export class ApiKeysService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService,
  ) {}

  /** Who created each key, by id → name (members may have left; the name stays readable while the user exists). */
  private async creators(rows: ApiKey[]) {
    const ids = [...new Set(rows.map((r) => r.createdById).filter((v): v is string => Boolean(v)))];
    if (!ids.length) return new Map<string, { id: string; name: string }>();
    const users = await this.prisma.db.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
    return new Map(users.map((u) => [u.id, u]));
  }

  async list(ctx: RequestContext) {
    const rows = await this.prisma.db.apiKey.findMany({ where: { workspaceId: ws(ctx).id }, orderBy: { createdAt: "desc" } });
    const people = await this.creators(rows);
    const order: Record<ApiKeyStatus, number> = { active: 0, expired: 1, revoked: 2 };
    return rows
      .map((r) => keyDto(r, r.createdById ? (people.get(r.createdById) ?? null) : null))
      .sort((a, b) => order[a.status] - order[b.status]);
  }

  async create(ctx: RequestContext, input: ApiKeyInputT) {
    const w = ws(ctx);
    await this.entitlements.assertFeature(w.billingAccountId, "apiAccess");
    if (input.expiresAt && input.expiresAt.getTime() <= Date.now()) {
      throw badRequest("The expiry date must be in the future", { expiresAt: "Must be in the future" });
    }
    const now = new Date();
    const active = await this.prisma.db.apiKey.count({
      where: { workspaceId: w.id, revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
    });
    if (active >= MAX_API_KEYS) throw conflict(`A workspace can have up to ${MAX_API_KEYS} active API keys. Revoke one you no longer use.`);

    const secret = `${API_KEY_PREFIX}${newToken(32)}`;
    const row = await this.prisma.db.apiKey.create({
      data: {
        workspaceId: w.id,
        name: input.name,
        prefix: secret.slice(0, SHOWN_PREFIX),
        keyHash: hashToken(secret),
        // An app's key holds that app's scopes, whatever the request asked for.
        scopes: input.app ? [...INTEGRATION_APP_INFO[input.app].scopes] : [...new Set(input.scopes)],
        app: input.app ?? "",
        createdById: actorId(ctx),
        expiresAt: input.expiresAt ?? null,
      },
    });
    await this.audit.record(ctx, {
      action: "api_key.created",
      targetType: "api_key",
      targetId: row.id,
      metadata: { name: row.name, prefix: row.prefix, scopes: row.scopes, app: row.app || null, expiresAt: row.expiresAt },
    });
    const creator = ctx.identity ? { id: ctx.identity.userId, name: ctx.identity.name } : null;
    // The only time the key is readable.
    return { ...keyDto(row, creator), secret };
  }

  /** Revoking is immediate: the next request with the key is refused. Revoking twice is harmless. */
  async revoke(ctx: RequestContext, id: string) {
    const w = ws(ctx);
    const existing = await this.prisma.db.apiKey.findFirst({ where: { id, workspaceId: w.id } });
    if (!existing) throw notFound("That API key");
    if (existing.revokedAt) return { revoked: true };
    await this.prisma.db.apiKey.updateMany({ where: { id, workspaceId: w.id, revokedAt: null }, data: { revokedAt: new Date() } });
    await this.audit.record(ctx, {
      action: "api_key.revoked",
      targetType: "api_key",
      targetId: existing.id,
      metadata: { name: existing.name, prefix: existing.prefix },
    });
    return { revoked: true };
  }
}
