import type { BusyInterval, CalendarProvider } from "@growthdesk/shared";

/*
 * Google Calendar and Microsoft Graph over plain HTTP (no SDK): what booking
 * pages need from a teammate's calendar.
 *
 *   Google (https://developers.google.com/calendar/api/v3/reference)
 *     GET    /calendar/v3/users/me/calendarList           calendars to choose from
 *     POST   /calendar/v3/freeBusy                        busy times of chosen calendars
 *     POST   /calendar/v3/calendars/{id}/events           the booked event (+ Meet link: conferenceData.createRequest)
 *     PATCH  /calendar/v3/calendars/{id}/events/{eid}     a new time (reschedule)
 *     DELETE /calendar/v3/calendars/{id}/events/{eid}     cancel; sendUpdates=all tells the attendee
 *   Microsoft Graph (https://learn.microsoft.com/graph/api/resources/calendar)
 *     GET    /v1.0/me/calendars
 *     GET    /v1.0/me/calendars/{id}/calendarView          events in a range (busy = showAs other than free)
 *     POST   /v1.0/me/calendars/{id}/events                the event (+ Teams link: isOnlineMeeting)
 *     PATCH  /v1.0/me/events/{eid}
 *     POST   /v1.0/me/events/{eid}/cancel                 the organiser cancels; Graph tells attendees
 *
 * Base URLs are overridable for tests (a local fake), read on every call —
 * never set them in production:
 *   GOOGLE_OAUTH_URL         https://oauth2.googleapis.com        (/token)
 *   GOOGLE_USERINFO_URL      https://openidconnect.googleapis.com (/v1/userinfo)
 *   GOOGLE_CALENDAR_API_URL  https://www.googleapis.com
 *   MICROSOFT_LOGIN_URL      https://login.microsoftonline.com    (/{tenant}/oauth2/v2.0/token)
 *   MICROSOFT_GRAPH_API_URL  https://graph.microsoft.com
 */

const TIMEOUT_MS = 15_000;
const base = (name: string, fallback: string) => (process.env[name]?.trim() || fallback).replace(/\/+$/, "");
export const googleOAuthBase = () => base("GOOGLE_OAUTH_URL", "https://oauth2.googleapis.com");
export const googleUserinfoBase = () => base("GOOGLE_USERINFO_URL", "https://openidconnect.googleapis.com");
export const googleCalendarBase = () => base("GOOGLE_CALENDAR_API_URL", "https://www.googleapis.com");
export const microsoftLoginBase = () => base("MICROSOFT_LOGIN_URL", "https://login.microsoftonline.com");
export const microsoftGraphBase = () => base("MICROSOFT_GRAPH_API_URL", "https://graph.microsoft.com");
/** A test fake is configured: the local fake is reachable, whatever PUBLIC_APP_URL says. */
export const calendarFakeConfigured = () => Boolean(process.env.GOOGLE_CALENDAR_API_URL?.trim() || process.env.MICROSOFT_GRAPH_API_URL?.trim());

export const CALENDAR_SCOPES: Record<CalendarProvider, string> = {
  google: "openid email https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.readonly",
  microsoft: "offline_access openid email User.Read Calendars.ReadWrite",
};

export const authorizeUrl = (provider: CalendarProvider, tenant: string) =>
  provider === "google" ? "https://accounts.google.com/o/oauth2/v2/auth" : `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/authorize`;
export const tokenUrl = (provider: CalendarProvider, tenant: string) =>
  provider === "google" ? `${googleOAuthBase()}/token` : `${microsoftLoginBase()}/${encodeURIComponent(tenant)}/oauth2/v2.0/token`;

export class CalendarApiError extends Error {
  constructor(
    message: string,
    /** HTTP status; 0 when the provider could not be reached. */
    readonly status: number,
  ) {
    super(message);
    this.name = "CalendarApiError";
  }
  /** The sign-in itself was refused (revoked access, expired grant): reconnecting is the only fix. */
  get isAuth() {
    return this.status === 401;
  }
  get transient() {
    return this.status === 0 || this.status === 429 || this.status >= 500;
  }
}

export type TokenSet = { access_token: string; refresh_token?: string; expires_in?: number; scope?: string; id_token?: string };

/** POSTs a form to a provider's token endpoint (code exchange or refresh). */
export async function tokenRequest(url: string, form: Record<string, string>): Promise<TokenSet> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams(form),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    throw new CalendarApiError(`The sign-in service could not be reached: ${e instanceof Error ? e.message : String(e)}`, 0);
  }
  const body = (await res.json().catch(() => ({}))) as Partial<TokenSet> & { error?: string; error_description?: string };
  if (!res.ok || !body.access_token) {
    // A refused grant (400 invalid_grant) means the sign-in is gone; reported as 401 so callers treat it as "reconnect".
    const status = res.status === 400 || res.status === 401 ? 401 : res.status || 0;
    throw new CalendarApiError(body.error_description ?? body.error ?? `HTTP ${res.status}`, status);
  }
  return body as TokenSet;
}

