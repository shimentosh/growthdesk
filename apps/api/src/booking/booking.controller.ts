import { Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query as Q, Req as R, Res } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import type { Response } from "express";
import { z } from "zod";
import { BookingCancelInput, BookingPageInput, BookingRescheduleInput, BookingSlotsQuery, BookInput, CalendarSettingsInput, patchOf } from "@growthdesk/shared";
import { Body, Ctx, Permission, Public, Query, Raw } from "../common/decorators.js";
import type { Req, RequestContext } from "../common/context.js";
import { BookingPagesService } from "./booking-pages.service.js";
import { BookingService } from "./booking.service.js";
import { CalendarService } from "./calendar.service.js";

/**
 * The signed-in person's own calendar connections (Settings → Calendar).
 * No permission beyond membership: each person manages only their own.
 */
@ApiTags("calendar")
@Controller("workspaces/:workspaceId/calendar")
export class CalendarController {
  constructor(private readonly calendar: CalendarService) {}

  @Get("connections")
  mine(@Ctx() ctx: RequestContext) {
    return this.calendar.mine(ctx);
  }

  /** ?return=meetings brings the browser back to the Meetings page instead of Settings → Calendar. */
  @Get("oauth/:provider/start")
  start(@Ctx() ctx: RequestContext, @Param("provider") provider: string, @Q("return") returnTo?: string) {
    return this.calendar.start(ctx, provider, returnTo);
  }

  @Get("connections/:id/calendars")
  calendars(@Ctx() ctx: RequestContext, @Param("id") id: string) {
    return this.calendar.calendars(ctx, id);
  }

  @Put("connections/:id")
  update(@Ctx() ctx: RequestContext, @Param("id") id: string, @Body(CalendarSettingsInput) body: z.infer<typeof CalendarSettingsInput>) {
    return this.calendar.update(ctx, id, body);
  }

  @Delete("connections/:id")
  async disconnect(@Ctx() ctx: RequestContext, @Param("id") id: string) {
    await this.calendar.disconnect(ctx, id);
    return { deleted: true };
  }
}

const CallbackQuery = z.object({
  code: z.string().max(4096).optional(),
  state: z.string().max(4096).optional(),
  error: z.string().max(500).optional(),
  error_description: z.string().max(2000).optional(),
});

/**
 * Where Google / Microsoft send the browser back to:
 * `${PUBLIC_APP_URL}/api/calendar/oauth/<provider>/callback` — the redirect
 * URI a platform admin must add to the installation's OAuth apps. Public
 * because it is reached by a redirect; the signed state plus the browser's
 * own session decide who and which workspace.
 */
@ApiTags("calendar")
@Public()
@Raw()
@Controller("calendar/oauth")
export class CalendarOAuthCallbackController {
  constructor(private readonly calendar: CalendarService) {}

  @Get(":provider/callback")
  async callback(@Ctx() ctx: RequestContext, @Param("provider") provider: string, @Query(CallbackQuery) query: z.infer<typeof CallbackQuery>, @Res() res: Response) {
    const next = await this.calendar.callback(provider, query, ctx);
    res.setHeader("cache-control", "no-store");
    res.redirect(302, next);
  }
}

/** Booking pages (Meetings → Booking pages). */
@ApiTags("booking")
@Controller("workspaces/:workspaceId/booking-pages")
export class BookingPagesController {
  constructor(private readonly pages: BookingPagesService) {}

  @Permission("booking.manage")
  @Get()
  list(@Ctx() ctx: RequestContext) {
    return this.pages.list(ctx);
  }

  @Permission("booking.manage")
  @Post()
  create(@Ctx() ctx: RequestContext, @Body(BookingPageInput) body: z.infer<typeof BookingPageInput>) {
    return this.pages.create(ctx, body);
  }

  @Permission("booking.manage")
  @Get(":id")
  get(@Ctx() ctx: RequestContext, @Param("id") id: string) {
    return this.pages.get(ctx, id);
  }

