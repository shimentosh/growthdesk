import { Inject, Injectable, Logger, Module, type OnModuleInit } from "@nestjs/common";
import { Processor, WorkerHost } from "@nestjs/bullmq";
import type { Job } from "bullmq";
import { APP_CONFIG, type AppConfig } from "../config/config.js";
import { QUEUES, Queues } from "../queues/queues.js";
import { AiCallingModule } from "./ai-calling.module.js";
import { AiCallsService } from "./ai-calls.service.js";

/*
 * The `calls` queue (owned by AI calling):
 *   result {workspaceId, callId}  queued when an AI call ends (webhook or sweep):
 *                                 judges it and applies the outcome, once
 *                                 (AiCallsService.finish; processedAt makes a
 *                                 repeat a no-op). Errors throw so BullMQ retries.
 *   sweep                         every minute: fetches results Cartesia's
 *                                 webhook did not deliver, re-queues lost
 *                                 result jobs, gives up on calls that never end.
 */

@Processor(QUEUES.calls, { concurrency: 5 })
export class AiCallsProcessor extends WorkerHost {
  private readonly log = new Logger("ai-calling");

  constructor(private readonly calls: AiCallsService) {
    super();
  }

  override async process(job: Job<{ workspaceId?: string; callId?: string }>): Promise<unknown> {
    switch (job.name) {
      case "result": {
        const { workspaceId, callId } = job.data;
        if (!workspaceId || !callId) return null;
        return { applied: await this.calls.finish(workspaceId, callId) };
      }
      case "sweep":
        return this.calls.sweep();
      default:
        this.log.warn(`unknown calls job ${job.name}`);
        return null;
    }
  }
}

@Injectable()
export class AiCallsSchedules implements OnModuleInit {
  constructor(
    private readonly queues: Queues,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async onModuleInit() {
    if (!this.config.RUN_WORKERS) return;
    await this.queues.queue(QUEUES.calls).upsertJobScheduler(
      "ai-calls-sweep",
      { every: 60_000 },
      {
        name: "sweep",
        data: {},
        opts: { attempts: 1, removeOnComplete: true, removeOnFail: 50 },
      },
    );
  }
}

@Module({
  imports: [AiCallingModule],
  providers: [AiCallsProcessor, AiCallsSchedules],
})
export class AiCallingProcessorsModule {}