async function call<T>(token: string, method: "GET" | "POST" | "PATCH" | "DELETE", url: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: { authorization: `Bearer ${token}`, accept: "application/json", ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: "error",
    });
  } catch (e) {
    const err = e as { name?: string };
    throw new CalendarApiError(err.name === "TimeoutError" ? "The calendar did not answer in time" : "The calendar could not be reached", 0);
  }
  const raw = await res.text().catch(() => "");
  let json: unknown = null;
  try {
    json = raw ? JSON.parse(raw) : null;
  } catch {
    json = null;
  }
  if (!res.ok) {
    const err = (json as { error?: { message?: string } | string; error_description?: string } | null)?.error;
    const message = (typeof err === "string" ? err : err?.message) || `The calendar answered HTTP ${res.status}`;
    throw new CalendarApiError(message.replace(/\s+/g, " ").slice(0, 300), res.status);
  }
  return json as T;
}

export type ProviderCalendar = { id: string; name: string; primary: boolean; writable: boolean };

export type NewEvent = {
  title: string;
  description: string;
  start: Date;
  end: Date;
  /** The attendee's own zone, so the invite reads naturally to them. */
  timezone: string;
  location: string;
  attendee: { email: string; name: string };
  /** Ask the provider for a video link (Google Meet / Teams). */
  conference: boolean;
  /** Idempotency for the conference request (the meeting id). */
  requestId: string;
};

export type CreatedEvent = { id: string; conferenceUrl: string };

// ─── Google ──────────────────────────────────────────────────────────────────

type GoogleEvent = { id: string; hangoutLink?: string; conferenceData?: { entryPoints?: { entryPointType?: string; uri?: string }[] } };
const gcal = (path: string) => `${googleCalendarBase()}/calendar/v3${path}`;
const enc = encodeURIComponent;

const google = {
  async email(token: string): Promise<{ email: string | null; verified: boolean }> {
    const info = await call<{ email?: string; email_verified?: boolean }>(token, "GET", `${googleUserinfoBase()}/v1/userinfo`);
    return { email: info?.email ?? null, verified: info?.email_verified !== false };
  },

  async calendars(token: string): Promise<ProviderCalendar[]> {
    const res = await call<{ items?: { id: string; summary?: string; summaryOverride?: string; primary?: boolean; accessRole?: string }[] }>(token, "GET", gcal("/users/me/calendarList?maxResults=250"));
    return (res?.items ?? []).map((c) => ({ id: c.id, name: c.summaryOverride || c.summary || c.id, primary: Boolean(c.primary), writable: c.accessRole === "owner" || c.accessRole === "writer" }));
  },

  async busy(token: string, calendarIds: string[], from: Date, to: Date): Promise<BusyInterval[]> {
    const res = await call<{ calendars?: Record<string, { busy?: { start: string; end: string }[] }> }>(token, "POST", gcal("/freeBusy"), {
      timeMin: from.toISOString(),
      timeMax: to.toISOString(),
      items: calendarIds.map((id) => ({ id })),
    });
    return Object.values(res?.calendars ?? {}).flatMap((c) => (c.busy ?? []).map((b) => ({ start: Date.parse(b.start), end: Date.parse(b.end) })));
  },

  async create(token: string, calendarId: string, e: NewEvent): Promise<CreatedEvent> {
    const ev = await call<GoogleEvent>(token, "POST", gcal(`/calendars/${enc(calendarId)}/events?sendUpdates=all${e.conference ? "&conferenceDataVersion=1" : ""}`), {
      summary: e.title,
      description: e.description,
      location: e.location || undefined,
      start: { dateTime: e.start.toISOString(), timeZone: e.timezone },
      end: { dateTime: e.end.toISOString(), timeZone: e.timezone },
      attendees: [{ email: e.attendee.email, displayName: e.attendee.name }],
      ...(e.conference ? { conferenceData: { createRequest: { requestId: e.requestId, conferenceSolutionKey: { type: "hangoutsMeet" } } } } : {}),
    });
    const video = ev.conferenceData?.entryPoints?.find((p) => p.entryPointType === "video")?.uri;
    return { id: ev.id, conferenceUrl: ev.hangoutLink || video || "" };
  },

  async move(token: string, calendarId: string, eventId: string, start: Date, end: Date, timezone: string) {
    await call(token, "PATCH", gcal(`/calendars/${enc(calendarId)}/events/${enc(eventId)}?sendUpdates=all`), {
      start: { dateTime: start.toISOString(), timeZone: timezone },
      end: { dateTime: end.toISOString(), timeZone: timezone },
    });
  },

  async cancel(token: string, calendarId: string, eventId: string) {
    try {
      await call(token, "DELETE", gcal(`/calendars/${enc(calendarId)}/events/${enc(eventId)}?sendUpdates=all`));
    } catch (e) {
      // Already deleted on the calendar side: nothing left to do.
      if (e instanceof CalendarApiError && (e.status === 404 || e.status === 410)) return;
      throw e;
    }
  },
};

