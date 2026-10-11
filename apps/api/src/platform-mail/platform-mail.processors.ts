import { Inject, Injectable, Logger, Module, type OnModuleInit } from "@nestjs/common";
import { Processor, WorkerHost } from "@nestjs/bullmq";
import type { Job } from "bullmq";
import { APP_CONFIG, type AppConfig } from "../config/config.js";
import { QUEUES, Queues } from "../queues/queues.js";
import { isFinalAttempt } from "../worker/maintenance-policy.js";
import { PlatformMailService, type SendJob } from "./platform-mail.service.js";

/*
 * The `platform-mail` queue (worker only):
 *   send {logId, mail}  one EmailLog row, jobId = log id. 5 attempts with
 *                       exponential backoff; PlatformMailService.runSend
 *                       re-reads the row and never sends a row twice.
 *   sweep               every 15 min — queued rows older than an hour whose
 *                       job is gone are marked failed (no silent "queued").
 */

@Processor(QUEUES.platformMail, { concurrency: 4 })
export class PlatformMailProcessor extends WorkerHost {
  private readonly log = new Logger("platform-mail-worker");

  constructor(private readonly mail: PlatformMailService) {
    super();
  }

  override async process(job: Job): Promise<unknown> {
    switch (job.name) {
      case "send": {
        const data = job.data as Partial<SendJob>;
        if (!data.logId || !data.mail) return null;
        return this.mail.runSend(data as SendJob, isFinalAttempt(job));
      }
      case "sweep":
        return { failed: await this.mail.failLostJobs() };
      default:
        this.log.warn(`unknown platform-mail job ${job.name}`);
        return null;
    }
  }
}

@Injectable()
export class PlatformMailSchedules implements OnModuleInit {
  constructor(
    private readonly queues: Queues,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async onModuleInit() {
    if (!this.config.RUN_WORKERS) return;
    await this.queues
      .queue(QUEUES.platformMail)
      .upsertJobScheduler("platform-mail-sweep", { every: 15 * 60_000 }, { name: "sweep", data: {}, opts: { attempts: 1, removeOnComplete: true, removeOnFail: 50 } });
  }
}

@Module({ providers: [PlatformMailProcessor, PlatformMailSchedules] })
export class PlatformMailProcessorsModule {}
