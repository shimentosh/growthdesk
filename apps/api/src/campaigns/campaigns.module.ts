import { Module } from "@nestjs/common";
import { ChannelsModule } from "../channels/channels.module.js";
import { TemplatesController } from "./templates.controller.js";
import { TemplatesService } from "./templates.service.js";
import { SequencesController } from "./sequences.controller.js";
import { SequencesService } from "./sequences.service.js";
import { StepRulesService } from "./step-rules.service.js";
import { EnrollmentService } from "./enrollment.service.js";
import { EngineService } from "./engine.service.js";
import { CampaignsController } from "./campaigns.controller.js";
import { CampaignsService } from "./campaigns.service.js";

/**
 * Templates, sequences, campaigns and the sequence engine. Email, CRM,
 * events, notifications, entitlements and queues come from global modules;
 * ChannelsModule provides CHAT_SENDER for WhatsApp/Telegram steps. The
 * worker-side processors are in campaigns.processors.ts.
 */
@Module({
  imports: [ChannelsModule],
  controllers: [TemplatesController, SequencesController, CampaignsController],
  providers: [TemplatesService, SequencesService, StepRulesService, EnrollmentService, EngineService, CampaignsService],
  exports: [TemplatesService, SequencesService, StepRulesService, EnrollmentService, EngineService, CampaignsService],
})
export class CampaignsModule {}
