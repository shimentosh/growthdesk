import { Injectable } from "@nestjs/common";
import { randomBytes, randomUUID } from "node:crypto";
import type { z } from "zod";
import type { WebhookInput } from "@growthdesk/shared";
import type { WebhookEndpoint } from "../generated/prisma/client.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { EntitlementsService } from "../billing/entitlements.service.js";
import { AuditService } from "../core/audit.service.js";
import { seal } from "../common/crypto.js";
import { badRequest, conflict, notFound } from "../common/errors.js";
import { actorId, ws, type RequestContext } from "../common/context.js";
import { assertPublicUrl, BlockedAddressError } from "./safe-http.js";
import { WebhookDeliveryService } from "./webhook-delivery.service.js";

type WebhookInputT = z.infer<typeof WebhookInput>;

const MAX_ENDPOINTS = 20;

const newSecret = () => `whsec_${randomBytes(24).toString("base64url")}`;

function endpointDto(e: WebhookEndpoint) {
  return {
    id: e.id,
    url: e.url,
    description: e.description,
    events: e.events,
    enabled: e.enabled,
    failureCount: e.failureCount,
    lastDeliveryAt: e.lastDeliveryAt,
    lastError: e.lastError,
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
  };
}

/** Outgoing webhook endpoints. The signing secret is shown once, on creation or rotation, and sealed at rest. */
@Injectable()
export class WebhooksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService,
    private readonly delivery: WebhookDeliveryService,
  ) {}

  private async checkUrl(url: string) {
    try {
      await assertPublicUrl(url);
    } catch (e) {
      if (e instanceof BlockedAddressError) throw badRequest(e.message, { url: e.message });
      throw e;
    }
  }

  private async find(workspaceId: string, id: string) {
    const row = await this.prisma.db.webhookEndpoint.findFirst({ where: { id, workspaceId, deletedAt: null } });
    if (!row) throw notFound("That webhook endpoint");
    return row;
  }

  async list(ctx: RequestContext) {
    const rows = await this.prisma.db.webhookEndpoint.findMany({ where: { workspaceId: ws(ctx).id, deletedAt: null }, orderBy: { createdAt: "desc" } });
    return rows.map(endpointDto);
  }

  async get(ctx: RequestContext, id: string) {
    return endpointDto(await this.find(ws(ctx).id, id));
  }

  async create(ctx: RequestContext, input: WebhookInputT) {
    const w = ws(ctx);
    await this.entitlements.assertFeature(w.billingAccountId, "webhooks");
    const count = await this.prisma.db.webhookEndpoint.count({ where: { workspaceId: w.id, deletedAt: null } });
    if (count >= MAX_ENDPOINTS) throw conflict(`A workspace can have up to ${MAX_ENDPOINTS} webhook endpoints.`);
    await this.checkUrl(input.url);
    const secret = newSecret();
    const row = await this.prisma.db.webhookEndpoint.create({
      data: {
        workspaceId: w.id,
        url: input.url,
        description: input.description ?? "",
        events: [...new Set(input.events)],
        enabled: input.enabled,
        secretSealed: seal(secret),
        createdById: actorId(ctx),
      },
    });
    await this.audit.record(ctx, { action: "webhook.created", targetType: "webhook_endpoint", targetId: row.id, metadata: { url: row.url, events: row.events } });
    // The only time the secret is readable.
    return { ...endpointDto(row), secret };
  }

  async update(ctx: RequestContext, id: string, input: Partial<WebhookInputT>) {
    const w = ws(ctx);
    const existing = await this.find(w.id, id);
    if (input.enabled === true || input.url !== undefined || input.events !== undefined) await this.entitlements.assertFeature(w.billingAccountId, "webhooks");
    if (input.url !== undefined) await this.checkUrl(input.url);
    const reenabling = input.enabled === true && !existing.enabled;
    const row = await this.prisma.db.webhookEndpoint.update({
      where: { id: existing.id, workspaceId: w.id },
      data: {
        ...(input.url !== undefined ? { url: input.url } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.events !== undefined ? { events: [...new Set(input.events)] } : {}),
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
        ...(reenabling ? { failureCount: 0, lastError: "" } : {}),
        // Whoever points it somewhere new, or turns a paused endpoint back on, answers for it from now on.
        ...((input.url !== undefined || reenabling) && actorId(ctx) ? { createdById: actorId(ctx) } : {}),
      },
    });
    await this.audit.record(ctx, { action: "webhook.updated", targetType: "webhook_endpoint", targetId: row.id, metadata: { fields: Object.keys(input) } });
    return endpointDto(row);
  }

  async rotateSecret(ctx: RequestContext, id: string) {
    const w = ws(ctx);
    const existing = await this.find(w.id, id);
    const secret = newSecret();
    const row = await this.prisma.db.webhookEndpoint.update({ where: { id: existing.id, workspaceId: w.id }, data: { secretSealed: seal(secret) } });
    await this.audit.record(ctx, { action: "webhook.secret_rotated", targetType: "webhook_endpoint", targetId: row.id });
    return { ...endpointDto(row), secret };
  }

  async remove(ctx: RequestContext, id: string) {
    const w = ws(ctx);
    const existing = await this.find(w.id, id);
    await this.prisma.db.webhookEndpoint.update({ where: { id: existing.id, workspaceId: w.id }, data: { deletedAt: new Date(), enabled: false } });
    await this.prisma.db.webhookDelivery.updateMany({ where: { workspaceId: w.id, endpointId: existing.id, status: "pending" }, data: { status: "failed", error: "The endpoint was deleted" } });
    await this.audit.record(ctx, { action: "webhook.deleted", targetType: "webhook_endpoint", targetId: existing.id, metadata: { url: existing.url } });
    return { deleted: true };
  }

  /** Sends a `ping` event now, once, and reports what the endpoint answered. */
  async test(ctx: RequestContext, id: string) {
    const w = ws(ctx);
    await this.entitlements.assertFeature(w.billingAccountId, "webhooks");
    const endpoint = await this.find(w.id, id);
    if (!endpoint.enabled) throw conflict("Enable the endpoint before sending a test.");
    const row = await this.prisma.db.webhookDelivery.create({
      data: { workspaceId: w.id, endpointId: endpoint.id, eventId: randomUUID(), eventType: "ping", status: "pending" },
    });
    const result = await this.delivery.attempt(w.id, row.id, true);
    return { deliveryId: row.id, ok: result.ok, status: result.status, responseStatus: result.responseStatus, error: result.error };
  }

  async deliveries(ctx: RequestContext, id: string, page: number, pageSize: number, status?: string) {
    const w = ws(ctx);
    await this.find(w.id, id);
    const where = { workspaceId: w.id, endpointId: id, ...(status ? { status } : {}) };
    const [items, total] = await Promise.all([
      this.prisma.db.webhookDelivery.findMany({ where, orderBy: { createdAt: "desc" }, skip: (page - 1) * pageSize, take: pageSize }),
      this.prisma.db.webhookDelivery.count({ where }),
    ]);
    return {
      items: items.map((d) => ({
        id: d.id,
        eventId: d.eventId,
        eventType: d.eventType,
        status: d.status,
        attempts: d.attempts,
        responseStatus: d.responseStatus,
        error: d.error,
        deliveredAt: d.deliveredAt,
        createdAt: d.createdAt,
        updatedAt: d.updatedAt,
      })),
      total,
      page,
      pageSize,
    };
  }
}
