import { Inject, Injectable, Logger, Module, type OnModuleInit } from "@nestjs/common";
import { Processor, WorkerHost } from "@nestjs/bullmq";
import type { Job } from "bullmq";
import { APP_CONFIG, type AppConfig } from "../config/config.js";
import { QUEUES, Queues } from "../queues/queues.js";
import { isFinalAttempt } from "../worker/maintenance-policy.js";
import { PlatformGrowthModule } from "./platform-growth.module.js";
import { BroadcastRunner } from "./broadcast-runner.service.js";
import { DripRunner } from "./drip-runner.service.js";

/*
 * The `platform-marketing` queue (worker only):
 *   broadcast.start {broadcastId}           scheduled → sending, snapshot, queue batches
 *   broadcast.batch {broadcastId, batchNo}  ≤100 recipients through one Resend batch call
 *   broadcast.sweep                         every minute — due starts, lost batches, finishing
 *   drip.sweep                              every 10 minutes — enroll, then send due steps
 * Every job is safe to repeat (broadcast-runner.service.ts, drip-runner.service.ts).
 */

@Processor(QUEUES.platformMarketing, { concurrency: 2 })
export class PlatformMarketingProcessor extends WorkerHost {
  private readonly log = new Logger("platform-marketing-worker");

  constructor(
    private readonly broadcasts: BroadcastRunner,
    private readonly drips: DripRunner,
  ) {
    super();
  }

  override async process(job: Job): Promise<unknown> {
    const data = (job.data ?? {}) as { broadcastId?: string; batchNo?: number };
    switch (job.name) {
      case "broadcast.start":
        return data.broadcastId ? this.broadcasts.start(data.broadcastId) : null;
      case "broadcast.batch":
        return data.broadcastId && typeof data.batchNo === "number" ? this.broadcasts.batch(data.broadcastId, data.batchNo, isFinalAttempt(job)) : null;
      case "broadcast.sweep":
        return this.broadcasts.sweep();
      case "drip.sweep":
        return this.drips.sweep();
      default:
        this.log.warn(`unknown platform-marketing job ${job.name}`);
        return null;
    }
  }
}

@Injectable()
export class PlatformMarketingSchedules implements OnModuleInit {
  constructor(
    private readonly queues: Queues,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async onModuleInit() {
    if (!this.config.RUN_WORKERS) return;
    const q = this.queues.queue(QUEUES.platformMarketing);
    const opts = { attempts: 1, removeOnComplete: true, removeOnFail: 50 };
    await q.upsertJobScheduler("platform-broadcast-sweep", { every: 60_000 }, { name: "broadcast.sweep", data: {}, opts });
    await q.upsertJobScheduler("platform-drip-sweep", { every: 10 * 60_000 }, { name: "drip.sweep", data: {}, opts });
  }
}

@Module({ imports: [PlatformGrowthModule], providers: [PlatformMarketingProcessor, PlatformMarketingSchedules] })
export class PlatformGrowthProcessorsModule {}
