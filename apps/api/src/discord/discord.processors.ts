import { Inject, Injectable, Logger, Module, type OnModuleInit } from "@nestjs/common";
import { Processor, WorkerHost } from "@nestjs/bullmq";
import { DelayedError, type Job } from "bullmq";
import { APP_CONFIG, type AppConfig } from "../config/config.js";
import { QUEUES, Queues } from "../queues/queues.js";
import { DiscordModule } from "./discord.module.js";
import { DiscordDeliveryService } from "./discord-delivery.service.js";

/*
 * The `discord` queue:
 *   deliver {workspaceId, deliveryId}   one attempt; a retryable failure moves the same job back to
 *                                       delayed for exactly the wait (Discord's retry_after on a 429,
 *                                       else the backoff), so the row and the job never disagree.
 *   sweep                               every minute: pending deliveries whose job was lost are re-queued.
 * Low concurrency: Discord rate-limits per channel and per bot; a burst is better spread out.
 */

@Processor(QUEUES.discord, { concurrency: 4 })
export class DiscordProcessor extends WorkerHost {
  constructor(private readonly delivery: DiscordDeliveryService) {
    super();
  }

  override async process(job: Job<{ workspaceId?: string; deliveryId?: string }>, token?: string): Promise<unknown> {
    if (job.name === "sweep") return { requeued: await this.delivery.requeueStale() };
    if (job.name !== "deliver") return null;
    const { workspaceId, deliveryId } = job.data;
    if (!workspaceId || !deliveryId) return null;
    const res = await this.delivery.attempt(workspaceId, deliveryId);
    if (res.retryInMs !== null && token) {
      await job.moveToDelayed(Date.now() + res.retryInMs, token);
      throw new DelayedError();
    }
    return { status: res.status };
  }
}

@Injectable()
export class DiscordSchedules implements OnModuleInit {
  private readonly log = new Logger("discord");

  constructor(
    private readonly queues: Queues,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async onModuleInit() {
    if (!this.config.RUN_WORKERS) return;
    await this.queues.queue(QUEUES.discord).upsertJobScheduler("discord-sweep", { every: 60_000 }, { name: "sweep", data: {}, opts: { removeOnComplete: true, removeOnFail: 100 } });
    this.log.log("discord schedules registered");
  }
}

@Module({
  imports: [DiscordModule],
  providers: [DiscordProcessor, DiscordSchedules],
})
export class DiscordProcessorsModule {}
