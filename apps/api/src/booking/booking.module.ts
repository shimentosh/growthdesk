import { Module } from "@nestjs/common";
import { BookingPagesService } from "./booking-pages.service.js";
import { BookingService } from "./booking.service.js";
import { CalendarService } from "./calendar.service.js";
import { BookingPagesController, BookingPublicController, CalendarController, CalendarOAuthCallbackController } from "./booking.controller.js";

/**
 * Calendar connections (Google, Microsoft) and public booking pages. See
 * docs/SALES.md. Contacts, consent, activity and notifications come from the
 * global CRM and notifications modules; the worker side is in
 * booking.processors.ts.
 */
@Module({
  imports: [],
  controllers: [CalendarController, CalendarOAuthCallbackController, BookingPagesController, BookingPublicController],
  providers: [CalendarService, BookingPagesService, BookingService],
  exports: [CalendarService, BookingService],
})
export class BookingModule {}
