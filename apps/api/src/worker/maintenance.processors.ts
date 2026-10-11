import { Inject, Injectable, Logger, Module, type OnModuleInit } from "@nestjs/common";
import { Processor, WorkerHost } from "@nestjs/bullmq";
import type { Job } from "bullmq";
import { APP_CONFIG, type AppConfig } from "../config/config.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { Prisma } from "../generated/prisma/client.js";
import { QUEUES, Queues } from "../queues/queues.js";
import { CrmModule } from "../crm/crm.module.js";
import { ImportsService } from "../crm/imports.service.js";
import { PipelineModule } from "../pipeline/pipeline.controller.js";
import { TasksService } from "../tasks/tasks.service.js";
import { BillingModule } from "../billing/billing.module.js";
import { BillingService } from "../billing/billing.service.js";
import { RevenueModule } from "../revenue/revenue.module.js";
import { RevenueService } from "../revenue/revenue.service.js";
import { isApiError } from "../common/errors.js";
import { isFinalAttempt, IMPORT_STALL_MS, retentionCutoffs, stalledImports } from "./maintenance-policy.js";

/*
 * The `imports` queue (owned by CRM):
 *   process {workspaceId, importId} — ImportsService.process, which saves
 *           progress every chunk, so a retry resumes from the last saved row.
 *           Queued by POST /imports and /imports/:id/retry. On the last
 *           attempt the import is marked failed (the UI offers Retry).
 *   sweep   every 5 min — re-queues pending/processing imports that have not
 *           moved for 10 minutes and have no job waiting or running (a lost
 *           job, a worker killed mid-import).
 *
 * The `maintenance` queue (platform upkeep; schedules in UTC):
 *   task-reminders    every 60 s   — due task reminders → bell + email (TasksService.sendReminders)
 *   task-overdue      every 5 min  — `task.overdue` domain events, once per task (TasksService.emitOverdue)
 *   expire-trials     hourly       — unpaid trials without a provider subscription → expired, owner emailed (docs/BILLING.md)
 *   billing-notices   hourly :10   — trial ending, grace ending and "sending paused" emails, each once (BillingService.sendNotices)
 *   billing-reconcile daily 03:30  — re-reads provider-managed subscriptions to correct missed webhooks; no-op without a configured provider
 *   revenue-snapshot  daily 00:15  — today's MRR / paying / trialing per currency (RevenueService.snapshot, an upsert);
 *                                    also queued once at start-up while no snapshot exists. History is never back-filled.
 *   cleanup           daily 03:00  — deletes rows past their usefulness (sessions, tokens, idempotency keys,
 *                                    finished webhook deliveries, read notifications…; see RETENTION)
 * Every job is safe to run twice: each re-reads state and claims work atomically.
 */

type ImportJob = { workspaceId?: string; importId?: string };

@Processor(QUEUES.imports, { concurrency: 2 })
export class ImportsProcessor extends WorkerHost {
  private readonly log = new Logger("imports-worker");

  constructor(
    private readonly prisma: PrismaService,
    private readonly imports: ImportsService,
    private readonly queues: Queues,
  ) {
    super();
  }

  override async process(job: Job<ImportJob>): Promise<unknown> {
    switch (job.name) {
      case "process": {
        const { workspaceId, importId } = job.data;
        if (!workspaceId || !importId) return null;
        try {
          await this.imports.process(workspaceId, importId);
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          if (!isFinalAttempt(job)) throw e; // BullMQ retries with backoff; progress is kept.
          this.log.error(`import ${importId} failed after ${job.attemptsMade + 1} attempt(s): ${message}`);
          await this.imports.markFailed(
            workspaceId,
            importId,
            isApiError(e) ? e.message : "The import stopped because of an unexpected error. Rows saved so far are kept.",
          );
          return { status: "failed" };
        }
        const done = await this.prisma.db.import.findFirst({ where: { id: importId, workspaceId }, select: { status: true, processedRows: true } });
        return done ?? null;
      }
      case "sweep":
        return { requeued: await this.requeueStalled() };
      default:
        this.log.warn(`unknown imports job ${job.name}`);
        return null;
    }
  }

