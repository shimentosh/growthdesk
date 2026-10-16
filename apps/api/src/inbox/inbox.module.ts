import { Module } from "@nestjs/common";
import { ChannelsModule } from "../channels/channels.module.js";
import { LiveChatModule } from "../livechat/livechat.module.js";
import { InboxController } from "./inbox.controller.js";
import { InboxService } from "./inbox.service.js";
import { InboxSummaryService } from "./inbox-summary.service.js";

/**
 * Unified inbox: conversations, replies, compose, notes, assignment, follow-up tasks.
 * OutboundEmailService (MessagingModule), ActivityService (CrmModule) and
 * NotificationsService are global; ChannelsModule provides CHAT_SENDER and
 * ChannelsService for WhatsApp / Telegram sends.
 */
@Module({
  imports: [ChannelsModule, LiveChatModule],
  controllers: [InboxController],
  providers: [InboxService, InboxSummaryService],
  exports: [InboxService],
})
export class InboxModule {}
