import { Inject, Injectable, Logger, Module, type OnModuleInit } from "@nestjs/common";
import { Processor, WorkerHost } from "@nestjs/bullmq";
import type { Job } from "bullmq";
import { APP_CONFIG, type AppConfig } from "../config/config.js";
import { QUEUES, Queues } from "../queues/queues.js";
import { ForecastModule } from "./forecast.module.js";
import { StaleDealsService } from "./stale-deals.service.js";

/*
 * The `sales` queue (schedules in UTC):
 *   stale-deals  hourly :35 — tells owners about deals that went stale since the last sweep, once per stale
 *                             spell, and emits `deal.stale` (StaleDealsService). Re-reads everything, so a
 *                             duplicate or late run announces nothing twice.
 */

@Processor(QUEUES.sales, { concurrency: 1 })
export class SalesProcessor extends WorkerHost {
  private readonly log = new Logger("sales-worker");

  constructor(private readonly stale: StaleDealsService) {
    super();
  }

  override async process(job: Job): Promise<unknown> {
    switch (job.name) {
      case "stale-deals":
        return { announced: await this.stale.sweep() };
      default:
        this.log.warn(`unknown sales job ${job.name}`);
        return null;
    }
  }
}

@Injectable()
export class SalesSchedules implements OnModuleInit {
  constructor(
    private readonly queues: Queues,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async onModuleInit() {
    if (!this.config.RUN_WORKERS) return;
    const opts = { attempts: 1, removeOnComplete: true, removeOnFail: 50 };
    await this.queues.queue(QUEUES.sales).upsertJobScheduler("stale-deals", { pattern: "35 * * * *", tz: "UTC" }, { name: "stale-deals", data: {}, opts });
  }
}

/** Worker side of forecast: the stale-deal sweep. */
@Module({ imports: [ForecastModule], providers: [SalesProcessor, SalesSchedules] })
export class ForecastProcessorsModule {}
