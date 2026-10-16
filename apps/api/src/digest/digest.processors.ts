import { Inject, Injectable, Logger, Module, type OnModuleInit } from "@nestjs/common";
import { Processor, WorkerHost } from "@nestjs/bullmq";
import type { Job } from "bullmq";
import { APP_CONFIG, type AppConfig } from "../config/config.js";
import { QUEUES, Queues } from "../queues/queues.js";
import { DigestModule } from "./digest.module.js";
import { DigestService } from "./digest.service.js";

/*
 * The `digest` queue:
 *   sweep  every 15 min — sends each workspace's daily / weekly digest once its local
 *                         hour has come (DigestService.runDue). Each period is claimed
 *                         with a compare-and-set on settings.digest.lastSentAt before
 *                         anything is sent, so a duplicate, late or concurrent run
 *                         sends nothing twice.
 */

@Processor(QUEUES.digest, { concurrency: 1 })
export class DigestProcessor extends WorkerHost {
  private readonly log = new Logger("digest-worker");

  constructor(private readonly digest: DigestService) {
    super();
  }

  override async process(job: Job): Promise<unknown> {
    switch (job.name) {
      case "sweep":
        return this.digest.runDue();
      default:
        this.log.warn(`unknown digest job ${job.name}`);
        return null;
    }
  }
}

@Injectable()
export class DigestSchedules implements OnModuleInit {
  constructor(
    private readonly queues: Queues,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async onModuleInit() {
    if (!this.config.RUN_WORKERS) return;
    const opts = { attempts: 1, removeOnComplete: true, removeOnFail: 50 };
    await this.queues.queue(QUEUES.digest).upsertJobScheduler("digest-sweep", { every: 15 * 60_000 }, { name: "sweep", data: {}, opts });
  }
}

/** Worker side of the digest: the 15-minute sweep. */
@Module({ imports: [DigestModule], providers: [DigestProcessor, DigestSchedules] })
export class DigestProcessorsModule {}
