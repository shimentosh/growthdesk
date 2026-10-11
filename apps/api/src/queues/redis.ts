import { Inject, Injectable, type OnModuleDestroy } from "@nestjs/common";
import { Redis } from "ioredis";
import { APP_CONFIG, type AppConfig } from "../config/config.js";

/*
 * One plain Redis connection per process for small reads and writes outside
 * BullMQ: the /health ping and the worker heartbeat (docs/GAP_PLAN.md 6.9 —
 * /health used to open a connection per call). BullMQ, the rate limiter and
 * the throttler keep their own connections: they need blocking commands or a
 * key prefix of their own.
 *
 * Commands fail fast while Redis is unreachable (one retry, a 2 s connect
 * timeout), and callers bound their waits, so a health check answers
 * instead of hanging.
 */
@Injectable()
export class SharedRedis implements OnModuleDestroy {
  readonly client: Redis;
  /** Key namespace, the same as BullMQ's: "gd", or "gd-test" under NODE_ENV=test. */
  readonly prefix: string;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.prefix = config.NODE_ENV === "test" ? "gd-test" : "gd";
    this.client = new Redis(config.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1, connectTimeout: 2000 });
    // Connection errors surface as failed commands; don't also crash on an unhandled 'error' event.
    this.client.on("error", () => undefined);
  }

  key(name: string): string {
    return `${this.prefix}:${name}`;
  }

  async onModuleDestroy() {
    await this.client.quit().catch(() => this.client.disconnect());
  }
}
