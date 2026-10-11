import { Module } from "@nestjs/common";
import { DiscoveryModule } from "@nestjs/core";
import { FailedJobsListener } from "./failed-jobs.js";
import { WorkerHeartbeat } from "./heartbeat.js";

/** Worker-process observability: the failed-job listener and the liveness heartbeat (docs/GAP_PLAN.md 6.1). */
@Module({
  imports: [DiscoveryModule],
  providers: [FailedJobsListener, WorkerHeartbeat],
  exports: [FailedJobsListener, WorkerHeartbeat],
})
export class WorkerOpsModule {}
