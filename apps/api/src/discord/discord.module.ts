import { Module } from "@nestjs/common";
import { DiscordApi } from "./discord-api.js";
import { DiscordContextService } from "./discord-context.service.js";
import { DiscordController, DiscordOAuthCallbackController } from "./discord.controller.js";
import { DiscordDeliveryService } from "./discord-delivery.service.js";
import { DiscordRoutingService } from "./discord-routing.service.js";
import { DiscordService } from "./discord.service.js";

/**
 * Discord notifications (docs/DISCORD.md): connected servers, channels and
 * destinations, routing rules and templates, deliveries. Events reach it from
 * the automation dispatcher (DiscordPlanner, discord-dispatch.ts); the worker
 * side is in discord.processors.ts.
 */
@Module({
  controllers: [DiscordController, DiscordOAuthCallbackController],
  providers: [DiscordApi, DiscordContextService, DiscordService, DiscordRoutingService, DiscordDeliveryService],
  exports: [DiscordApi, DiscordContextService, DiscordService, DiscordRoutingService, DiscordDeliveryService],
})
export class DiscordModule {}
