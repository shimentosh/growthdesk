import { Module } from "@nestjs/common";
import { InboxModule } from "../inbox/inbox.module.js";
import { AiController } from "./ai.controller.js";
import { AiEngine } from "./ai.engine.js";
import { AiService } from "./ai.service.js";

/**
 * AI assistant: reply drafts, compose drafts, template/step writing, reply
 * classification and contact/deal summaries. AiEngine owns the provider call
 * (ai.provider.ts) with plan, credit, cache and usage rules; AiService builds
 * each feature's context and prompt (ai.prompts.ts). InboxModule provides the
 * conversation visibility rule; entitlements and platform settings are global.
 * The worker-side processor is in ai.processors.ts.
 */
@Module({
  imports: [InboxModule],
  controllers: [AiController],
  providers: [AiEngine, AiService],
  exports: [AiEngine, AiService],
})
export class AiModule {}
