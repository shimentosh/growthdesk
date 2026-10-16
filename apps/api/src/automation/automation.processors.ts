import { Inject, Injectable, Logger, Module, type OnModuleInit } from "@nestjs/common";
import { Processor, WorkerHost } from "@nestjs/bullmq";
import type { Job } from "bullmq";
import { APP_CONFIG, type AppConfig } from "../config/config.js";
import { QUEUES, Queues } from "../queues/queues.js";
import { AutomationModule } from "./automation.module.js";
import { DispatcherService } from "./dispatcher.service.js";
import { WorkflowExecutor } from "./workflow-executor.service.js";
import { LeadRoutingService } from "./lead-routing.service.js";
import { DELIVERY_ATTEMPTS, WebhookDeliveryService } from "./webhook-delivery.service.js";

/*
 * Worker side of automation:
 *   events     dispatch (kicked by EventsService.kick, jobId "dispatch") + sweep every 5 s
 *   automation run {workspaceId, runId} + resume every 30 s (due waits, lost jobs, stale runs, stale deliveries)
 *              + route {workspaceId, contactIds}: lead routing, a few seconds after new contacts land
 *   webhooks   deliver {workspaceId, deliveryId}, 8 attempts with exponential backoff
 */

@Processor(QUEUES.events, { concurrency: 1 })
export class EventsProcessor extends WorkerHost {
  constructor(private readonly dispatcher: DispatcherService) {
    super();
  }

  override async process(job: Job): Promise<unknown> {
    if (job.name === "dispatch" || job.name === "sweep") return { dispatched: await this.dispatcher.drain() };
    return null;
  }
}

@Processor(QUEUES.automation, { concurrency: 5 })
export class AutomationProcessor extends WorkerHost {
  constructor(
    private readonly executor: WorkflowExecutor,
    private readonly dispatcher: DispatcherService,
    private readonly routing: LeadRoutingService,
  ) {
    super();
  }

  override async process(job: Job<{ workspaceId?: string; runId?: string; contactIds?: string[]; conversationIds?: string[] }>): Promise<unknown> {
    if (job.name === "assign-conversations") {
      const { workspaceId, conversationIds } = job.data;
      if (!workspaceId || !conversationIds?.length) return null;
      return this.routing.assignConversations(workspaceId, conversationIds);
    }
    if (job.name === "route") {
      const { workspaceId, contactIds } = job.data;
      if (!workspaceId || !contactIds?.length) return null;
      return this.routing.route(workspaceId, contactIds);
    }
    if (job.name === "run") {
      const { workspaceId, runId } = job.data;
      if (!workspaceId || !runId) return null;
      return { status: await this.executor.execute(workspaceId, runId) };
    }
    if (job.name === "resume") {
      const runs = await this.executor.resumeDue();
      const deliveries = await this.dispatcher.requeueStaleDeliveries();
      return { runs: runs.length, deliveries };
    }
    return null;
  }
}

@Processor(QUEUES.webhooks, { concurrency: 10 })
export class WebhooksProcessor extends WorkerHost {
  constructor(private readonly delivery: WebhookDeliveryService) {
    super();
  }

  override async process(job: Job<{ workspaceId?: string; deliveryId?: string }>): Promise<unknown> {
    if (job.name !== "deliver") return null;
    const { workspaceId, deliveryId } = job.data;
    if (!workspaceId || !deliveryId) return null;
    const final = job.attemptsMade + 1 >= (job.opts.attempts ?? DELIVERY_ATTEMPTS);
    const res = await this.delivery.attempt(workspaceId, deliveryId, final);
    // Throwing hands the retry (and its backoff) to BullMQ.
    if (!res.ok && !res.done) throw new Error(res.error || "Delivery failed");
    return { status: res.status, responseStatus: res.responseStatus };
  }
}

@Injectable()
export class AutomationSchedules implements OnModuleInit {
  private readonly log = new Logger("automation");

  constructor(
    private readonly queues: Queues,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async onModuleInit() {
    if (!this.config.RUN_WORKERS) return;
    await this.queues.queue("events").upsertJobScheduler("events-sweep", { every: 5_000 }, { name: "sweep", data: {}, opts: { removeOnComplete: true, removeOnFail: 100 } });
    await this.queues.queue("automation").upsertJobScheduler("automation-resume", { every: 30_000 }, { name: "resume", data: {}, opts: { removeOnComplete: true, removeOnFail: 100 } });
    this.log.log("automation schedules registered");
  }
}

@Module({
  imports: [AutomationModule],
  providers: [EventsProcessor, AutomationProcessor, WebhooksProcessor, AutomationSchedules],
})
export class AutomationProcessorsModule {}
