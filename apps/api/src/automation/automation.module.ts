import { Module } from "@nestjs/common";
import { AutomationController } from "./automation.controller.js";
import { WorkflowsService } from "./workflows.service.js";
import { WorkflowExecutor } from "./workflow-executor.service.js";
import { DispatcherService } from "./dispatcher.service.js";
import { WebhooksService } from "./webhooks.service.js";
import { WebhookDeliveryService } from "./webhook-delivery.service.js";

/** Event dispatcher, workflows and outgoing webhooks. The BullMQ processors that drive them are in automation.processors.ts (worker only). */
@Module({
  controllers: [AutomationController],
  providers: [WorkflowsService, WorkflowExecutor, DispatcherService, WebhooksService, WebhookDeliveryService],
  exports: [WorkflowsService, WorkflowExecutor, DispatcherService, WebhooksService, WebhookDeliveryService],
})
export class AutomationModule {}
