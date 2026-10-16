/*
 * API shapes for calendar connections and booking pages (apps/api/src/booking).
 * The public page's shapes (PublicBookingPage, PublicBookingSlots,
 * PublicBooking) live in @growthdesk/shared.
 */
import type { BookingAssignment, BookingAvailabilityT, BookingLocationType, BookingQuestionT, CalendarProvider } from "@growthdesk/shared";
import type { MeetingRow } from "./pipeline";

/** One of the signed-in person's calendar connections. */
export type CalendarConnection = {
  id: string;
  provider: CalendarProvider;
  email: string;
  calendarId: string;
  /** Calendars whose busy times block slots; empty = the write calendar only. */
  busyCalendarIds: string[];
  status: "connected" | "error" | "disconnected";
  lastError: string;
  lastSyncedAt: string | null;
  createdAt: string;
};

/** GET /calendar/connections */
export type MyCalendars = {
  /** Providers this installation has an OAuth client for. */
  available: Record<CalendarProvider, boolean>;
  /** What a platform admin adds to each OAuth app. */
  redirectUris: Record<CalendarProvider, string>;
  connections: CalendarConnection[];
};

/** GET /calendar/connections/:id/calendars */
export type ProviderCalendar = { id: string; name: string; primary: boolean; writable: boolean };

/** GET /booking-pages */
export type BookingPage = {
  id: string;
  slug: string;
  url: string;
  title: string;
  description: string;
  durationMinutes: number;
  assignment: BookingAssignment;
  hostUserIds: string[];
  hosts: { userId: string; name: string; email: string; calendar: { provider: CalendarProvider; email: string; status: string } | null }[];
  availability: BookingAvailabilityT;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  minNoticeMinutes: number;
  maxDaysAhead: number;
  slotStepMinutes: number;
  locationType: BookingLocationType;
  locationDetail: string;
  questions: BookingQuestionT[];
  confirmationMessage: string;
  active: boolean;
  upcomingBookings: number;
  createdAt: string;
  updatedAt: string;
};

/** Meeting source: manual (recorded in the app), booking (a booking page), ai_call, calendar. */
export type MeetingSource = "manual" | "booking" | "ai_call" | "calendar";

/** GET /meetings rows, with the booking fields the API returns. */
export type BookedMeetingRow = MeetingRow & {
  source?: MeetingSource;
  attendeeName?: string;
  attendeeEmail?: string;
  conferenceUrl?: string;
  timezone?: string;
  answers?: { question: string; answer: string | boolean }[];
  cancelReason?: string;
  bookingPage?: { id: string; title: string; slug: string } | null;
};
