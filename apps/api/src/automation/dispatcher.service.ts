import { Injectable, Logger } from "@nestjs/common";
import type { PlanFeatures } from "@growthdesk/shared";
import { PrismaService } from "../prisma/prisma.service.js";
import { EntitlementsService } from "../billing/entitlements.service.js";
import { EventsService } from "../core/events.service.js";
import { Queues } from "../queues/queues.js";
import { MAX_WORKFLOW_DEPTH } from "./workflow-executor.service.js";
import { DELIVERY_ATTEMPTS, DELIVERY_BACKOFF_MS } from "./webhook-delivery.service.js";
import { ROUTING_DELAY_MS, ROUTING_EVENTS } from "./lead-routing.service.js";
import { DiscordPlanner } from "../discord/discord-dispatch.js";
import { discordJobOptions } from "../discord/discord-delivery.service.js";

export const DISPATCH_BATCH = 200;

type ClaimedEvent = {
  id: string;
  workspaceId: string;
  type: string;
  subjectType: string;
  subjectId: string;
  payload: unknown;
  occurredAt: Date;
};

export type DispatchResult = {
  events: number;
  runs: { workspaceId: string; runId: string }[];
  deliveries: { workspaceId: string; deliveryId: string }[];
  /** Contacts lead routing should look at, per workspace (only workspaces that route leads). */
  routes: { workspaceId: string; contactIds: string[]; key: string }[];
  /** Conversations a reply came in on, to give to the contact's owner if nobody has them. */
  inboxRoutes: { workspaceId: string; conversationIds: string[]; key: string }[];
  /** Discord notifications planned by enabled rules (src/discord). */
  discord: { workspaceId: string; deliveryId: string }[];
};

export const deliveryJobOptions = (deliveryId: string) => ({
  jobId: `delivery-${deliveryId}`,
  attempts: DELIVERY_ATTEMPTS,
  backoff: { type: "exponential" as const, delay: DELIVERY_BACKOFF_MS },
});

/*
 * Drains the transactional outbox (DomainEvent rows with no dispatchedAt).
 *
 * Each batch runs in one transaction: the events are claimed with
 * FOR UPDATE SKIP LOCKED (so several workers can drain at once without
 * handing out the same event twice), their WorkflowRun, WebhookDelivery and
 * DiscordDelivery rows are created — unique per (workflow, event),
 * (endpoint, event) and (rule, channel, event), so a replayed event creates
 * nothing new — and only then is dispatchedAt set.
 * If the process dies anywhere inside, the transaction rolls back and the
 * events are claimed again later: nothing is lost and nothing doubles.
 *
 * Jobs are enqueued after the commit. A crash between the commit and the
 * enqueue leaves a pending run or delivery without a job; the automation
 * `resume` sweep re-queues those (Discord deliveries: the `discord` queue's own sweep).
 */
@Injectable()
export class DispatcherService {
  private readonly log = new Logger("dispatcher");

  constructor(
    private readonly prisma: PrismaService,
    private readonly entitlements: EntitlementsService,
    private readonly events: EventsService,
    private readonly queues: Queues,
  ) {}

