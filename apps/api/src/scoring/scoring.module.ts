import { Module } from "@nestjs/common";
import { ScoringController } from "./scoring.controller.js";
import { ScoringService } from "./scoring.service.js";

/**
 * Lead scoring: rules, and contacts' scores kept up to date as events
 * arrive. CRM (activity), notifications, queues and Redis are global. The
 * worker-side processor and schedules are in scoring.processors.ts.
 */
@Module({
  imports: [],
  controllers: [ScoringController],
  providers: [ScoringService],
  exports: [ScoringService],
})
export class ScoringModule {}
