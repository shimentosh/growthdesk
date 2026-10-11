import { Inject, Injectable, Logger, Module, type OnModuleInit } from "@nestjs/common";
import { Processor, WorkerHost } from "@nestjs/bullmq";
import type { Job } from "bullmq";
import { APP_CONFIG, type AppConfig } from "../config/config.js";
import { QUEUES, Queues } from "../queues/queues.js";
import { ChannelsModule } from "./channels.module.js";
import { ChannelsService } from "./channels.service.js";

/*
 * The `chat` queue (owned by channels). Sends are synchronous (inbox) or
 * driven by the campaign engine calling ChatSender directly, so the only job
 * here is the Telegram poll for bots in polling mode (no public https URL —
 * local development). Webhook-mode bots and WhatsApp need no worker.
 */
@Processor(QUEUES.chat)
export class ChatProcessor extends WorkerHost {
  private readonly log = new Logger("chat-worker");

  constructor(private readonly channels: ChannelsService) {
    super();
  }

  async process(job: Job): Promise<unknown> {
    switch (job.name) {
      case "telegram-poll":
        return this.channels.pollTelegram();
      default:
        this.log.warn(`unknown chat job ${job.name}`);
        return null;
    }
  }
}

@Injectable()
export class ChatSchedules implements OnModuleInit {
  constructor(
    private readonly queues: Queues,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async onModuleInit() {
    if (!this.config.RUN_WORKERS) return;
    await this.queues.queue(QUEUES.chat).upsertJobScheduler(
      "telegram-poll",
      { every: 10_000 },
      { name: "telegram-poll", data: {}, opts: { attempts: 1, removeOnComplete: true, removeOnFail: 50 } },
    );
  }
}

@Module({ imports: [ChannelsModule], providers: [ChatProcessor, ChatSchedules] })
export class ChannelsProcessorsModule {}
