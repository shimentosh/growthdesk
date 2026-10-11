import { Controller, Get, Module } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { Public } from "../common/decorators.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { SharedRedis } from "../queues/redis.js";
import { unavailable } from "../common/errors.js";
import { readWorkerLiveness, type WorkerLiveness } from "../worker/heartbeat.js";

/*
 * Public health endpoints for the container healthcheck and uptime monitors.
 * They are rate-limited per client address (generously: monitors poll every
 * few seconds) and share one Redis connection and one recent result, so a
 * flood of calls costs at most one database and Redis round-trip per second
 * (docs/GAP_PLAN.md 6.9).
 */

const LIMIT = { default: { limit: Number(process.env.HEALTH_RATE_LIMIT ?? 120), ttl: 60_000 } };
const CACHE_MS = 1000;
const CHECK_TIMEOUT_MS = 2500;

type Report = { checks: { database: boolean; redis: boolean }; worker: WorkerLiveness | null };

const within = <T>(p: Promise<T>, ms: number): Promise<T> =>
  Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error("timed out")), ms).unref())]);

@ApiTags("health")
@Throttle(LIMIT)
@Controller("health")
export class HealthController {
  private recent: { at: number; report: Promise<Report> } | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: SharedRedis,
  ) {}

  /**
   * Liveness and readiness: the database and Redis both answer (503 otherwise).
   * `worker` reports the background workers' heartbeat but does not fail this
   * check — the API serves requests without them; monitor /health/worker for that.
   */
  @Public()
  @Get()
  async health() {
    const report = await this.report();
    if (!report.checks.database || !report.checks.redis) throw unavailable(`Unhealthy: ${JSON.stringify(report.checks)}`);
    return { ok: true, ...report };
  }

  /** 200 while at least one worker has sent a heartbeat in the last 90 seconds; 503 otherwise. */
  @Public()
  @Get("worker")
  async worker() {
    const { worker } = await this.report();
    if (!worker?.alive) throw unavailable(`No background worker has reported in${worker?.lastBeatAt ? ` since ${worker.lastBeatAt}` : ""}`);
    return worker;
  }

  private report(): Promise<Report> {
    const now = Date.now();
    if (!this.recent || now - this.recent.at > CACHE_MS) this.recent = { at: now, report: this.check() };
    return this.recent.report;
  }

  private async check(): Promise<Report> {
    const [database, redis, worker] = await Promise.all([
      within(this.prisma.db.$queryRaw`SELECT 1`, CHECK_TIMEOUT_MS).then(() => true, () => false),
      within(this.redis.client.ping(), CHECK_TIMEOUT_MS).then((r) => r === "PONG", () => false),
      within(readWorkerLiveness(this.redis), CHECK_TIMEOUT_MS).catch(() => null),
    ]);
    return { checks: { database, redis }, worker };
  }
}

@Module({ controllers: [HealthController] })
export class HealthModule {}
