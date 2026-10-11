import { Inject, Injectable, Logger, Module, type OnModuleInit } from "@nestjs/common";
import { Processor, WorkerHost } from "@nestjs/bullmq";
import type { Job } from "bullmq";
import { APP_CONFIG, type AppConfig } from "../config/config.js";
import { QUEUES, Queues } from "../queues/queues.js";
import { CampaignsModule } from "./campaigns.module.js";
import { EngineService } from "./engine.service.js";

/*
 * The `engine` queue (owned by campaigns):
 *   tick  every 15 s — starts due scheduled campaigns, leases due enrollments
 *         and queues a `step` job for each, closes finished campaigns and
 *         refreshes counters (EngineService.tick).
 *   step  {workspaceId, enrollmentId, stepRun} — one step for one enrollment
 *         (EngineService.runStep). A stale stepRun, a paused campaign or a
 *         finished enrollment makes it a no-op; infrastructure errors throw so
 *         BullMQ retries (the job carries attempts + backoff from enqueue()).
 */

type StepJob = { workspaceId?: string; enrollmentId?: string; stepRun?: number };

@Processor(QUEUES.engine, { concurrency: 10 })
export class EngineProcessor extends WorkerHost {
  private readonly log = new Logger("engine-worker");

  constructor(private readonly engine: EngineService) {
    super();
  }

  override async process(job: Job<StepJob>): Promise<unknown> {
    switch (job.name) {
      case "tick": {
        const r = await this.engine.tick();
        return { started: r.started, claimed: r.claimed.length, completed: r.completed, refreshed: r.refreshed };
      }
      case "step": {
        const { workspaceId, enrollmentId, stepRun } = job.data;
        if (!workspaceId || !enrollmentId || typeof stepRun !== "number") return null;
        return this.engine.runStep(workspaceId, enrollmentId, stepRun);
      }
      default:
        this.log.warn(`unknown engine job ${job.name}`);
        return null;
    }
  }
}

@Injectable()
export class EngineSchedules implements OnModuleInit {
  constructor(
    private readonly queues: Queues,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async onModuleInit() {
    if (!this.config.RUN_WORKERS) return;
    await this.queues.queue(QUEUES.engine).upsertJobScheduler(
      "engine-tick",
      { every: 15_000 },
      { name: "tick", data: {}, opts: { attempts: 1, removeOnComplete: true, removeOnFail: 50 } },
    );
  }
}

@Module({ imports: [CampaignsModule], providers: [EngineProcessor, EngineSchedules] })
export class CampaignsProcessorsModule {}
