import { Module } from "@nestjs/common";
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from "@nestjs/core";
import { ThrottlerModule } from "@nestjs/throttler";
import { ConfigModule } from "./config/config.module.js";
import { PrismaModule } from "./prisma/prisma.service.js";
import { QueuesModule } from "./queues/queues.js";
import { CoreModule } from "./core/core.module.js";
import { AccessGuard } from "./common/access.guard.js";
import { AppThrottlerGuard, RedisThrottlerStorage, ThrottleStorageModule } from "./common/throttle.js";
import { EnvelopeInterceptor } from "./common/envelope.interceptor.js";
import { ApiExceptionFilter } from "./common/exception.filter.js";
import { FEATURE_MODULES } from "./feature-modules.js";

@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    QueuesModule,
    CoreModule,
    ThrottlerModule.forRootAsync({
      imports: [ThrottleStorageModule],
      inject: [RedisThrottlerStorage],
      useFactory: (storage: RedisThrottlerStorage) => ({
        throttlers: [{ name: "default", ttl: 60_000, limit: Number(process.env.RATE_LIMIT_PER_MINUTE ?? 600) }],
        storage,
      }),
    }),
    ...FEATURE_MODULES,
  ],
  providers: [
    { provide: APP_GUARD, useClass: AppThrottlerGuard },
    { provide: APP_GUARD, useClass: AccessGuard },
    { provide: APP_INTERCEPTOR, useClass: EnvelopeInterceptor },
    { provide: APP_FILTER, useClass: ApiExceptionFilter },
  ],
})
export class AppModule {}