  async dispatchBatch(limit = DISPATCH_BATCH): Promise<DispatchResult> {
    const result: DispatchResult = { events: 0, runs: [], deliveries: [], routes: [], inboxRoutes: [], discord: [] };
    const inbox = new Map<string, { conversationIds: Set<string>; key: string }>();
    const routing = new Map<string, { contactIds: Set<string>; key: string }>();
    const features = new Map<string, PlanFeatures | null>();
    const featuresFor = async (workspaceId: string, billingAccountId: string, status: string) => {
      if (!features.has(workspaceId)) {
        features.set(workspaceId, status === "suspended" ? null : (await this.entitlements.forAccount(billingAccountId)).features);
      }
      return features.get(workspaceId) ?? null;
    };

    // Unscoped by necessity: the outbox is drained across every workspace in one claim; each
    // fan-out row below is written with the event's own workspaceId.
    await this.prisma.unscoped.$transaction(
      async (tx) => {
        const rows = await tx.$queryRaw<ClaimedEvent[]>`
          SELECT id, "workspaceId", type, "subjectType", "subjectId", payload, "occurredAt"
          FROM "DomainEvent"
          WHERE "dispatchedAt" IS NULL
          ORDER BY "occurredAt" ASC, id ASC
          LIMIT ${limit}
          FOR UPDATE SKIP LOCKED`;
        result.events = rows.length;
        if (!rows.length) return;

        const workspaces = new Map(
          (await tx.workspace.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.workspaceId))] } }, select: { id: true, billingAccountId: true, status: true, settings: true } })).map((w) => [w.id, w]),
        );
        const workflowCache = new Map<string, { id: string }[]>();
        const endpointCache = new Map<string, { id: string }[]>();
        const discord = new DiscordPlanner(tx);

        for (const e of rows) {
          const w = workspaces.get(e.workspaceId);
          if (!w || w.status === "suspended") continue;
          const payload = (e.payload && typeof e.payload === "object" ? e.payload : {}) as Record<string, unknown>;
          const depth = Number(payload.workflowDepth ?? 0) || 0;
          const key = `${e.workspaceId}|${e.type}`;

          // A reply on a conversation: it goes to the contact's owner if nobody has it (every workspace).
          if (e.type === "reply.received" && e.subjectType === "conversation" && e.subjectId) {
            const r = inbox.get(e.workspaceId) ?? { conversationIds: new Set<string>(), key: e.id };
            r.conversationIds.add(e.subjectId);
            inbox.set(e.workspaceId, r);
          }
          // A new or newly listed contact in a workspace that routes leads: route it once this batch is committed.
          if (ROUTING_EVENTS.has(e.type) && e.subjectType === "contact" && e.subjectId && (w.settings as { leadRouting?: { enabled?: boolean } } | null)?.leadRouting?.enabled) {
            const r = routing.get(e.workspaceId) ?? { contactIds: new Set<string>(), key: e.id };
            r.contactIds.add(e.subjectId);
            routing.set(e.workspaceId, r);
          }

          if (!workflowCache.has(key)) {
            workflowCache.set(key, await tx.workflow.findMany({ where: { workspaceId: e.workspaceId, trigger: e.type, enabled: true, deletedAt: null }, select: { id: true } }));
          }
          const workflows = workflowCache.get(key)!;
          if (workflows.length && depth < MAX_WORKFLOW_DEPTH && (await featuresFor(w.id, w.billingAccountId, w.status))?.automation) {
            const runs = await tx.workflowRun.createManyAndReturn({
              data: workflows.map((wf) => ({ workspaceId: e.workspaceId, workflowId: wf.id, eventId: e.id, subjectType: e.subjectType, subjectId: e.subjectId, status: "pending" as const })),
              skipDuplicates: true,
              select: { id: true },
            });
            for (const r of runs) result.runs.push({ workspaceId: e.workspaceId, runId: r.id });
          } else if (workflows.length && depth >= MAX_WORKFLOW_DEPTH) {
            this.log.warn(`event ${e.id} (${e.type}) reached workflow depth ${depth}; not starting workflows (loop guard)`);
          }

          if (!endpointCache.has(key)) {
            endpointCache.set(key, await tx.webhookEndpoint.findMany({ where: { workspaceId: e.workspaceId, enabled: true, deletedAt: null, events: { has: e.type } }, select: { id: true } }));
          }
          const endpoints = endpointCache.get(key)!;
          if (endpoints.length && (await featuresFor(w.id, w.billingAccountId, w.status))?.webhooks) {
            const deliveries = await tx.webhookDelivery.createManyAndReturn({
              data: endpoints.map((ep) => ({ workspaceId: e.workspaceId, endpointId: ep.id, eventId: e.id, eventType: e.type, status: "pending" })),
              skipDuplicates: true,
              select: { id: true },
            });
            for (const d of deliveries) result.deliveries.push({ workspaceId: e.workspaceId, deliveryId: d.id });
          }

          await discord.add(e);
        }
        await discord.flush();
        result.discord = discord.deliveries;

        await tx.domainEvent.updateMany({ where: { id: { in: rows.map((r) => r.id) } }, data: { dispatchedAt: new Date() } });
        for (const [workspaceId, r] of routing) result.routes.push({ workspaceId, contactIds: [...r.contactIds], key: r.key });
        for (const [workspaceId, r] of inbox) result.inboxRoutes.push({ workspaceId, conversationIds: [...r.conversationIds], key: r.key });
      },
      { timeout: 120_000, maxWait: 10_000 },
    );

    for (const r of result.runs) {
      await this.queues.add("automation", "run", r, { jobId: `run-${r.runId}`, attempts: 1 });
    }
    for (const r of result.inboxRoutes) {
      await this.queues.add("automation", "assign-conversations", { workspaceId: r.workspaceId, conversationIds: r.conversationIds }, { jobId: `inbox-${r.key}`, attempts: 3, backoff: { type: "exponential", delay: 5_000 } });
    }
    for (const r of result.routes) {
      await this.queues.add("automation", "route", { workspaceId: r.workspaceId, contactIds: r.contactIds }, { jobId: `route-${r.key}`, delay: ROUTING_DELAY_MS, attempts: 3, backoff: { type: "exponential", delay: 5_000 } });
    }
    for (const d of result.deliveries) {
      await this.queues.add("webhooks", "deliver", d, deliveryJobOptions(d.deliveryId));
    }
    for (const d of result.discord) {
      await this.queues.add("discord", "deliver", d, discordJobOptions(d.deliveryId));
    }
    return result;
  }

  /** Drains until the outbox is empty or the batch budget is spent; then asks for another pass if more is waiting. */
  async drain(maxBatches = 20): Promise<number> {
    let total = 0;
    for (let i = 0; i < maxBatches; i++) {
      const res = await this.dispatchBatch();
      total += res.events;
      if (res.events < DISPATCH_BATCH) return total;
    }
    await this.events.kick();
    return total;
  }

  /** Pending deliveries whose job was lost (crash between commit and enqueue). The jobId makes a re-add a no-op while the job exists. */
  async requeueStaleDeliveries(now = new Date(), limit = 500) {
    // Unscoped by necessity: a sweep across workspaces; each job carries its delivery's workspaceId.
    const stale = await this.prisma.unscoped.webhookDelivery.findMany({
      where: { status: "pending", eventType: { not: "ping" }, updatedAt: { lt: new Date(now.getTime() - 3 * 60 * 60_000) } },
      select: { id: true, workspaceId: true },
      take: limit,
    });
    for (const d of stale) {
      const job = await this.queues.queue("webhooks").getJob(`delivery-${d.id}`);
      const state = job ? await job.getState() : "missing";
      if (state === "missing" || state === "unknown" || state === "completed" || state === "failed") {
        if (job) await job.remove().catch(() => undefined);
        await this.queues.add("webhooks", "deliver", { workspaceId: d.workspaceId, deliveryId: d.id }, deliveryJobOptions(d.id));
      }
    }
    return stale.length;
  }
}