  @Permission("booking.manage")
  @Patch(":id")
  update(@Ctx() ctx: RequestContext, @Param("id") id: string, @Body(patchOf(BookingPageInput)) body: Partial<z.infer<typeof BookingPageInput>>) {
    return this.pages.update(ctx, id, body);
  }

  @Permission("booking.manage")
  @Delete(":id")
  async remove(@Ctx() ctx: RequestContext, @Param("id") id: string) {
    await this.pages.remove(ctx, id);
    return { deleted: true };
  }
}

/**
 * Per visitor IP. Reading is a calendar month at a time; booking and changes are a handful per person.
 * BOOKING_RATE_LIMIT (writes per minute, default 10; reads get six times as many) is read per request.
 */
const writesPerMinute = () => Number(process.env.BOOKING_RATE_LIMIT ?? 10);
const READ_LIMIT = { default: { limit: () => writesPerMinute() * 6, ttl: 60_000 } };
const WRITE_LIMIT = { default: { limit: writesPerMinute, ttl: 60_000 } };

/*
 * The public booking page's API, reached as ${PUBLIC_APP_URL}/api/public/booking/... :
 *
 *   GET  /public/booking/:slug                     the page (title, duration, questions, zone)
 *   GET  /public/booking/:slug/slots?from&to&timezone   free start times, grouped by the visitor's days
 *   POST /public/booking/:slug/book                book one
 *   GET  /public/booking/manage/:token             the attendee's booking (private link from the confirmation)
 *   POST /public/booking/manage/:token/cancel
 *   POST /public/booking/manage/:token/reschedule
 *   GET  /public/booking/manage/:token/ics         the "Add to calendar" file
 *
 * No session: the slug, or the unguessable manage token, is the key. Rate
 * limited per IP; every lookup checks the page is active and its workspace
 * is not suspended.
 */
@ApiTags("booking")
@Public()
@Controller("public/booking")
export class BookingPublicController {
  constructor(private readonly booking: BookingService) {}

  @Throttle(READ_LIMIT)
  @Get("manage/:token")
  manage(@Param("token") token: string) {
    return this.booking.manage(token);
  }

  @Throttle(WRITE_LIMIT)
  @HttpCode(200)
  @Post("manage/:token/cancel")
  cancel(@Param("token") token: string, @Body(BookingCancelInput) body: z.infer<typeof BookingCancelInput>) {
    return this.booking.cancel(token, body.reason);
  }

  @Throttle(WRITE_LIMIT)
  @HttpCode(200)
  @Post("manage/:token/reschedule")
  reschedule(@Param("token") token: string, @Body(BookingRescheduleInput) body: z.infer<typeof BookingRescheduleInput>) {
    return this.booking.reschedule(token, body.start);
  }

  @Throttle(READ_LIMIT)
  @Raw()
  @Get("manage/:token/ics")
  async ics(@Param("token") token: string, @Res() res: Response) {
    const body = await this.booking.ics(token);
    res
      .status(200)
      .set({ "content-type": "text/calendar; charset=utf-8", "content-disposition": 'attachment; filename="meeting.ics"', "cache-control": "no-store", "x-robots-tag": "noindex" })
      .send(body);
  }

  @Throttle(READ_LIMIT)
  @Get(":slug")
  page(@Param("slug") slug: string) {
    return this.booking.page(slug);
  }

  @Throttle(READ_LIMIT)
  @Get(":slug/slots")
  slots(@Param("slug") slug: string, @Query(BookingSlotsQuery) q: z.infer<typeof BookingSlotsQuery>) {
    return this.booking.slots(slug, q);
  }

  @Throttle(WRITE_LIMIT)
  @Post(":slug/book")
  book(@Param("slug") slug: string, @R() req: Req, @Body(BookInput) body: z.infer<typeof BookInput>) {
    return this.booking.book(slug, body, { ip: req.ctx.ip, userAgent: req.ctx.userAgent });
  }
}
