import { Inject, Injectable, type OnModuleDestroy } from "@nestjs/common";
import { Redis } from "ioredis";
import { APP_CONFIG, type AppConfig } from "../config/config.js";
import { ProviderError } from "./provider.js";

/*
 * One token bucket in Redis for every process that calls Resend (API test
 * sends, every worker), because Resend's rate limit is per team, not per
 * process. Refill = the admin's `resendRateLimitPerSec`, burst = one second's
 * worth. A 429 with retry-after pauses the whole bucket (`block`), so other
 * workers stop too instead of each discovering the limit on its own.
 *
 * The decision runs as one Lua script (atomic across workers, clock = Redis
 * TIME so workers on different hosts agree). `takeToken` is the same
 * algorithm in TypeScript, unit-tested; keep the two in step.
 */

export type BucketState = { tokens: number; ts: number; blockedUntil: number };

/** Pure mirror of the Lua script: the new state, and how long to wait (0 = a token was taken). */
export function takeToken(state: BucketState | null, now: number, ratePerSec: number): { state: BucketState; waitMs: number } {
  const rate = Math.max(0.1, ratePerSec);
  const capacity = Math.max(1, rate);
  const s = state ?? { tokens: capacity, ts: now, blockedUntil: 0 };
  if (s.blockedUntil > now) return { state: s, waitMs: s.blockedUntil - now };
  const tokens = Math.min(capacity, s.tokens + (Math.max(0, now - s.ts) * rate) / 1000);
  if (tokens >= 1) return { state: { tokens: tokens - 1, ts: now, blockedUntil: s.blockedUntil }, waitMs: 0 };
  return { state: { tokens, ts: now, blockedUntil: s.blockedUntil }, waitMs: Math.ceil(((1 - tokens) * 1000) / rate) };
}

const TAKE = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local rate = math.max(0.1, tonumber(ARGV[1]))
local capacity = math.max(1, rate)
local blocked = tonumber(redis.call('HGET', KEYS[1], 'blocked') or '0')
if blocked > now then return blocked - now end
local tokens = tonumber(redis.call('HGET', KEYS[1], 'tokens') or tostring(capacity))
local ts = tonumber(redis.call('HGET', KEYS[1], 'ts') or tostring(now))
tokens = math.min(capacity, tokens + math.max(0, now - ts) * rate / 1000)
local wait = 0
if tokens >= 1 then
  tokens = tokens - 1
else
  wait = math.ceil((1 - tokens) * 1000 / rate)
end
redis.call('HSET', KEYS[1], 'tokens', tostring(tokens), 'ts', tostring(now))
redis.call('PEXPIRE', KEYS[1], 120000)
return wait
`;

const BLOCK = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local untilMs = now + tonumber(ARGV[1])
local blocked = tonumber(redis.call('HGET', KEYS[1], 'blocked') or '0')
if untilMs > blocked then redis.call('HSET', KEYS[1], 'blocked', tostring(untilMs)) end
redis.call('PEXPIRE', KEYS[1], math.max(120000, tonumber(ARGV[1]) + 60000))
return untilMs - now
`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

@Injectable()
export class PlatformMailRateLimiter implements OnModuleDestroy {
  private redis: Redis | null = null;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  private client(): Redis {
    // Lazy: the API process only connects when it actually sends (admin test sends).
    this.redis ??= new Redis(this.config.REDIS_URL, {
      lazyConnect: false,
      maxRetriesPerRequest: 2,
      keyPrefix: this.config.NODE_ENV === "test" ? "gd-test:" : "gd:",
    });
    return this.redis;
  }

  /** Waits for a token from bucket `name`; gives up (rate_limited, retryable) after `maxWaitMs`. */
  async acquire(name: string, ratePerSec: number, maxWaitMs = 60_000): Promise<void> {
    const started = Date.now();
    for (;;) {
      const wait = Number(await this.client().eval(TAKE, 1, `pm:bucket:${name}`, String(ratePerSec)));
      if (!wait || wait <= 0) return;
      if (Date.now() - started + wait > maxWaitMs) {
        throw new ProviderError("rate_limited", `Waited ${Math.round((Date.now() - started) / 1000)}s for the shared send rate limit`, 429, "local_rate_limit", wait);
      }
      await sleep(Math.min(wait, 1_000));
    }
  }

  /** Pauses bucket `name` for everyone (a 429 with retry-after). */
  async block(name: string, ms: number): Promise<void> {
    await this.client().eval(BLOCK, 1, `pm:bucket:${name}`, String(Math.max(0, Math.round(ms))));
  }

  async onModuleDestroy() {
    await this.redis?.quit().catch(() => undefined);
  }
}