// ─── Microsoft ───────────────────────────────────────────────────────────────

const graph = (path: string) => `${microsoftGraphBase()}/v1.0${path}`;
/** "primary" is our name for the account's default calendar. */
const msCalendar = (id: string) => (id === "primary" ? "/me/calendar" : `/me/calendars/${enc(id)}`);
/** Graph's dateTimeTimeZone, in UTC. */
const msTime = (d: Date) => ({ dateTime: d.toISOString().replace(/Z$/, ""), timeZone: "UTC" });

const microsoft = {
  async calendars(token: string): Promise<ProviderCalendar[]> {
    const res = await call<{ value?: { id: string; name?: string; canEdit?: boolean; isDefaultCalendar?: boolean }[] }>(token, "GET", graph("/me/calendars?$top=100"));
    return (res?.value ?? []).map((c) => ({ id: c.isDefaultCalendar ? "primary" : c.id, name: c.name || c.id, primary: Boolean(c.isDefaultCalendar), writable: c.canEdit !== false }));
  },

  async busy(token: string, calendarIds: string[], from: Date, to: Date): Promise<BusyInterval[]> {
    const out: BusyInterval[] = [];
    for (const id of calendarIds) {
      const q = `startDateTime=${enc(from.toISOString())}&endDateTime=${enc(to.toISOString())}&$select=start,end,showAs,isCancelled&$top=500`;
      const res = await call<{ value?: { start: { dateTime: string }; end: { dateTime: string }; showAs?: string; isCancelled?: boolean }[] }>(token, "GET", graph(`${msCalendar(id)}/calendarView?${q}`), undefined, {
        prefer: 'outlook.timezone="UTC"',
      });
      for (const ev of res?.value ?? []) {
        if (ev.isCancelled || ev.showAs === "free" || ev.showAs === "workingElsewhere") continue;
        out.push({ start: Date.parse(`${ev.start.dateTime.replace(/Z$/, "")}Z`), end: Date.parse(`${ev.end.dateTime.replace(/Z$/, "")}Z`) });
      }
    }
    return out;
  },

  async create(token: string, calendarId: string, e: NewEvent): Promise<CreatedEvent> {
    const ev = await call<{ id: string; onlineMeeting?: { joinUrl?: string } | null; onlineMeetingUrl?: string | null }>(token, "POST", graph(`${msCalendar(calendarId)}/events`), {
      subject: e.title,
      body: { contentType: "text", content: e.description },
      start: msTime(e.start),
      end: msTime(e.end),
      ...(e.location ? { location: { displayName: e.location } } : {}),
      attendees: [{ emailAddress: { address: e.attendee.email, name: e.attendee.name }, type: "required" }],
      ...(e.conference ? { isOnlineMeeting: true, onlineMeetingProvider: "teamsForBusiness" } : {}),
      transactionId: e.requestId,
    });
    return { id: ev.id, conferenceUrl: ev.onlineMeeting?.joinUrl || ev.onlineMeetingUrl || "" };
  },

  async move(token: string, _calendarId: string, eventId: string, start: Date, end: Date) {
    await call(token, "PATCH", graph(`/me/events/${enc(eventId)}`), { start: msTime(start), end: msTime(end) });
  },

  async cancel(token: string, _calendarId: string, eventId: string) {
    try {
      await call(token, "POST", graph(`/me/events/${enc(eventId)}/cancel`), { comment: "This meeting was canceled." });
    } catch (e) {
      if (e instanceof CalendarApiError && (e.status === 404 || e.status === 410)) return;
      // Not the organiser (or Graph refuses cancel for some reason): remove it from this calendar at least.
      if (e instanceof CalendarApiError && e.status === 400) {
        await call(token, "DELETE", graph(`/me/events/${enc(eventId)}`)).catch(() => undefined);
        return;
      }
      throw e;
    }
  },
};

/** What booking needs from each provider. */
export type CalendarAdapter = {
  calendars(token: string): Promise<ProviderCalendar[]>;
  busy(token: string, calendarIds: string[], from: Date, to: Date): Promise<BusyInterval[]>;
  create(token: string, calendarId: string, e: NewEvent): Promise<CreatedEvent>;
  move(token: string, calendarId: string, eventId: string, start: Date, end: Date, timezone: string): Promise<void>;
  cancel(token: string, calendarId: string, eventId: string): Promise<void>;
};

export const CALENDAR_API: Record<CalendarProvider, CalendarAdapter> = { google, microsoft };
export const googleAccountEmail = google.email;

/** The account's address from a Microsoft id_token (received over TLS from the token endpoint, so trusted without a signature check, OIDC Core §3.1.3.7). */
export function microsoftIdTokenEmail(idToken: string | undefined): string | null {
  const payload = idToken?.split(".")[1];
  if (!payload) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { email?: string; preferred_username?: string; upn?: string };
    return claims.email ?? claims.preferred_username ?? claims.upn ?? null;
  } catch {
    return null;
  }
}
