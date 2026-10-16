import { Module } from "@nestjs/common";
import { QuotesController } from "./quotes.controller.js";
import { QuotesPublicController } from "./quotes-public.controller.js";
import { ProductsService } from "./products.service.js";
import { QuotesService } from "./quotes.service.js";
import { QuotesPublicService } from "./quotes-public.service.js";

/**
 * The product catalogue, quotes with line items, and their public view / e-signature page.
 * OutboundEmailService (MessagingModule), ActivityService (CrmModule), NotificationsService
 * and the core services (events, branding, audit) are global.
 */
@Module({
  imports: [],
  controllers: [QuotesController, QuotesPublicController],
  providers: [ProductsService, QuotesService, QuotesPublicService],
  exports: [ProductsService, QuotesService],
})
export class QuotesModule {}
