import { Module } from "@nestjs/common";
import { CHAT_SENDER } from "./chat-sender.js";
import { ChannelsService } from "./channels.service.js";
import { ChatInboundService } from "./chat-inbound.service.js";
import { ChannelsController, ChannelWebhooksController } from "./channels.controller.js";

/**
 * WhatsApp (Meta Cloud API) and Telegram (Bot API) integrations: connect,
 * verify, disconnect, webhooks, inbound filing, and the ChatSender
 * (CHAT_SENDER) used by the campaign engine and the inbox.
 */
@Module({
  controllers: [ChannelsController, ChannelWebhooksController],
  providers: [ChannelsService, ChatInboundService, { provide: CHAT_SENDER, useExisting: ChannelsService }],
  exports: [ChannelsService, ChatInboundService, CHAT_SENDER],
})
export class ChannelsModule {}
