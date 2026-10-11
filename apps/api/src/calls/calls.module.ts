import { Module } from "@nestjs/common";
import { ChannelsModule } from "../channels/channels.module.js";
import { CallsController, CallScriptsController, TwilioWebhooksController } from "./calls.controller.js";
import { CallsService } from "./calls.service.js";
import { TwilioCallsService } from "./twilio-calls.service.js";

/**
 * Calling: call history and manual logging, outcomes (timeline +
 * call.completed), the call queue (open call tasks), call scripts, and Twilio
 * click-to-call with its signed webhooks. The Twilio account itself is a
 * ChannelIntegration, so ChannelsService lists, verifies and disconnects it.
 */
@Module({
  imports: [ChannelsModule],
  controllers: [CallsController, CallScriptsController, TwilioWebhooksController],
  providers: [CallsService, TwilioCallsService],
  exports: [CallsService],
})
export class CallsModule {}
