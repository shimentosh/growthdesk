import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service.js";
import type { RequestContext } from "../common/context.js";
import { AuditService } from "./audit.service.js";

/** Shown on a paused endpoint, so whoever looks at the webhook list knows why. */
export const WEBHOOK_PAUSED_OWNER_LEFT = "Paused: the person who set this up no longer has access. Check the URL, then turn it back on.";

export type ReleaseReason = "member_removed" | "member_left" | "user_disabled";

/*
 * API keys and outgoing webhooks are workspace credentials, but a person made
 * each of them. When that person loses access — removed from the workspace,
 * left it, or disabled by a platform admin — their keys are revoked (a key
 * would otherwise keep full API access) and their webhooks are paused for an
 * admin to review (the URL may be a server only they control). Each change is
 * audited in the workspace it belongs to. Calling it twice is harmless.
 */
@Injectable()
export class CredentialReleaseService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** One workspace (member removed or left). */
  async releaseInWorkspace(ctx: RequestContext, workspaceId: string, userId: string, reason: ReleaseReason) {
    await this.release(ctx, [workspaceId], userId, reason);
  }

  /** Every workspace (account disabled). */
  async releaseEverywhere(ctx: RequestContext, userId: string, reason: ReleaseReason, actorType?: "platform_admin") {
    // Unscoped by necessity: finding which workspaces hold this person's credentials crosses tenants (platform admin).
    const [keys, hooks] = await Promise.all([
      this.prisma.unscoped.apiKey.findMany({ where: { createdById: userId, revokedAt: null }, select: { workspaceId: true } }),
      this.prisma.unscoped.webhookEndpoint.findMany({ where: { createdById: userId, enabled: true, deletedAt: null }, select: { workspaceId: true } }),
    ]);
    const workspaceIds = [...new Set([...keys, ...hooks].map((r) => r.workspaceId))];
    await this.release(ctx, workspaceIds, userId, reason, actorType);
  }

  private async release(ctx: RequestContext, workspaceIds: string[], userId: string, reason: ReleaseReason, actorType?: "platform_admin") {
    const db = this.prisma.db;
    for (const workspaceId of workspaceIds) {
      const now = new Date();
      const [keys, hooks] = await Promise.all([
        db.apiKey.findMany({ where: { workspaceId, createdById: userId, revokedAt: null } }),
        db.webhookEndpoint.findMany({ where: { workspaceId, createdById: userId, enabled: true, deletedAt: null } }),
      ]);
      if (!keys.length && !hooks.length) continue;
      await db.$transaction([
        db.apiKey.updateMany({ where: { workspaceId, id: { in: keys.map((k) => k.id) }, revokedAt: null }, data: { revokedAt: now } }),
        db.webhookEndpoint.updateMany({
          where: { workspaceId, id: { in: hooks.map((h) => h.id) } },
          data: { enabled: false, lastError: WEBHOOK_PAUSED_OWNER_LEFT },
        }),
      ]);
      for (const k of keys) {
        await this.audit.record(
          ctx,
          { workspaceId, action: "api_key.revoked", targetType: "api_key", targetId: k.id, metadata: { name: k.name, prefix: k.prefix, reason, creatorId: userId } },
          actorType,
        );
      }
      for (const h of hooks) {
        await this.audit.record(
          ctx,
          { workspaceId, action: "webhook.paused", targetType: "webhook_endpoint", targetId: h.id, metadata: { url: h.url, reason, creatorId: userId } },
          actorType,
        );
      }
    }
  }
}