  async requeueStalled(now = new Date()): Promise<number> {
    // Unscoped by necessity: the sweep discovers stalled imports across every workspace; each job re-scopes by workspaceId.
    const candidates = await this.prisma.unscoped.import.findMany({
      where: { status: { in: ["pending", "processing"] }, updatedAt: { lt: new Date(now.getTime() - IMPORT_STALL_MS) }, rows: { not: Prisma.DbNull } },
      select: { id: true, workspaceId: true, updatedAt: true },
      take: 100,
    });
    if (!candidates.length) return 0;
    const live = await this.queues.queue(QUEUES.imports).getJobs(["active", "waiting", "delayed", "prioritized", "waiting-children"]);
    const liveIds = new Set(live.map((j) => (j?.data as ImportJob | undefined)?.importId).filter((id): id is string => Boolean(id)));
    const stalled = stalledImports(candidates, liveIds, now);
    for (const imp of stalled) {
      this.log.warn(`import ${imp.id} has not moved since ${imp.updatedAt.toISOString()}; queueing it again`);
      await this.queues.add(QUEUES.imports, "process", { workspaceId: imp.workspaceId, importId: imp.id }, { jobId: `import-${imp.id}-resume-${now.getTime()}` });
    }
    return stalled.length;
  }
}

@Processor(QUEUES.maintenance, { concurrency: 1 })
export class MaintenanceProcessor extends WorkerHost {
  private readonly log = new Logger("maintenance");

  constructor(
    private readonly prisma: PrismaService,
    private readonly tasks: TasksService,
    private readonly billing: BillingService,
    private readonly revenue: RevenueService,
  ) {
    super();
  }

  override async process(job: Job): Promise<unknown> {
    switch (job.name) {
      case "task-reminders":
        return { reminded: await this.tasks.sendReminders() };
      case "task-overdue":
        return { emitted: await this.tasks.emitOverdue() };
      case "expire-trials":
        return { expired: await this.billing.expireTrials() };
      case "billing-reconcile":
        return this.reconcile();
      case "billing-notices":
        return { sent: await this.billing.sendNotices() };
      case "revenue-snapshot":
        return this.revenue.snapshot();
      case "cleanup":
        return this.cleanup();
      default:
        this.log.warn(`unknown maintenance job ${job.name}`);
        return null;
    }
  }

  /** Reconciliation needs a configured payment provider; without one there is nothing to read back. */
  async reconcile() {
    // Billing accounts and subscriptions are not tenant rows; the reconcile pass is platform-wide by design.
    const used = await this.prisma.db.subscription.findMany({
      where: { providerSubscriptionId: { not: null }, provider: { notIn: ["none", "manual"] }, status: { notIn: ["canceled", "expired"] } },
      distinct: ["provider"],
      select: { provider: true },
    });
    const configured = used.filter((s) => {
      try {
        return this.billing.provider(s.provider).isConfigured();
      } catch {
        return false;
      }
    });
    if (!configured.length) return { skipped: "No payment provider is configured, or no subscription is provider-managed." };
    return { reconciled: await this.billing.reconcile() };
  }

