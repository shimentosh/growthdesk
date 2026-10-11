import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service.js";
import { NotificationsService } from "../notifications/notifications.service.js";
import { hmac, open } from "../common/crypto.js";
import { postJson } from "./safe-http.js";

/** An endpoint whose deliveries have failed this many times in a row is switched off. */
export const AUTO_DISABLE_AFTER = 50;
/** Delivery attempts per event, with exponential backoff (queue job options). */
export const DELIVERY_ATTEMPTS = 8;
export const DELIVERY_BACKOFF_MS = 60_000;
const TIMEOUT_MS = 10_000;

export type AttemptResult = { ok: boolean; done: boolean; status: string; responseStatus: number | null; error: string };

/** "t=<unix>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>" — the receiver recomputes it over the raw body. */
export function signatureHeader(secret: string, body: string, unixSeconds: number): string {
  return `t=${unixSeconds},v1=${hmac(secret, `${unixSeconds}.${body}`)}`;
}

/*
 * One delivery attempt of one event to one endpoint. The WebhookDelivery row
 * (unique per endpoint and event) is the delivery's state; the BullMQ job
 * only carries "try now", and its retry count decides when an attempt is the
 * last one.
 */
@Injectable()
export class WebhookDeliveryService {
  private readonly log = new Logger("webhooks");

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  /** What the receiver gets as `data`: the event's payload, its subject, and a snapshot of the contact it concerns. */
  async eventData(workspaceId: string, event: { subjectType: string; subjectId: string; payload: unknown }) {
    const payload = { ...((event.payload && typeof event.payload === "object" ? event.payload : {}) as Record<string, unknown>) };
    // Internal bookkeeping, not part of the public contract.
    delete payload.workflowDepth;
    delete payload.workflowRunId;
    const data: Record<string, unknown> = { subject: { type: event.subjectType, id: event.subjectId }, ...payload };
    const contactId = event.subjectType === "contact" ? event.subjectId : typeof payload.contactId === "string" ? payload.contactId : null;
    if (contactId && /^[0-9a-f-]{36}$/i.test(contactId)) {
      const c = await this.prisma.db.contact.findFirst({
        where: { id: contactId, workspaceId },
        include: { company: { select: { id: true, name: true, domain: true } }, sources: { where: { externalId: { not: null } }, select: { source: true, externalId: true } } },
      });
      if (c) {
        data.contact = {
          id: c.id,
          fullName: c.fullName,
          email: c.email,
          phone: c.phone,
          jobTitle: c.jobTitle,
          status: c.status,
          qualification: c.qualification,
          company: c.company,
          externalIds: c.sources.map((s) => ({ source: s.source, externalId: s.externalId })),
          deleted: Boolean(c.deletedAt),
        };
      }
    }
    return data;
  }

  /**
   * Tries once. `final` is true on the last attempt the queue will make: a
   * failure then marks the delivery failed and counts against the endpoint.
   */
  async attempt(workspaceId: string, deliveryId: string, final: boolean): Promise<AttemptResult> {
    const delivery = await this.prisma.db.webhookDelivery.findFirst({ where: { id: deliveryId, workspaceId } });
    if (!delivery) return { ok: false, done: true, status: "missing", responseStatus: null, error: "No such delivery" };
    if (delivery.status !== "pending") return { ok: delivery.status === "succeeded", done: true, status: delivery.status, responseStatus: delivery.responseStatus, error: delivery.error };

    const endpoint = await this.prisma.db.webhookEndpoint.findFirst({ where: { id: delivery.endpointId, workspaceId } });
    const giveUp = async (error: string) => {
      await this.prisma.db.webhookDelivery.update({ where: { id: delivery.id, workspaceId }, data: { status: "failed", error } });
      return { ok: false, done: true, status: "failed", responseStatus: null, error };
    };
    if (!endpoint || endpoint.deletedAt) return giveUp("The endpoint was deleted");
    if (!endpoint.enabled) return giveUp("The endpoint is disabled");
    const secret = open(endpoint.secretSealed);
    if (!secret) return giveUp("The endpoint's signing secret could not be read; rotate the secret under Settings → Webhooks");

    let envelope: Record<string, unknown>;
    if (delivery.eventType === "ping") {
      envelope = {
        id: delivery.eventId,
        type: "ping",
        occurredAt: delivery.createdAt.toISOString(),
        workspaceId,
        data: { message: "Test delivery from Growthdesk. Verify the X-Growthdesk-Signature header with your endpoint secret.", endpointId: endpoint.id },
      };
    } else {
      const event = await this.prisma.db.domainEvent.findFirst({ where: { id: delivery.eventId, workspaceId } });
      if (!event) return giveUp("The event no longer exists");
      envelope = { id: event.id, type: event.type, occurredAt: event.occurredAt.toISOString(), workspaceId, data: await this.eventData(workspaceId, event) };
    }

    const body = JSON.stringify(envelope);
    const t = Math.floor(Date.now() / 1000);
    const result = await postJson(
      endpoint.url,
      body,
      {
        "content-type": "application/json",
        "user-agent": "Growthdesk-Webhooks/1.0",
        "x-growthdesk-event": String(envelope.type),
        "x-growthdesk-delivery": delivery.id,
        "x-growthdesk-signature": signatureHeader(secret, body, t),
      },
      TIMEOUT_MS,
    );
    const ok = result.status !== null && result.status >= 200 && result.status < 300;
    const error = ok ? "" : (result.error ?? `The endpoint answered ${result.status}${result.body ? `: ${result.body.slice(0, 300)}` : ""}`).slice(0, 1000);
    const status = ok ? "succeeded" : final ? "failed" : "pending";
    const now = new Date();
    await this.prisma.db.webhookDelivery.update({
      where: { id: delivery.id, workspaceId },
      data: { status, attempts: { increment: 1 }, responseStatus: result.status, error, deliveredAt: ok ? now : null },
    });

    const isPing = delivery.eventType === "ping";
    if (ok) {
      await this.prisma.db.webhookEndpoint.update({ where: { id: endpoint.id, workspaceId }, data: { lastDeliveryAt: now, lastError: "", ...(isPing ? {} : { failureCount: 0 }) } });
    } else if (final && !isPing) {
      // Consecutive deliveries that exhausted every retry; any success resets the count.
      const updated = await this.prisma.db.webhookEndpoint.update({
        where: { id: endpoint.id, workspaceId },
        data: { lastDeliveryAt: now, lastError: error, failureCount: { increment: 1 } },
      });
      if (updated.failureCount >= AUTO_DISABLE_AFTER && updated.enabled) {
        await this.prisma.db.webhookEndpoint.update({ where: { id: endpoint.id, workspaceId }, data: { enabled: false } });
        this.log.warn(`endpoint ${endpoint.id} disabled after ${updated.failureCount} failed deliveries`);
        await this.notifications.notifyRoles(workspaceId, ["owner", "admin"], {
          type: "webhook.disabled",
          title: "A webhook endpoint was switched off",
          body: `${endpoint.url} failed ${updated.failureCount} deliveries in a row and has been disabled. Fix the receiver, then re-enable it under Settings → Webhooks. Last error: ${error.slice(0, 300)}`,
          link: `/w/${workspaceId}/settings/webhooks`,
          email: true,
        });
      }
    } else {
      await this.prisma.db.webhookEndpoint.update({ where: { id: endpoint.id, workspaceId }, data: { lastDeliveryAt: now, lastError: error } });
    }
    return { ok, done: ok || final, status, responseStatus: result.status, error };
  }
}
