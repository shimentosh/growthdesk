import { Module } from "@nestjs/common";
import { DigestController } from "./digest.controller.js";
import { DIGEST_CLOCK, DigestService, type DigestClock } from "./digest.service.js";

/** The CEO's digest: what the team did, daily or weekly, by email and in the bell. The sweep lives in digest.processors.ts (worker only). */
@Module({
  controllers: [DigestController],
  providers: [DigestService, { provide: DIGEST_CLOCK, useValue: { now: () => new Date() } satisfies DigestClock }],
  exports: [DigestService, DIGEST_CLOCK],
})
export class DigestModule {}
