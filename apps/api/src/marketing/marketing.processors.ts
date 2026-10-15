import { Inject, Injectable, Logger, Module, type OnModuleInit } from "@nestjs/common";
import { OnWorkerEvent, Processor, WorkerHost } from "@nestjs/bullmq";
import type { Job } from "bullmq";
import { APP_CONFIG, type AppConfig } from "../config/config.js";
import { QUEUES, Queues } from "../queues/queues.js";
import { MarketingModule } from "./marketing.module.js";
import { MarketingSenderService } from "./sender.service.js";
import { DoubleOptInService } from "./double-opt-in.service.js";

/*
 * The `marketing` queue:
 *   tick   every 10 s — starts due campaigns, queues batches, closes finished ones.
 *   batch  {workspaceId, campaignId} — up to 50 recipients of one campaign;
 *          its job id (mk-batch-<id>) keeps one batch per campaign at a time.
 *   confirm {workspaceId, membershipId} — one double opt-in confirmation email
 *          (DoubleOptInService.send); job id mk-confirm-<id>.
 */
@Processor(QUEUES.marketing, { concurrency: 4 })
export class MarketingProcessor extends WorkerHost {
  private readonly log = new Logger("marketing-worker");

  constructor(
    private readonly sender: MarketingSenderService,
    private readonly doubleOptIn: DoubleOptInService,
  ) {
    super();
  }

  override async process(job: Job<{ workspaceId?: string; campaignId?: string; membershipId?: string }>): Promise<unknown> {
    switch (job.name) {
      case "tick":
        return this.sender.tick();
      case "batch": {
        const { workspaceId, campaignId } = job.data;
        if (!workspaceId || !campaignId) return null;
        return this.sender.batch(workspaceId, campaignId);
      }
      case "confirm": {
        const { workspaceId, membershipId } = job.data;
        if (!workspaceId || !membershipId) return null;
        return this.doubleOptIn.send(workspaceId, membershipId);
      }
      default:
        this.log.warn(`unknown marketing job ${job.name}`);
        return null;
    }
  }

  /** Failed jobs are logged, not silently dropped (docs/GAP_PLAN.md §4.12). */
  @OnWorkerEvent("failed")
  onFailed(job: Job | undefined, error: Error) {
    this.log.error(`${job?.name ?? "job"} ${job?.id ?? ""} failed: ${error.message}`, error.stack);
  }
}

@Injectable()
export class MarketingSchedules implements OnModuleInit {
  constructor(
    private readonly queues: Queues,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async onModuleInit() {
    if (!this.config.RUN_WORKERS) return;
    await this.queues.queue(QUEUES.marketing).upsertJobScheduler(
      "marketing-tick",
      { every: 10_000 },
      { name: "tick", data: {}, opts: { attempts: 1, removeOnComplete: true, removeOnFail: 50 } },
    );
  }
}

@Module({ imports: [MarketingModule], providers: [MarketingProcessor, MarketingSchedules] })
export class MarketingProcessorsModule {}
