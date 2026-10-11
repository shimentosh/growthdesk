import { Module } from "@nestjs/common";
import { RevenueController } from "./revenue.controller.js";
import { RevenueService } from "./revenue.service.js";

/** Platform revenue (MRR, movement, collected revenue, daily snapshots). The snapshot job runs on the maintenance queue. */
@Module({ controllers: [RevenueController], providers: [RevenueService], exports: [RevenueService] })
export class RevenueModule {}
