import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { randomBytes } from "node:crypto";
import type { z } from "zod";
import {
  BOOKING_LOCATION_LABELS,
  bookingWindow,
  groupSlotsByDay,
  hostSlots,
  isSlotAvailable,
  pickHost,
  readAvailability,
  readQuestions,
  type BookInputT,
  type BookingLocationType,
  type BookingSlotsQuery,
  type BusyInterval,
  type PublicBooking,
  type PublicBookingPage,
  type PublicBookingSlots,
  type SlotRules,
} from "@growthdesk/shared";
import { APP_CONFIG, type AppConfig } from "../config/config.js";
import type { BookingPage, Meeting } from "../generated/prisma/client.js";
import { PrismaService, type Tx } from "../prisma/prisma.service.js";
import { EventsService } from "../core/events.service.js";
import { layout, MailService } from "../core/mail.service.js";
import { ActivityService } from "../crm/activity.service.js";
import { ConsentService } from "../crm/consent.service.js";
import { ContactsService } from "../crm/contacts.service.js";
import { advanceStage } from "../crm/lifecycle.js";
import { NotificationsService } from "../notifications/notifications.service.js";
import { QUEUES, Queues } from "../queues/queues.js";
import { ApiError, badRequest, conflict, isApiError } from "../common/errors.js";
import { CalendarService } from "./calendar.service.js";
import { meetingIcs } from "./ics.js";
import { setMeetingSync } from "./meeting-sync.js";

type SlotsQueryT = z.infer<typeof BookingSlotsQuery>;
type Visitor = { ip: string; userAgent: string };

const DAY = 86_400_000;
/** At most this much of the calendar per slots request (six weeks: a month view plus its edges). */
const MAX_RANGE_DAYS = 42;
const BOOKING_ACTOR = { type: "system" as const, name: "Booking page" };
/** Reminder emails go out this long before the meeting. */
export const REMINDER_LEAD_MS = DAY;

const rulesOf = (p: BookingPage): SlotRules => ({
  availability: readAvailability(p.availability),
  durationMinutes: p.durationMinutes,
  bufferBeforeMinutes: p.bufferBeforeMinutes,
  bufferAfterMinutes: p.bufferAfterMinutes,
  minNoticeMinutes: p.minNoticeMinutes,
  maxDaysAhead: p.maxDaysAhead,
  slotStepMinutes: p.slotStepMinutes,
});
const hostsOf = (p: BookingPage): string[] => {
  const ids = Array.isArray(p.hostUserIds) ? (p.hostUserIds as string[]) : [];
  return p.assignment === "round_robin" ? ids : ids.slice(0, 1);
};

