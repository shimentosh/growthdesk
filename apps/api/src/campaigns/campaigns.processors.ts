import { Inject, Injectable, Logger, Module, type OnModuleInit } from "@nestjs/common";
import { OnWorkerEvent, Processor, WorkerHost } from "@nestjs/bullmq";
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
 *         A step job that exhausts its attempts is kept (removeOnFail keeps a
 *         week), logged, and counted on the enrollment (recordJobFailure).
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

  /** Every failed attempt is logged; a step job's final failure is counted on its enrollment (docs/GAP_PLAN.md §4.12). */
  @OnWorkerEvent("failed")
  async onFailed(job: Job<StepJob> | undefined, error: Error) {
    if (!job) return;
    const final = job.attemptsMade >= (job.opts.attempts ?? 1);
    this.log.error(`${job.name} ${job.id ?? ""} failed (attempt ${job.attemptsMade}${final ? ", giving up" : ""}): ${error.message}`, error.stack);
    if (!final || job.name !== "step") return;
    const { workspaceId, enrollmentId, stepRun } = job.data;
    if (!workspaceId || !enrollmentId || typeof stepRun !== "number") return;
    try {
      await this.engine.recordJobFailure(workspaceId, enrollmentId, stepRun, error.message);
    } catch (e) {
      // Not counted: free the job id so the next claim can queue the step again rather than collide with this kept job.
      this.log.error(`could not record the failure of ${job.id}: ${e instanceof Error ? e.message : String(e)}`);
      await job.remove().catch(() => undefined);
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
