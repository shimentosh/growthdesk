import { Injectable, Inject, Module, type OnModuleDestroy } from "@nestjs/common";
import { ThrottlerGuard, type ThrottlerLimitDetail, type ThrottlerStorage } from "@nestjs/throttler";
import type { ExecutionContext } from "@nestjs/common";
import { Redis } from "ioredis";
import { APP_CONFIG, type AppConfig } from "../config/config.js";
import { tooMany } from "./errors.js";
import { clientIpFrom } from "./context.js";

/*
 * Rate limits live in Redis so they hold across several API instances
 * (LinkDesk's in-memory storage would give each instance its own counters).
 * The bucket key is the trusted client address (LinkDesk's callerKey rule:
 * never one shared bucket for everyone).
 */
@Injectable()
export class RedisThrottlerStorage implements ThrottlerStorage, OnModuleDestroy {
  private readonly redis: Redis;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.redis = new Redis(config.REDIS_URL, { lazyConnect: false, maxRetriesPerRequest: 2, keyPrefix: config.NODE_ENV === "test" ? "gd-test:rl:" : "gd:rl:" });
  }

  async increment(key: string, ttl: number, limit: number, blockDuration: number, throttlerName: string) {
    const hitKey = `${throttlerName}:${key}`;
    const blockKey = `${hitKey}:blocked`;
    const blockedTtl = await this.redis.pttl(blockKey);
    if (blockedTtl > 0) {
      return { totalHits: limit + 1, timeToExpire: Math.ceil(blockedTtl / 1000), isBlocked: true, timeToBlockExpire: Math.ceil(blockedTtl / 1000) };
    }
    const [[, hits], [, pttl]] = (await this.redis.multi().incr(hitKey).pttl(hitKey).exec()) as [[null, number], [null, number]];
    if (pttl < 0) await this.redis.pexpire(hitKey, ttl);
    const timeToExpire = Math.ceil((pttl > 0 ? pttl : ttl) / 1000);
    if (hits > limit) {
      await this.redis.set(blockKey, "1", "PX", blockDuration || ttl);
      return { totalHits: hits, timeToExpire, isBlocked: true, timeToBlockExpire: Math.ceil((blockDuration || ttl) / 1000) };
    }
    return { totalHits: hits, timeToExpire, isBlocked: false, timeToBlockExpire: 0 };
  }

  async onModuleDestroy() {
    await this.redis.quit().catch(() => undefined);
  }
}

@Injectable()
export class AppThrottlerGuard extends ThrottlerGuard {
  protected override async getTracker(req: Record<string, unknown>): Promise<string> {
    const r = req as unknown as { socket?: { remoteAddress?: string }; headers: Record<string, string | string[] | undefined> };
    const fwd = r.headers["x-forwarded-for"];
    const hops = Number(process.env.TRUSTED_PROXY_HOPS ?? 1);
    const ip = clientIpFrom(r.socket?.remoteAddress, Array.isArray(fwd) ? fwd[0] : fwd, hops);
    return ip ? `ip:${ip}` : "unattributed";
  }

  protected override async throwThrottlingException(_context: ExecutionContext, detail: ThrottlerLimitDetail): Promise<void> {
    const seconds = Math.max(1, Math.ceil(detail.timeToBlockExpire));
    const wait = seconds > 90 ? `${Math.ceil(seconds / 60)} minutes` : `${seconds} seconds`;
    throw tooMany(`Too many requests — wait ${wait} and try again`);
  }
}

@Module({ providers: [RedisThrottlerStorage], exports: [RedisThrottlerStorage] })
export class ThrottleStorageModule {}
