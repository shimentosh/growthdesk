import { Inject, Injectable, Logger, Module, type OnModuleInit } from "@nestjs/common";
import { Processor, WorkerHost } from "@nestjs/bullmq";
import type { Job } from "bullmq";
import { APP_CONFIG, type AppConfig } from "../config/config.js";
import { QUEUES, Queues } from "../queues/queues.js";
import { isFinalAttempt } from "../worker/maintenance-policy.js";
import { LifecycleModule } from "./lifecycle.module.js";
import { WorkspaceExportService } from "./workspace-export.service.js";
import { WorkspaceLifecycleService } from "./workspace-lifecycle.service.js";

/*
 * The `lifecycle` queue (docs/PRIVACY_OPS.md; schedules in UTC):
 *   export {workspaceId, exportId} — builds one workspace export (POST /exports). On the last attempt the
 *                                    export is marked failed and the UI offers a new one.
 *   purge-sweep    hourly :20      — hard-deletes deleted workspaces past purgeAfter (WORKSPACE_PURGE_DAYS)
 *   export-cleanup daily 04:00     — deletes export files past their download window (DATA_EXPORT_DAYS)
 * Every job re-reads state first, so a duplicate or replayed job does nothing.
 */

type ExportJob = { workspaceId?: string; exportId?: string };

@Processor(QUEUES.lifecycle, { concurrency: 1 })
export class LifecycleProcessor extends WorkerHost {
  private readonly log = new Logger("lifecycle-worker");

  constructor(
    private readonly exports: WorkspaceExportService,
    private readonly workspaces: WorkspaceLifecycleService,
  ) {
    super();
  }

  override async process(job: Job<ExportJob>): Promise<unknown> {
    switch (job.name) {
      case "export": {
        const { workspaceId, exportId } = job.data;
        if (!workspaceId || !exportId) return null;
        try {
          return await this.exports.build(workspaceId, exportId);
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          if (!isFinalAttempt(job)) throw e;
          this.log.error(`export ${exportId} failed after ${job.attemptsMade + 1} attempt(s): ${message}`);
          await this.exports.markFailed(workspaceId, exportId, "The export stopped because of an unexpected error. Request a new one.");
          return { status: "failed" };
        }
      }
      case "purge-sweep":
        return { purged: await this.workspaces.purgeDue() };
      case "export-cleanup":
        return { expired: await this.exports.cleanupExpired() };
      default:
        this.log.warn(`unknown lifecycle job ${job.name}`);
        return null;
    }
  }
}

@Injectable()
export class LifecycleSchedules implements OnModuleInit {
  constructor(
    private readonly queues: Queues,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async onModuleInit() {
    if (!this.config.RUN_WORKERS) return;
    const opts = { attempts: 1, removeOnComplete: true, removeOnFail: 50 };
    const q = this.queues.queue(QUEUES.lifecycle);
    await q.upsertJobScheduler("purge-sweep", { pattern: "20 * * * *", tz: "UTC" }, { name: "purge-sweep", data: {}, opts });
    await q.upsertJobScheduler("export-cleanup", { pattern: "0 4 * * *", tz: "UTC" }, { name: "export-cleanup", data: {}, opts });
  }
}

@Module({
  imports: [LifecycleModule],
  providers: [LifecycleProcessor, LifecycleSchedules],
})
export class LifecycleProcessorsModule {}
