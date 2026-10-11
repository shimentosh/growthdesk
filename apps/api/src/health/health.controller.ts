import { Controller, Get, Inject, Module } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { Redis } from "ioredis";
import { SkipThrottle } from "@nestjs/throttler";
import { Public } from "../common/decorators.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { APP_CONFIG, type AppConfig } from "../config/config.js";
import { unavailable } from "../common/errors.js";

@ApiTags("health")
@SkipThrottle()
@Controller("health")
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Liveness and readiness: the database and Redis both answer. */
  @Public()
  @Get()
  async health() {
    const checks: Record<string, boolean> = {};
    try {
      await this.prisma.db.$queryRaw`SELECT 1`;
      checks.database = true;
    } catch {
      checks.database = false;
    }
    const redis = new Redis(this.config.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1, connectTimeout: 2000 });
    try {
      await redis.connect();
      checks.redis = (await redis.ping()) === "PONG";
    } catch {
      checks.redis = false;
    } finally {
      redis.disconnect();
    }
    if (!checks.database || !checks.redis) throw unavailable(`Unhealthy: ${JSON.stringify(checks)}`);
    return { ok: true, checks };
  }
}

@Module({ controllers: [HealthController] })
export class HealthModule {}