  /**
   * Deletes rows that have stopped mattering. Never customer records: data is
   * not deleted because time passed (docs/BILLING.md "Data retention").
   */
  async cleanup(now = new Date()) {
    const c = retentionCutoffs(now);
    const db = this.prisma.db;
    // Unscoped below by necessity: one retention sweep across every workspace. Each delete only matches rows past their cut-off; nothing is read back.
    const all = this.prisma.unscoped;
    const counts = {
      sessions: (await db.session.deleteMany({ where: { OR: [{ expiresAt: { lt: c.sessions } }, { revokedAt: { lt: c.sessions } }] } })).count,
      authTokens: (await db.authToken.deleteMany({ where: { expiresAt: { lt: c.authTokens } } })).count,
      signInFailures: (await db.signInFailure.deleteMany({ where: { lastAt: { lt: c.signInFailures } } })).count,
      idempotencyKeys: (await all.idempotencyKey.deleteMany({ where: { createdAt: { lt: c.idempotencyKeys } } })).count,
      webhookDeliveries: (await all.webhookDelivery.deleteMany({ where: { status: { in: ["succeeded", "failed"] }, createdAt: { lt: c.webhookDeliveries } } })).count,
      notifications: (await all.notification.deleteMany({ where: { readAt: { not: null }, createdAt: { lt: c.readNotifications } } })).count,
      aiCache: (await all.aiCache.deleteMany({ where: { expiresAt: { lt: now } } })).count,
      mailboxDailyCounts: (await all.mailboxDailyCount.deleteMany({ where: { day: { lt: c.mailboxDay } } })).count,
      emailLog: (await db.emailLog.deleteMany({ where: { createdAt: { lt: c.emailLog } } })).count,
      importRows: (
        await all.import.updateMany({
          where: { status: { in: ["completed", "failed"] }, finishedAt: { lt: c.importRows }, rows: { not: Prisma.DbNull } },
          data: { rows: Prisma.DbNull },
        })
      ).count,
    };
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    if (total) this.log.log(`cleanup: ${Object.entries(counts).filter(([, n]) => n).map(([k, n]) => `${k} ${n}`).join(", ")}`);
    return counts;
  }
}

@Injectable()
export class MaintenanceSchedules implements OnModuleInit {
  private readonly log = new Logger("maintenance");

  constructor(
    private readonly queues: Queues,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly prisma: PrismaService,
  ) {}

  async onModuleInit() {
    if (!this.config.RUN_WORKERS) return;
    const opts = { attempts: 1, removeOnComplete: true, removeOnFail: 50 };
    const imports = this.queues.queue(QUEUES.imports);
    const maintenance = this.queues.queue(QUEUES.maintenance);
    await imports.upsertJobScheduler("imports-sweep", { every: 5 * 60_000 }, { name: "sweep", data: {}, opts });
    await maintenance.upsertJobScheduler("task-reminders", { every: 60_000 }, { name: "task-reminders", data: {}, opts });
    await maintenance.upsertJobScheduler("task-overdue", { every: 5 * 60_000 }, { name: "task-overdue", data: {}, opts });
    await maintenance.upsertJobScheduler("expire-trials", { pattern: "5 * * * *", tz: "UTC" }, { name: "expire-trials", data: {}, opts });
    await maintenance.upsertJobScheduler("billing-reconcile", { pattern: "30 3 * * *", tz: "UTC" }, { name: "billing-reconcile", data: {}, opts });
    await maintenance.upsertJobScheduler("billing-notices", { pattern: "10 * * * *", tz: "UTC" }, { name: "billing-notices", data: {}, opts });
    await maintenance.upsertJobScheduler("cleanup", { pattern: "0 3 * * *", tz: "UTC" }, { name: "cleanup", data: {}, opts });
    await maintenance.upsertJobScheduler("revenue-snapshot", { pattern: "15 0 * * *", tz: "UTC" }, { name: "revenue-snapshot", data: {}, opts });
    // A fresh install starts its MRR series today instead of waiting for 00:15; earlier days stay empty.
    if ((await this.prisma.db.platformRevenueSnapshot.count()) === 0) {
      await this.queues.add(QUEUES.maintenance, "revenue-snapshot", {}, { ...opts, jobId: "revenue-snapshot-first" });
    }
    this.log.log("maintenance schedules registered");
  }
}

@Module({
  imports: [CrmModule, PipelineModule, BillingModule, RevenueModule],
  providers: [ImportsProcessor, MaintenanceProcessor, MaintenanceSchedules],
})
export class MaintenanceProcessorsModule {}
