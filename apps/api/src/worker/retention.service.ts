import { Inject, Injectable, Logger } from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../config/config.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { Prisma } from "../generated/prisma/client.js";
import { dataRetentionCutoffs, type DataRetentionKey, KEPT_EVENT_TYPES, NOISE_ACTIVITY_TYPES } from "./maintenance-policy.js";

/*
 * Batched deletes for the worker's housekeeping (docs/GAP_PLAN.md 6.2, 6.9).
 *
 * deleteInBatches removes at most RETENTION_BATCH_SIZE rows per statement and
 * repeats until a statement takes fewer, so a large first run (or a backlog)
 * never holds a long lock or one huge transaction. Every rule below has an
 * index behind it (migration 20261012150000_ops_retention_indexes).
 *
 * prune() is the daily `retention` job. What each rule keeps:
 *   domainEvents    undispatched events; events a waiting/pending workflow run or a
 *                   pending webhook delivery will still read; KEPT_EVENT_TYPES.
 *   messageEvents   everything younger than the cut-off (Message keeps its own
 *                   sentAt/openedAt/clickedAt/bouncedAt and counters).
 *   workflowRuns    runs that have not finished.
 *   stepExecutions  (off by default) everything except finished enrollments of
 *                   completed or canceled campaigns that ended before the cut-off.
 *   activityNoise   every timeline entry except automated NOISE_ACTIVITY_TYPES rows.
 *   aiUsage         everything younger than the cut-off.
 *   billingEvents   unprocessed or failed webhooks (an operator may need them).
 *   marketingSends  every row of a campaign still sending or finished after the
 *                   cut-off; a pruned campaign keeps its counters, but unsubscribe
 *                   links in its emails stop working (see docs/DEPLOYMENT.md).
 *
 * Raw SQL on the unscoped client: these are platform-wide sweeps that match rows
 * by age alone and never read tenant data back.
 */

/** Tables the helpers may touch; the names are interpolated, so never from input. */
type Table =
  | "Session"
  | "AuthToken"
  | "SignInFailure"
  | "IdempotencyKey"
  | "WebhookDelivery"
  | "Notification"
  | "AiCache"
  | "MailboxDailyCount"
  | "EmailLog"
  | "DomainEvent"
  | "MessageEvent"
  | "WorkflowRun"
  | "StepExecution"
  | "Activity"
  | "AiUsage"
  | "BillingEvent"
  | "MarketingSend";

/** Hard stop for one rule in one run; the next day's run carries on. */
const MAX_BATCHES = 2000;

@Injectable()
export class RetentionService {
  private readonly log = new Logger("retention");

  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Deletes rows of `table` (aliased `t` in `where`) in batches; returns how many went. */
  async deleteInBatches(table: Table, where: Prisma.Sql, batch = this.config.RETENTION_BATCH_SIZE): Promise<number> {
    const t = Prisma.raw(`"${table}"`);
    let total = 0;
    for (let i = 0; i < MAX_BATCHES; i++) {
      const n = await this.prisma.unscoped.$executeRaw`DELETE FROM ${t} WHERE "id" IN (SELECT t."id" FROM ${t} t WHERE (${where}) LIMIT ${batch})`;
      total += n;
      if (n < batch) break;
    }
    return total;
  }

  async prune(now = new Date()): Promise<Record<DataRetentionKey, number>> {
    const c = dataRetentionCutoffs(this.config, now);
    const counts: Record<DataRetentionKey, number> = {
      domainEvents: 0,
      messageEvents: 0,
      workflowRuns: 0,
      stepExecutions: 0,
      activityNoise: 0,
      aiUsage: 0,
      billingEvents: 0,
      marketingSends: 0,
    };

    if (c.domainEvents) {
      counts.domainEvents = await this.deleteInBatches(
        "DomainEvent",
        Prisma.sql`t."dispatchedAt" < ${c.domainEvents} AND t."type" NOT IN (${Prisma.join([...KEPT_EVENT_TYPES])})
          AND NOT EXISTS (SELECT 1 FROM "WorkflowRun" r WHERE r."eventId" = t."id" AND r."status" IN ('pending', 'waiting_approval', 'waiting', 'running'))
          AND NOT EXISTS (SELECT 1 FROM "WebhookDelivery" d WHERE d."eventId" = t."id" AND d."status" = 'pending')`,
      );
    }
    if (c.messageEvents) counts.messageEvents = await this.deleteInBatches("MessageEvent", Prisma.sql`t."occurredAt" < ${c.messageEvents}`);
    if (c.workflowRuns) {
      counts.workflowRuns = await this.deleteInBatches(
        "WorkflowRun",
        Prisma.sql`t."finishedAt" < ${c.workflowRuns} AND t."status" IN ('succeeded', 'failed', 'skipped', 'canceled')`,
      );
    }
    if (c.stepExecutions) {
      // Unscoped by necessity: finding ended campaigns across every workspace; each delete is limited to one campaign.
      const ended = await this.prisma.unscoped.campaign.findMany({
        where: { status: { in: ["completed", "canceled"] }, OR: [{ completedAt: { lt: c.stepExecutions } }, { canceledAt: { lt: c.stepExecutions } }] },
        select: { id: true },
      });
      for (const { id } of ended) {
        counts.stepExecutions += await this.deleteInBatches(
          "StepExecution",
          Prisma.sql`t."campaignId" = ${id}::uuid AND t."finishedAt" < ${c.stepExecutions}
            AND EXISTS (SELECT 1 FROM "Enrollment" e WHERE e."id" = t."enrollmentId" AND e."status" IN ('completed', 'stopped', 'failed'))`,
        );
      }
    }
    if (c.activityNoise) {
      counts.activityNoise = await this.deleteInBatches(
        "Activity",
        Prisma.sql`t."type" IN (${Prisma.join([...NOISE_ACTIVITY_TYPES])}) AND t."occurredAt" < ${c.activityNoise} AND t."actorId" IS NULL`,
      );
    }
    if (c.aiUsage) counts.aiUsage = await this.deleteInBatches("AiUsage", Prisma.sql`t."createdAt" < ${c.aiUsage}`);
    if (c.billingEvents) {
      counts.billingEvents = await this.deleteInBatches(
        "BillingEvent",
        Prisma.sql`t."receivedAt" < ${c.billingEvents} AND t."processedAt" IS NOT NULL AND t."error" = ''`,
      );
    }
    if (c.marketingSends) {
      // Unscoped by necessity: finding finished campaigns across every workspace; each delete is limited to one campaign.
      const finished = await this.prisma.unscoped.marketingCampaign.findMany({
        where: { status: { in: ["sent", "canceled"] }, OR: [{ completedAt: { lt: c.marketingSends } }, { canceledAt: { lt: c.marketingSends } }] },
        select: { id: true },
      });
      for (const { id } of finished) {
        counts.marketingSends += await this.deleteInBatches("MarketingSend", Prisma.sql`t."campaignId" = ${id}::uuid`);
      }
    }

    const done = Object.entries(counts).filter(([, n]) => n);
    if (done.length) this.log.log(`retention: ${done.map(([k, n]) => `${k} ${n}`).join(", ")}`, counts);
    return counts;
  }
}
