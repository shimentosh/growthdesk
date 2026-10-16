import { Module } from "@nestjs/common";
import { AiModule } from "../ai/ai.module.js";
import { CallsModule } from "../calls/calls.module.js";
import { AI_CALLER } from "./ai-caller.js";
import { AiAgentsService } from "./ai-agents.service.js";
import { AiCallsService } from "./ai-calls.service.js";
import { AiCallingController, CallAgentsController, CartesiaWebhooksController } from "./ai-calling.controller.js";

/**
 * AI calling: Cartesia voice agents (connection, agents, test calls, one-off
 * calls), their webhook, and the AiCaller (AI_CALLER) the campaign engine's
 * ai_call step uses. CallsModule provides the shared call bookkeeping
 * (outcomes, settle); AiModule the model that judges finished calls. The
 * worker-side processor is in ai-calling.processors.ts.
 */
@Module({
  imports: [CallsModule, AiModule],
  controllers: [AiCallingController, CallAgentsController, CartesiaWebhooksController],
  providers: [AiCallsService, AiAgentsService, { provide: AI_CALLER, useExisting: AiCallsService }],
  exports: [AiCallsService, AiAgentsService, AI_CALLER],
})
export class AiCallingModule {}
