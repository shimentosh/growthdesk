import { Module } from "@nestjs/common";
import { CampaignsModule } from "../campaigns/campaigns.module.js";
import { AutomationController } from "./automation.controller.js";
import { WorkflowsService } from "./workflows.service.js";
import { WorkflowExecutor } from "./workflow-executor.service.js";
import { DispatcherService } from "./dispatcher.service.js";
import { WebhooksService } from "./webhooks.service.js";
import { WebhookDeliveryService } from "./webhook-delivery.service.js";
import { LeadRoutingController } from "./lead-routing.controller.js";
import { LeadRoutingService } from "./lead-routing.service.js";

/** Event dispatcher, workflows and outgoing webhooks. The BullMQ processors that drive them are in automation.processors.ts (worker only). */
@Module({
  // EnrollmentService: workflow enrollments are planned exactly like manual ones (first-step delay, daily limit, gap).
  imports: [CampaignsModule],
  controllers: [AutomationController, LeadRoutingController],
  providers: [WorkflowsService, WorkflowExecutor, DispatcherService, WebhooksService, WebhookDeliveryService, LeadRoutingService],
  exports: [WorkflowsService, WorkflowExecutor, DispatcherService, WebhooksService, WebhookDeliveryService, LeadRoutingService],
})
export class AutomationModule {}
