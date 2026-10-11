import { Inject, Injectable, Logger, Module, type OnModuleInit } from "@nestjs/common";
import { Processor, WorkerHost } from "@nestjs/bullmq";
import type { Job } from "bullmq";
import { APP_CONFIG, type AppConfig } from "../config/config.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { QUEUES, Queues } from "../queues/queues.js";
import { isApiError } from "../common/errors.js";
import { AiModule } from "./ai.module.js";
import { AiCallError } from "./ai.engine.js";
import { AiService } from "./ai.service.js";

/*
 * Worker side of the AI assistant, on the `ai` queue:
 *   classify-reply {workspaceId, messageId}  queued when an inbound reply is filed
 *                                            (mailboxes/inbound-email.service.ts,
 *                                            channels/chat-inbound.service.ts)
 *   cache-sweep                              every 6 h: deletes expired AiCache rows
 *
 * classify-reply labels the reply and stores the label on its conversation
 * (aiCategory, aiSentiment, aiSummary). It acts on nothing: opt-outs by reply
 * are decided by the inbound filer, never by a model. Transient provider
 * failures (rate limits, outages, timeouts) throw so BullMQ retries with
 * backoff; everything else (no provider, plan without AI, credits used up, a
 * refused or rejected request) is logged and finished without a label.
 */

@Processor(QUEUES.ai, { concurrency: 3 })
export class AiProcessor extends WorkerHost {
  private readonly log = new Logger("ai");

  constructor(
    private readonly ai: AiService,
    private readonly prisma: PrismaService,
  ) {
    super();
  }

  override async process(job: Job<{ workspaceId?: string; messageId?: string }>): Promise<unknown> {
    if (job.name === "classify-reply") {
      const { workspaceId, messageId } = job.data;
      if (!workspaceId || !messageId) return null;
      try {
        const out = await this.ai.classifyReply(workspaceId, messageId);
        this.log.debug(`classify ${messageId}: ${this.ai.describe(out)}`);
        return out.status === "classified" ? { category: out.classification.category, cached: out.cached } : { skipped: out.reason };
      } catch (e) {
        if (e instanceof AiCallError && e.retryable) throw e;
        if (!isApiError(e)) throw e;
        this.log.warn(`classify ${messageId} (${workspaceId}) not labelled: ${e.message}`);
        return { skipped: e.message };
      }
    }
    if (job.name === "cache-sweep") {
      // Cross-tenant by design: a scheduler discovering expired rows in every workspace.
      const res = await this.prisma.unscoped.aiCache.deleteMany({ where: { expiresAt: { lt: new Date() } } });
      return { deleted: res.count };
    }
    return null;
  }
}

@Injectable()
export class AiSchedules implements OnModuleInit {
  private readonly log = new Logger("ai");

  constructor(
    private readonly queues: Queues,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async onModuleInit() {
    if (!this.config.RUN_WORKERS) return;
    await this.queues.queue("ai").upsertJobScheduler("ai-cache-sweep", { every: 6 * 3_600_000 }, { name: "cache-sweep", data: {}, opts: { removeOnComplete: true, removeOnFail: 100 } });
    this.log.log("ai schedules registered");
  }
}

@Module({
  imports: [AiModule],
  providers: [AiProcessor, AiSchedules],
})
export class AiProcessorsModule {}
