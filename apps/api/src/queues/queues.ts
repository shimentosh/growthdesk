import { Global, Inject, Injectable, Module, type OnModuleDestroy } from "@nestjs/common";
import { BullModule, getQueueToken } from "@nestjs/bullmq";
import type { JobsOptions, Queue } from "bullmq";
import { APP_CONFIG, type AppConfig, loadConfig } from "../config/config.js";

/*
 * Background work runs on BullMQ (Redis). The database stays the source of
 * truth: a job only says "look at this now", and every processor re-reads and
 * re-checks state before acting, so a duplicated, delayed or replayed job is
 * harmless. Recurring sweeps (registered by the worker) re-discover anything
 * a lost job would have done.
 *
 * Every job payload that touches tenant data carries `workspaceId`, and the
 * processor scopes its queries with it.
 */

export const QUEUES = {
  engine: "engine",
  mail: "mail",
  chat: "chat",
  events: "events",
  automation: "automation",
  webhooks: "webhooks",
  imports: "imports",
  ai: "ai",
  maintenance: "maintenance",
  marketing: "marketing",
  /** Platform (system) email to our own users: one job per EmailLog row. */
  platformMail: "platform-mail",
  /** Platform broadcasts and onboarding drips to our own users. */
  platformMarketing: "platform-marketing",
  /** Workspace data exports and the deleted-workspace purge (src/lifecycle). */
  lifecycle: "lifecycle",
} as const;
export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

export const ALL_QUEUES = Object.values(QUEUES) as QueueName[];

export const redisConnection = (url: string) => {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: Number(u.port || 6379),
    db: u.pathname && u.pathname !== "/" ? Number(u.pathname.slice(1)) : 0,
    ...(u.password ? { password: decodeURIComponent(u.password) } : {}),
    ...(u.username ? { username: decodeURIComponent(u.username) } : {}),
    ...(u.protocol === "rediss:" ? { tls: {} } : {}),
    maxRetriesPerRequest: null,
  };
};

const DEFAULTS: JobsOptions = {
  attempts: 5,
  backoff: { type: "exponential", delay: 15_000 },
  removeOnComplete: { age: 24 * 3600, count: 5000 },
  removeOnFail: { age: 14 * 24 * 3600 },
};

@Injectable()
export class Queues implements OnModuleDestroy {
  private readonly byName: Record<QueueName, Queue>;

  constructor(
    @Inject(getQueueToken(QUEUES.engine)) engine: Queue,
    @Inject(getQueueToken(QUEUES.mail)) mail: Queue,
    @Inject(getQueueToken(QUEUES.chat)) chat: Queue,
    @Inject(getQueueToken(QUEUES.events)) events: Queue,
    @Inject(getQueueToken(QUEUES.automation)) automation: Queue,
    @Inject(getQueueToken(QUEUES.webhooks)) webhooks: Queue,
    @Inject(getQueueToken(QUEUES.imports)) imports: Queue,
    @Inject(getQueueToken(QUEUES.ai)) ai: Queue,
    @Inject(getQueueToken(QUEUES.maintenance)) maintenance: Queue,
    @Inject(getQueueToken(QUEUES.marketing)) marketing: Queue,
    @Inject(getQueueToken(QUEUES.platformMail)) platformMail: Queue,
    @Inject(getQueueToken(QUEUES.platformMarketing)) platformMarketing: Queue,
    @Inject(getQueueToken(QUEUES.lifecycle)) lifecycle: Queue,
  ) {
    this.byName = {
      engine,
      mail,
      chat,
      events,
      automation,
      webhooks,
      imports,
      ai,
      maintenance,
      marketing,
      [QUEUES.platformMail]: platformMail,
      [QUEUES.platformMarketing]: platformMarketing,
      lifecycle,
    };
  }

  queue(name: QueueName): Queue {
    return this.byName[name];
  }

  all(): Queue[] {
    return Object.values(this.byName);
  }

  /**
   * Adds a job. A `jobId` makes the add idempotent while that job exists —
   * BullMQ ignores a second add with the same id — which is how "kick the
   * dispatcher" can be called from many places without piling up work.
   */
  async add(name: QueueName, job: string, data: Record<string, unknown>, opts: JobsOptions = {}) {
    return this.byName[name].add(job, data, { ...DEFAULTS, ...opts });
  }

  async onModuleDestroy() {
    await Promise.all(this.all().map((q) => q.close().catch(() => undefined)));
  }
}

@Global()
@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => ({
        connection: redisConnection(config.REDIS_URL),
        prefix: config.NODE_ENV === "test" ? "gd-test" : "gd",
      }),
    }),
    ...ALL_QUEUES.map((name) => BullModule.registerQueue({ name })),
  ],
  providers: [Queues],
  exports: [Queues, BullModule],
})
export class QueuesModule {}

/** Config is needed before Nest boots in a couple of places (worker bootstrap). */
export const bootConfig = () => loadConfig();
