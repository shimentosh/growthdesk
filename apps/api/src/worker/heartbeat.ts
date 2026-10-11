import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from "@nestjs/common";
import { writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { APP_CONFIG, type AppConfig } from "../config/config.js";
import { SharedRedis } from "../queues/redis.js";

/*
 * Worker liveness (docs/GAP_PLAN.md 6.1). Every running worker writes a beat
 * every HEARTBEAT_EVERY_MS:
 *   - into a Redis sorted set (member = host:pid, score = time), which the
 *     API's /health reports as `worker` and /health/worker turns into a 503
 *     for uptime monitors;
 *   - into HEARTBEAT_FILE, which the worker container's healthcheck reads
 *     (docker-compose.prod.yml). The file is written only after Redis took
 *     the beat, so a worker cut off from Redis turns unhealthy too.
 * A worker counts as alive while its last beat is younger than HEARTBEAT_STALE_MS.
 */

export const HEARTBEAT_EVERY_MS = 30_000;
export const HEARTBEAT_STALE_MS = 90_000;
export const HEARTBEAT_SET = "worker-heartbeats";
export const HEARTBEAT_FILE = path.join(tmpdir(), "growthdesk-worker-heartbeat");

export type WorkerLiveness = { alive: boolean; workers: number; lastBeatAt: string | null };

/** Reads the live workers from the heartbeat set. */
export async function readWorkerLiveness(redis: SharedRedis, now = Date.now()): Promise<WorkerLiveness> {
  const rows = await redis.client.zrangebyscore(redis.key(HEARTBEAT_SET), now - HEARTBEAT_STALE_MS, "+inf", "WITHSCORES");
  const scores = rows.filter((_, i) => i % 2 === 1).map(Number);
  const last = scores.length ? Math.max(...scores) : null;
  return { alive: scores.length > 0, workers: scores.length, lastBeatAt: last ? new Date(last).toISOString() : null };
}

@Injectable()
export class WorkerHeartbeat implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger("heartbeat");
  private readonly id = `${hostname()}:${process.pid}`;
  private timer: NodeJS.Timeout | null = null;
  private failing = false;

  constructor(
    private readonly redis: SharedRedis,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onApplicationBootstrap() {
    if (!this.config.RUN_WORKERS) return;
    void this.beat();
    this.timer = setInterval(() => void this.beat(), HEARTBEAT_EVERY_MS);
    this.timer.unref();
  }

  async beat(now = Date.now()): Promise<boolean> {
    const key = this.redis.key(HEARTBEAT_SET);
    try {
      await this.redis.client
        .multi()
        .zadd(key, now, this.id)
        // Workers that stopped without saying goodbye (killed, crashed) age out.
        .zremrangebyscore(key, "-inf", now - 10 * HEARTBEAT_STALE_MS)
        .pexpire(key, 10 * HEARTBEAT_STALE_MS)
        .exec();
      await writeFile(HEARTBEAT_FILE, new Date(now).toISOString());
      if (this.failing) this.log.log("heartbeat recovered");
      this.failing = false;
      return true;
    } catch (e) {
      if (!this.failing) this.log.error(`heartbeat failed: ${e instanceof Error ? e.message : String(e)}`);
      this.failing = true;
      return false;
    }
  }

  async onModuleDestroy() {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
    // A clean stop leaves the set at once instead of looking alive for another 90 s.
    await this.redis.client.zrem(this.redis.key(HEARTBEAT_SET), this.id).catch(() => undefined);
  }
}
