import { Module } from "@nestjs/common";
import { LiveChatWidgetsController, WidgetPublicController } from "./livechat.controller.js";
import { LiveChatService } from "./livechat.service.js";

/**
 * Website live chat: widget settings, the public widget API, and the agent's
 * replies (called by the inbox). ContactsService, ActivityService,
 * NotificationsService and RealtimeService are global.
 */
@Module({
  controllers: [LiveChatWidgetsController, WidgetPublicController],
  providers: [LiveChatService],
  exports: [LiveChatService],
})
export class LiveChatModule {}