/** An attendee-facing date line in their own zone: "Monday, 12 October 2026, 09:00 – 09:30 (Europe/Berlin)". */
function whenLine(start: Date, end: Date | null, tz: string) {
  const zone = tz || "UTC";
  const day = new Intl.DateTimeFormat("en-GB", { timeZone: zone, weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(start);
  const time = (d: Date) => new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d);
  return `${day}, ${time(start)}${end ? ` – ${time(end)}` : ""} (${zone})`;
}

/*
 * The public side of booking pages and what keeps booked meetings in step
 * with the host's calendar.
 *
 * Slots: the page's weekly hours minus each host's busy times — their
 * calendar's free/busy (CalendarService.busy) and their scheduled Growthdesk
 * meetings — with buffers, notice and horizon applied (packages/shared
 * computeSlots). A host whose calendar cannot be read right now offers no
 * slots for that request rather than risk a double booking.
 *
 * Booking is race-safe: the slot is re-checked against the calendar, then a
 * transaction takes a per-host advisory lock and re-checks Growthdesk's own
 * meetings before writing, so two visitors pressing "Book" for the same slot
 * at once get one meeting and one 409. The contact is found or created
 * through ContactsService.upsert (source "booking"), the Meeting written with
 * `meeting.booked` (activity + outbox event, same payload as a recorded
 * meeting), and only then is the calendar event created (an outside call,
 * never inside the transaction). A host without a connected calendar still
 * gets the booking — no event is written.
 *
 * The attendee gets a confirmation email (platform mail) with a private
 * manage link (/book/manage/<token>) to cancel or reschedule and an
 * "Add to calendar" .ics link; the host's calendar sends its own invitation.
 * A reminder goes out a day before (calendar queue, delayed job).
 */
@Injectable()
export class BookingService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger("booking");

  constructor(
    private readonly prisma: PrismaService,
    private readonly calendar: CalendarService,
    private readonly contacts: ContactsService,
    private readonly consent: ConsentService,
    private readonly activity: ActivityService,
    private readonly events: EventsService,
    private readonly notifications: NotificationsService,
    private readonly mail: MailService,
    private readonly queues: Queues,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onModuleInit() {
    // PipelineService (meetings edited in the app) asks for the calendar to follow through this hook.
    setMeetingSync(async (workspaceId, meetingId) => {
      const m = await this.prisma.db.meeting.findFirst({ where: { id: meetingId, workspaceId } });
      if (m) await this.syncCalendar(m);
    });
  }

  onModuleDestroy() {
    setMeetingSync(null);
  }

  private link(path: string) {
    return `${this.config.PUBLIC_APP_URL.replace(/\/+$/, "")}${path}`;
  }

  // ─── Reading a page ───────────────────────────────────────────────────────

  /** An active page by slug. Unscoped: the URL names no workspace; everything after is scoped to the page's. */
  private async pageBySlug(slug: string) {
    const page = await this.prisma.unscoped.bookingPage.findFirst({ where: { slug: slug.toLowerCase(), deletedAt: null, active: true }, include: { workspace: { select: { name: true, status: true, billingAccountId: true } } } });
    if (!page || page.workspace.status !== "active") throw new ApiError(404, "not_found", "This booking page isn't available.");
    return page;
  }

  private async hostName(userId: string | null | undefined) {
    if (!userId) return "";
    return (await this.prisma.db.user.findUnique({ where: { id: userId }, select: { name: true } }))?.name ?? "";
  }

  async page(slug: string): Promise<PublicBookingPage> {
    const p = await this.pageBySlug(slug);
    const avail = readAvailability(p.availability);
    const type = p.locationType as BookingLocationType;
    return {
      slug: p.slug,
      title: p.title,
      description: p.description,
      durationMinutes: p.durationMinutes,
      locationType: type,
      locationDetail: type === "in_person" || type === "custom" ? p.locationDetail : "",
      questions: readQuestions(p.questions),
      timezone: avail.timezone,
      maxDaysAhead: p.maxDaysAhead,
      workspaceName: p.workspace.name,
      hostName: p.assignment === "round_robin" ? "" : await this.hostName(hostsOf(p)[0]),
    };
  }

  /**
   * Each host's busy intervals over [from, to): scheduled Growthdesk meetings
   * they own plus every connected calendar's busy times. `except` leaves one
   * meeting out (a reschedule must not be blocked by itself). A host whose
   * calendar answered with an error is left out of the map (no slots).
   */
  private async busyByHost(workspaceId: string, hostIds: string[], from: Date, to: Date, except?: Meeting): Promise<Map<string, BusyInterval[]>> {
    const widened = { from: new Date(from.getTime() - DAY), to: new Date(to.getTime() + DAY) };
    const [meetings, connections] = await Promise.all([
      this.prisma.db.meeting.findMany({
        where: { workspaceId, ownerId: { in: hostIds }, status: "scheduled", startsAt: { gte: widened.from, lt: widened.to }, ...(except ? { id: { not: except.id } } : {}) },
        select: { ownerId: true, startsAt: true, endsAt: true },
      }),
      this.calendar.connectionsOf(workspaceId, hostIds),
    ]);
    const out = new Map<string, BusyInterval[]>(hostIds.map((id) => [id, []]));
    for (const m of meetings) out.get(m.ownerId!)?.push({ start: m.startsAt.getTime(), end: (m.endsAt ?? new Date(m.startsAt.getTime() + 30 * 60_000)).getTime() });
    await Promise.all(
      connections.map(async (c) => {
        try {
          const busy = await this.calendar.busy(c, widened.from, widened.to);
          // The meeting being moved is on the calendar too; its own interval does not block it.
          const own = except && except.calendarConnectionId === c.id ? { start: except.startsAt.getTime(), end: (except.endsAt ?? except.startsAt).getTime() } : null;
          out.get(c.userId)?.push(...busy.filter((b) => !own || b.start !== own.start || b.end !== own.end));
        } catch (e) {
          this.log.warn(`calendar ${c.id} busy read failed: ${e instanceof Error ? e.message : String(e)}`);
          // Revoked access was marked broken (and is skipped from now on); anything else hides this host for now.
          const fresh = await this.prisma.db.calendarConnection.findFirst({ where: { id: c.id, workspaceId }, select: { status: true } });
          if (fresh?.status === "connected") out.delete(c.userId);
        }
      }),
    );
    return out;
  }

  async slots(slug: string, q: SlotsQueryT): Promise<PublicBookingSlots> {
    const p = await this.pageBySlug(slug);
    const rules = rulesOf(p);
    const now = new Date();
    const { earliest, latest } = bookingWindow(rules, now);
    const from = new Date(Math.max(q.from.getTime(), earliest));
    const to = new Date(Math.min(q.to.getTime(), from.getTime() + MAX_RANGE_DAYS * DAY, latest + 1));
    if (to <= from) return { timezone: q.timezone, days: [] };
    const busy = await this.busyByHost(p.workspaceId, hostsOf(p), from, to);
    const slots = [...hostSlots(rules, { from, to }, busy, now).keys()].map((t) => new Date(t));
    return { timezone: q.timezone, days: groupSlotsByDay(slots, q.timezone) };
  }

  // ─── Booking ──────────────────────────────────────────────────────────────

  /** Takes a per-host lock for the rest of the transaction and re-checks the host's Growthdesk meetings under it. */
  private async lockAndCheck(tx: Tx, workspaceId: string, hostId: string, rules: SlotRules, start: Date, except?: string) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`booking:${hostId}`}))`;
    const from = new Date(start.getTime() - DAY);
    const rows = await tx.meeting.findMany({
      where: { workspaceId, ownerId: hostId, status: "scheduled", startsAt: { gte: from, lt: new Date(start.getTime() + DAY) }, ...(except ? { id: { not: except } } : {}) },
      select: { startsAt: true, endsAt: true },
    });
    const busy = rows.map((m) => ({ start: m.startsAt.getTime(), end: (m.endsAt ?? new Date(m.startsAt.getTime() + 30 * 60_000)).getTime() }));
    if (!isSlotAvailable(rules, start, busy)) throw conflict("That time was just taken. Pick another time.");
  }

  async book(slug: string, input: BookInputT, visitor: Visitor): Promise<PublicBooking> {
    const p = await this.pageBySlug(slug);
    const rules = rulesOf(p);
    const start = input.start;
    const end = new Date(start.getTime() + p.durationMinutes * 60_000);
    const questions = readQuestions(p.questions);
    const answers = questions.map((q) => ({ id: q.id, question: q.label, type: q.type, answer: input.answers[q.id] }));
    for (const a of answers) {
      const q = questions.find((x) => x.id === a.id)!;
      if (q.type === "consent") continue;
      if (q.required && (typeof a.answer !== "string" || !a.answer.trim())) throw badRequest(`${q.label}: required`, { [`answers.${q.id}`]: "Required" });
    }
    const consentQuestion = questions.find((q) => q.type === "consent");
    const consented = Boolean(consentQuestion && (input.consent === true || input.answers[consentQuestion.id] === true));
    if (consentQuestion?.required && !consented) throw badRequest(`${consentQuestion.label}: required`, { consent: "Required" });
    const phoneQuestion = questions.find((q) => q.type === "phone");
    const phone = (input.phone || (phoneQuestion && typeof input.answers[phoneQuestion.id] === "string" ? (input.answers[phoneQuestion.id] as string) : "")).trim() || undefined;
    if (consented && !phone) throw badRequest("Add your phone number so we can call you", { phone: "Required to be called" });

    // 1. Who is free at that time (calendar + meetings), before anything is written.
    const hosts = hostsOf(p);
    const busy = await this.busyByHost(p.workspaceId, hosts, new Date(start.getTime() - DAY), new Date(end.getTime() + DAY));
    const free = [...busy.entries()].filter(([, b]) => isSlotAvailable(rules, start, b)).map(([id]) => id);
    const chosen = pickHost(hosts, p.roundRobinCursor, free);
    if (!chosen) throw conflict("That time is no longer available. Pick another time.");

    // 2. The contact, through the CRM's single way in (dedupe by email / phone, attribution as "booking").
    let contactId: string | null = null;
    try {
      const res = await this.contacts.upsert(
        p.workspaceId,
        p.workspace.billingAccountId,
        { fullName: input.name, email: input.email, phone, timezone: input.timezone, ownerId: chosen.hostId, leadSource: "Booking page" },
        { source: "booking", sourceData: { bookingPageId: p.id, slug: p.slug }, onDuplicate: "update", defaultCountry: await this.contacts.defaultCountry(p.workspaceId), actorId: null, emitEvent: "contact.created" },
      );
      contactId = res.contactId;
    } catch (e) {
      // A full plan or an erased person still gets their meeting; it just isn't linked to a contact.
      if (!(isApiError(e) && (e.code === "plan_limit" || e.code === "erased_contact"))) throw e;
      this.log.warn(`booking on ${p.id}: contact not saved (${e.message})`);
    }

    // 3. The meeting, under the host's lock.
    const manageToken = randomBytes(24).toString("base64url");
    const type = p.locationType as BookingLocationType;
    const meeting = await this.prisma.db.$transaction(async (tx) => {
      await this.lockAndCheck(tx, p.workspaceId, chosen.hostId, rules, start);
      if (contactId) {
        const c = await tx.contact.findFirst({ where: { id: contactId, workspaceId: p.workspaceId }, select: { ownerId: true } });
        if (c && !c.ownerId) await tx.contact.update({ where: { id: contactId, workspaceId: p.workspaceId }, data: { ownerId: chosen.hostId } });
        if (consented) {
          await this.consent.setIn(tx, {
            workspaceId: p.workspaceId,
            contactId,
            status: "granted",
            source: `Booking page: ${p.title}`.slice(0, 200),
            ip: visitor.ip,
            userAgent: visitor.userAgent,
            detail: { via: "booking", bookingPageId: p.id, question: consentQuestion?.label ?? "" },
          });
        }
      }
      const m = await tx.meeting.create({
        data: {
          workspaceId: p.workspaceId,
          title: `${p.title} – ${input.name}`.slice(0, 200),
          startsAt: start,
          endsAt: end,
          location: type === "phone" ? phone || p.locationDetail : type === "google_meet" || type === "teams" ? "" : p.locationDetail,
          contactId,
          ownerId: chosen.hostId,
          status: "scheduled",
          source: "booking",
          bookingPageId: p.id,
          attendeeName: input.name,
          attendeeEmail: input.email,
          timezone: input.timezone,
          answers: answers.filter((a) => a.answer !== undefined && a.answer !== "").map((a) => ({ question: a.question, answer: a.answer })),
          manageToken,
        },
      });
      if (p.assignment === "round_robin") await tx.bookingPage.update({ where: { id: p.id, workspaceId: p.workspaceId }, data: { roundRobinCursor: chosen.nextCursor } });
      await advanceStage(tx, p.workspaceId, [m.contactId], "sales");
      await this.activity.log({ workspaceId: p.workspaceId, contactId: m.contactId, actor: BOOKING_ACTOR, type: "meeting.booked", summary: `Meeting booked: ${m.title}`, data: { startsAt: m.startsAt, bookingPageId: p.id, source: "booking" } }, tx);
      await this.events.emitIn(tx, { workspaceId: p.workspaceId, type: "meeting.booked", subjectType: "meeting", subjectId: m.id, actorId: null, payload: { contactId: m.contactId, dealId: m.dealId, startsAt: m.startsAt } });
      return m;
    });
    await this.events.kick();

    // 4. The host's calendar (outside the transaction: an outside call). A failure leaves the booking in place.
    let written = meeting;
    try {
      const ev = await this.calendar.createEvent(
        p.workspaceId,
        chosen.hostId,
        {
          title: `${p.title} – ${input.name}`,
          description: this.eventDescription(p, input, answers),
          start,
          end,
          timezone: input.timezone,
          location: meeting.location || (type === "google_meet" || type === "teams" ? "" : BOOKING_LOCATION_LABELS[type]),
          attendee: { email: input.email, name: input.name },
          requestId: meeting.id,
        },
        type,
      );
      if (ev) {
        written = await this.prisma.db.meeting.update({
          where: { id: meeting.id, workspaceId: p.workspaceId },
          data: { calendarConnectionId: ev.connectionId, externalEventId: ev.id, conferenceUrl: ev.conferenceUrl, ...(ev.conferenceUrl && !meeting.location ? { location: ev.conferenceUrl } : {}) },
        });
      }
    } catch (e) {
      this.log.warn(`booking ${meeting.id}: calendar event not written: ${e instanceof Error ? e.message : String(e)}`);
    }

    const hostName = await this.hostName(chosen.hostId);
    await this.notifications.notify(p.workspaceId, [chosen.hostId], {
      type: "meeting.booked",
      title: `New booking: ${input.name}`,
      body: `${p.title} on ${whenLine(start, end, readAvailability(p.availability).timezone)}${written.externalEventId ? "" : " — not added to your calendar (connect one under Settings → Calendar)"}.`,
      link: `/w/${p.workspaceId}/meetings`,
      email: true,
    });
    await this.confirmationEmail(written, p, hostName, "booked");
    await this.scheduleReminder(written);
    return this.dto(written, p, hostName);
  }

  private eventDescription(p: BookingPage, input: BookInputT, answers: { question: string; type: string; answer: string | boolean | undefined }[]) {
    const lines = [`Booked through ${p.title} by ${input.name} <${input.email}>.`];
    if (input.phone) lines.push(`Phone: ${input.phone}`);
    for (const a of answers) if (a.answer !== undefined && a.answer !== "" && a.type !== "consent") lines.push(`${a.question}: ${String(a.answer)}`);
    if (p.locationType === "phone") lines.push("We'll call you at the number you gave.");
    return lines.join("\n");
  }

  // ─── Manage by token ──────────────────────────────────────────────────────

  /** A meeting by its manage token. Unscoped: the token is the only key the attendee has; everything after is scoped to its workspace. */
  private async byToken(token: string) {
    const gone = () => new ApiError(404, "not_found", "This booking link isn't valid.");
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) throw gone();
    const m = await this.prisma.unscoped.meeting.findFirst({ where: { manageToken: token }, include: { bookingPage: true } });
    if (!m) throw gone();
    return m;
  }

  private dto(m: Meeting, page: BookingPage | null, hostName: string): PublicBooking {
    const usable = page && !page.deletedAt && page.active;
    return {
      id: m.id,
      title: page?.title ?? m.title,
      startsAt: m.startsAt.toISOString(),
      endsAt: m.endsAt?.toISOString() ?? null,
      timezone: m.timezone,
      status: m.status,
      attendeeName: m.attendeeName,
      attendeeEmail: m.attendeeEmail,
      hostName,
      location: m.location,
      conferenceUrl: m.conferenceUrl,
      confirmationMessage: page?.confirmationMessage ?? "",
      manageToken: m.manageToken ?? "",
      page: usable ? { slug: page.slug, durationMinutes: page.durationMinutes, maxDaysAhead: page.maxDaysAhead } : null,
      canceledAt: m.canceledAt?.toISOString() ?? null,
      cancelReason: m.cancelReason,
    };
  }

  async manage(token: string): Promise<PublicBooking> {
    const m = await this.byToken(token);
    return this.dto(m, m.bookingPage, await this.hostName(m.ownerId));
  }

  async cancel(token: string, reason: string): Promise<PublicBooking> {
    const m = await this.byToken(token);
    const hostName = await this.hostName(m.ownerId);
    if (m.status === "canceled") return this.dto(m, m.bookingPage, hostName);
    if (m.status !== "scheduled" || m.startsAt.getTime() < Date.now()) throw conflict("This meeting can no longer be canceled here. Reply to the invitation instead.");
    const updated = await this.prisma.db.$transaction(async (tx) => {
      const res = await tx.meeting.updateMany({ where: { id: m.id, workspaceId: m.workspaceId, status: "scheduled" }, data: { status: "canceled", canceledAt: new Date(), cancelReason: reason } });
      if (!res.count) throw conflict("This meeting was already changed. Reload the page.");
      await this.activity.log({ workspaceId: m.workspaceId, contactId: m.contactId, dealId: m.dealId, actor: { type: "system", name: m.attendeeName || "Attendee" }, type: "meeting.canceled", summary: `Meeting canceled by the attendee: ${m.title}`, data: { reason, startsAt: m.startsAt } }, tx);
      return tx.meeting.findFirstOrThrow({ where: { id: m.id, workspaceId: m.workspaceId } });
    });
    await this.syncCalendar(updated);
    if (m.ownerId) {
      await this.notifications.notify(m.workspaceId, [m.ownerId], {
        type: "meeting.canceled",
        title: `Booking canceled: ${m.attendeeName || m.attendeeEmail}`,
        body: `${m.title} on ${whenLine(m.startsAt, m.endsAt, m.timezone)} was canceled.${reason ? ` Reason: ${reason}` : ""}`,
        link: `/w/${m.workspaceId}/meetings`,
        email: true,
      });
    }
    await this.confirmationEmail(updated, m.bookingPage, hostName, "canceled");
    return this.dto(updated, m.bookingPage, hostName);
  }

  async reschedule(token: string, start: Date): Promise<PublicBooking> {
    const m = await this.byToken(token);
    const p = m.bookingPage;
    if (!p || p.deletedAt || !p.active) throw conflict("This booking page is no longer available, so the meeting can't be moved here. Reply to the invitation instead.");
    if (m.status !== "scheduled" || m.startsAt.getTime() < Date.now()) throw conflict("This meeting can no longer be rescheduled here.");
    if (!m.ownerId) throw conflict("This meeting has no host any more. Reply to the invitation instead.");
    const rules = rulesOf(p);
    const end = new Date(start.getTime() + p.durationMinutes * 60_000);
    // The same host keeps the meeting (round robin does not reassign it).
    const busy = await this.busyByHost(m.workspaceId, [m.ownerId], new Date(start.getTime() - DAY), new Date(end.getTime() + DAY), m);
    const hostBusy = busy.get(m.ownerId);
    if (!hostBusy || !isSlotAvailable(rules, start, hostBusy)) throw conflict("That time is not available. Pick another time.");
    const previous = m.startsAt;
    const updated = await this.prisma.db.$transaction(async (tx) => {
      await this.lockAndCheck(tx, m.workspaceId, m.ownerId!, rules, start, m.id);
      const res = await tx.meeting.updateMany({ where: { id: m.id, workspaceId: m.workspaceId, status: "scheduled" }, data: { startsAt: start, endsAt: end } });
      if (!res.count) throw conflict("This meeting was already changed. Reload the page.");
      await this.activity.log({ workspaceId: m.workspaceId, contactId: m.contactId, dealId: m.dealId, actor: { type: "system", name: m.attendeeName || "Attendee" }, type: "meeting.rescheduled", summary: `Meeting rescheduled by the attendee: ${m.title}`, data: { from: previous, startsAt: start } }, tx);
      return tx.meeting.findFirstOrThrow({ where: { id: m.id, workspaceId: m.workspaceId } });
    });
    await this.syncCalendar(updated);
    const hostName = await this.hostName(m.ownerId);
    await this.notifications.notify(m.workspaceId, [m.ownerId], {
      type: "meeting.rescheduled",
      title: `Booking moved: ${m.attendeeName || m.attendeeEmail}`,
      body: `${p.title} moved from ${whenLine(previous, null, readAvailability(p.availability).timezone)} to ${whenLine(start, end, readAvailability(p.availability).timezone)}.`,
      link: `/w/${m.workspaceId}/meetings`,
      email: true,
    });
    await this.confirmationEmail(updated, p, hostName, "rescheduled");
    await this.scheduleReminder(updated);
    return this.dto(updated, p, hostName);
  }

  /** The attendee's .ics copy of the meeting. */
  async ics(token: string): Promise<string> {
    const m = await this.byToken(token);
    const host = m.ownerId ? await this.prisma.db.user.findUnique({ where: { id: m.ownerId }, select: { name: true, email: true } }) : null;
    return meetingIcs({
      uid: `${m.id}@growthdesk`,
      sequence: Math.floor((m.updatedAt.getTime() - m.createdAt.getTime()) / 1000),
      title: m.bookingPage?.title ?? m.title,
      description: `${m.conferenceUrl ? `Join: ${m.conferenceUrl}\n` : ""}Cancel or reschedule: ${this.link(`/book/manage/${m.manageToken}`)}`,
      location: m.conferenceUrl || m.location,
      start: m.startsAt,
      end: m.endsAt ?? new Date(m.startsAt.getTime() + 30 * 60_000),
      canceled: m.status === "canceled",
      organizer: host,
      url: this.link(`/book/manage/${m.manageToken}`),
    });
  }

  // ─── Calendar follow-through ──────────────────────────────────────────────

  /** Queued by PipelineService when a meeting changes in the app (meeting-sync.ts). */
  async enqueueSync(workspaceId: string, meetingId: string) {
    try {
      await this.queues.add(QUEUES.calendar, "meeting.sync", { workspaceId, meetingId }, { jobId: `sync-${meetingId}-${Date.now()}` });
    } catch (e) {
      this.log.warn(`could not queue calendar sync for ${meetingId}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /**
   * Makes the host's calendar event match the meeting: a canceled meeting
   * cancels the event (once — the event id is cleared), any other moves it to
   * the meeting's time. Idempotent. Failures are queued for retry.
   */
  async syncCalendar(m: Meeting) {
    try {
      await this.syncNow(m);
    } catch (e) {
      this.log.warn(`meeting ${m.id}: calendar not updated (${e instanceof Error ? e.message : String(e)}); retrying in the background`);
      await this.enqueueSync(m.workspaceId, m.id);
    }
  }

  private async syncNow(m: Meeting) {
    if (!m.externalEventId || !m.calendarConnectionId) return false;
    if (m.status === "canceled") {
      await this.calendar.cancelEvent(m);
      await this.prisma.db.meeting.updateMany({ where: { id: m.id, workspaceId: m.workspaceId, externalEventId: m.externalEventId }, data: { externalEventId: null, canceledAt: m.canceledAt ?? new Date() } });
      return true;
    }
    return this.calendar.moveEvent(m);
  }

  /** The worker's `meeting.sync` job. Throws so BullMQ retries a calendar that is down. */
  async syncJob(workspaceId: string, meetingId: string) {
    const m = await this.prisma.db.meeting.findFirst({ where: { id: meetingId, workspaceId } });
    if (!m) return false;
    return this.syncNow(m);
  }

  // ─── Attendee email ───────────────────────────────────────────────────────

  private async confirmationEmail(m: Meeting, p: BookingPage | null, hostName: string, kind: "booked" | "rescheduled" | "canceled" | "reminder") {
    if (!m.attendeeEmail || !m.manageToken) return;
    const title = p?.title ?? m.title;
    const when = whenLine(m.startsAt, m.endsAt, m.timezone);
    const manage = this.link(`/book/manage/${m.manageToken}`);
    const ics = this.link(`/api/public/booking/manage/${m.manageToken}/ics`);
    const where = m.conferenceUrl ? `Join: ${m.conferenceUrl}` : m.location ? `Where: ${m.location}` : "";
    const subject = {
      booked: `Confirmed: ${title}${hostName ? ` with ${hostName}` : ""}`,
      rescheduled: `Rescheduled: ${title}${hostName ? ` with ${hostName}` : ""}`,
      canceled: `Canceled: ${title}${hostName ? ` with ${hostName}` : ""}`,
      reminder: `Reminder: ${title} tomorrow`,
    }[kind];
    const paragraphs =
      kind === "canceled"
        ? [`Hi ${m.attendeeName || "there"},`, `Your meeting "${title}" on ${when} is canceled.`, ...(p && !p.deletedAt && p.active ? [`You can book a new time at ${this.link(`/book/${p.slug}`)}.`] : [])]
        : [
            `Hi ${m.attendeeName || "there"},`,
            kind === "booked" ? `You're booked: ${title}${hostName ? ` with ${hostName}` : ""}.` : kind === "rescheduled" ? `Your meeting "${title}" has a new time.` : `A reminder: ${title}${hostName ? ` with ${hostName}` : ""} is coming up.`,
            `When: ${when}`,
            ...(where ? [where] : []),
            ...(kind === "booked" && p?.confirmationMessage ? [p.confirmationMessage] : []),
            `Add it to your calendar: ${ics}`,
            "Need to change it? Use the button below to reschedule or cancel.",
          ];
    await this.mail.send({
      to: m.attendeeEmail,
      subject,
      text: `${paragraphs.join("\n\n")}\n\nManage your booking: ${manage}`,
      html: layout(subject, paragraphs, kind === "canceled" ? undefined : { label: "Reschedule or cancel", url: manage }),
      template: `booking_${kind}`,
      stream: "transactional",
    });
  }

  private async scheduleReminder(m: Meeting) {
    const at = m.startsAt.getTime() - REMINDER_LEAD_MS;
    // Booked less than a day ahead: the confirmation is reminder enough.
    if (at <= Date.now()) return;
    try {
      await this.queues.add(QUEUES.calendar, "reminder", { workspaceId: m.workspaceId, meetingId: m.id, startsAt: m.startsAt.toISOString() }, { jobId: `reminder-${m.id}-${m.startsAt.getTime()}`, delay: at - Date.now(), attempts: 3 });
    } catch (e) {
      this.log.warn(`could not schedule the reminder for ${m.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** The `reminder` job: sends only if the meeting is still on, at the time the job was made for (a reschedule queues its own). */
  async remind(workspaceId: string, meetingId: string, startsAt: string) {
    const m = await this.prisma.db.meeting.findFirst({ where: { id: meetingId, workspaceId }, include: { bookingPage: true } });
    if (!m || m.status !== "scheduled" || m.startsAt.toISOString() !== startsAt || m.startsAt.getTime() < Date.now()) return false;
    await this.confirmationEmail(m, m.bookingPage, await this.hostName(m.ownerId), "reminder");
    return true;
  }
}
