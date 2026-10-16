import { Inject, Injectable, Logger, Module, type OnModuleInit } from "@nestjs/common";
import { Processor, WorkerHost } from "@nestjs/bullmq";
import type { Job } from "bullmq";
import { APP_CONFIG, type AppConfig } from "../config/config.js";
import { QUEUES, Queues } from "../queues/queues.js";
import { ScoringModule } from "./scoring.module.js";
import { ScoringService } from "./scoring.service.js";

/*
 * The `scoring` queue (owned by lead scoring):
 *   contact {workspaceId, contactId}   recompute one contact; debounced by its
 *                                      jobId (score-<contactId>) while it waits
 *   workspace {workspaceId, mode}      `all`: every contact (enabled, rules
 *                                      changed, "Recalculate all"); `decay`:
 *                                      those with engagement points
 *   sweep                              every minute: contacts something happened
 *                                      to since the last sweep → contact jobs
 *   nightly                            02:30 UTC: a decay job per scoring workspace
 * Every job re-reads the settings: a workspace that turned scoring off is skipped.
 */

@Processor(QUEUES.scoring, { concurrency: 5 })
export class ScoringProcessor extends WorkerHost {
  private readonly log = new Logger("scoring");

  constructor(private readonly scoring: ScoringService) {
    super();
  }

  override async process(job: Job<{ workspaceId?: string; contactId?: string; mode?: "all" | "decay" }>): Promise<unknown> {
    switch (job.name) {
      case "contact": {
        const { workspaceId, contactId } = job.data;
        if (!workspaceId || !contactId) return null;
        return this.scoring.recomputeContacts(workspaceId, [contactId]);
      }
      case "workspace": {
        const { workspaceId, mode } = job.data;
        if (!workspaceId) return null;
        return this.scoring.recomputeWorkspace(workspaceId, mode === "decay" ? "decay" : "all");
      }
      case "sweep":
        return this.scoring.sweep();
      case "nightly":
        return this.scoring.nightly();
      default:
        this.log.warn(`unknown scoring job ${job.name}`);
        return null;
    }
  }
}

@Injectable()
export class ScoringSchedules implements OnModuleInit {
  constructor(
    private readonly queues: Queues,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async onModuleInit() {
    if (!this.config.RUN_WORKERS) return;
    const q = this.queues.queue(QUEUES.scoring);
    await q.upsertJobScheduler("scoring-sweep", { every: 60_000 }, { name: "sweep", data: {}, opts: { attempts: 1, removeOnComplete: true, removeOnFail: 50 } });
    await q.upsertJobScheduler("scoring-nightly", { pattern: "30 2 * * *", tz: "UTC" }, { name: "nightly", data: {}, opts: { attempts: 2, removeOnComplete: true, removeOnFail: 50 } });
  }
}

/** Worker side of scoring: the processor and its recurring schedules. */
@Module({ imports: [ScoringModule], providers: [ScoringProcessor, ScoringSchedules] })
export class ScoringProcessorsModule {}
