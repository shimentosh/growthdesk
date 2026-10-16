import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { BookingService } from "../src/booking/booking.service.js";
import { CalendarService } from "../src/booking/calendar.service.js";
import { PlatformSettingsService } from "../src/core/platform-settings.service.js";
import { addMember, bootApp, createWorkspace, enableGoogleSignIn, GOOGLE_TEST_CLIENT, setPlan, signUp, type Agent, type TestApp } from "./helpers.js";

/*
 * Calendar sync and booking pages against a local fake of Google's OAuth
 * token endpoint, userinfo and Calendar API (GOOGLE_OAUTH_URL,
 * GOOGLE_USERINFO_URL, GOOGLE_CALENDAR_API_URL): connecting a calendar
 * through the signed-state callback, booking pages, slots with busy times
 * removed, booking (contact found or created, Meeting + calendar event,
 * meeting.booked), double-booking refused, cancel and reschedule by token,
 * round robin, the app-side cancel reaching the calendar, permissions and
 * tenant isolation.
 */

const ACCOUNT = "owner.calendar@acme.test";
const H = 3_600_000;

type FakeEvent = { id: string; calendarId: string; body: Record<string, unknown>; query: string; deleted: boolean; patches: Record<string, unknown>[] };

function fakeGoogle() {
  const state = {
    busy: [] as { start: string; end: string }[],
    freeBusyRequests: [] as { items: { id: string }[] }[],
    events: [] as FakeEvent[],
    tokenRequests: [] as URLSearchParams[],
    issued: new Set<string>(["access-1"]),
    refuseRefresh: false,
  };
  let n = 1;
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const send = (status: number, payload?: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(payload === undefined ? "" : JSON.stringify(payload));
      };
      const url = new URL(req.url ?? "/", "http://fake");
      if (url.pathname === "/token" && req.method === "POST") {
        const form = new URLSearchParams(raw);
        state.tokenRequests.push(form);
        if (form.get("client_id") !== GOOGLE_TEST_CLIENT.id || form.get("client_secret") !== GOOGLE_TEST_CLIENT.secret) return send(401, { error: "invalid_client" });
        if (form.get("grant_type") === "authorization_code") {
          if (form.get("code") !== "good-code") return send(400, { error: "invalid_grant", error_description: "Bad code" });
          return send(200, { access_token: "access-1", refresh_token: "refresh-1", expires_in: 3600, scope: "openid email https://www.googleapis.com/auth/calendar.events" });
        }
        if (form.get("grant_type") === "refresh_token") {
          if (state.refuseRefresh || form.get("refresh_token") !== "refresh-1") return send(400, { error: "invalid_grant", error_description: "Token has been expired or revoked." });
          n += 1;
          state.issued.add(`access-${n}`);
          return send(200, { access_token: `access-${n}`, expires_in: 3600 });
        }
        return send(400, { error: "unsupported_grant_type" });
      }
      const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
      if (!state.issued.has(token)) return send(401, { error: { message: "Invalid Credentials" } });
      if (url.pathname === "/v1/userinfo") return send(200, { email: ACCOUNT, email_verified: true });
      if (url.pathname === "/calendar/v3/users/me/calendarList") {
        return send(200, {
          items: [
            { id: ACCOUNT, summary: ACCOUNT, primary: true, accessRole: "owner" },
            { id: "team@group.calendar.google.com", summary: "Team", accessRole: "reader" },
          ],
        });
      }
      if (url.pathname === "/calendar/v3/freeBusy" && req.method === "POST") {
        const body = JSON.parse(raw) as { items: { id: string }[] };
        state.freeBusyRequests.push(body);
        return send(200, { calendars: Object.fromEntries(body.items.map((i, idx) => [i.id, { busy: idx === 0 ? state.busy : [] }])) });
      }
      const ev = /^\/calendar\/v3\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/.exec(url.pathname);
      if (ev) {
        const calendarId = decodeURIComponent(ev[1]!);
        if (!ev[2] && req.method === "POST") {
          const id = `evt-${state.events.length + 1}`;
          const body = JSON.parse(raw) as Record<string, unknown>;
          state.events.push({ id, calendarId, body, query: url.search, deleted: false, patches: [] });
          const meet = body.conferenceData ? { hangoutLink: `https://meet.google.com/abc-${id}`, conferenceData: { entryPoints: [{ entryPointType: "video", uri: `https://meet.google.com/abc-${id}` }] } } : {};
          return send(200, { id, ...meet });
        }
        const found = state.events.find((e) => e.id === decodeURIComponent(ev[2] ?? ""));
        if (!found || found.deleted) return send(404, { error: { message: "Not Found" } });
        if (req.method === "PATCH") {
          found.patches.push(JSON.parse(raw) as Record<string, unknown>);
          return send(200, { id: found.id });
        }
        if (req.method === "DELETE") {
          found.deleted = true;
          return send(204);
        }
      }
      send(404, { error: { message: "Not found" } });
    });
  });
  return { server, state };
}

describe("Calendar sync and booking pages", () => {
  let t: TestApp;
  let fake: ReturnType<typeof fakeGoogle>;
  let owner: Agent;
  let rep: Agent;
  let viewer: Agent;
  let outsider: Agent;
  let w: string;
  let w2: string;
  let connectionId: string;
  let pageId: string;
  const tokens: Record<string, string> = {};
  const base = () => `/v1/workspaces/${w}`;
  // A day three days out, at midnight UTC.
  const D = new Date(Math.floor(Date.now() / (24 * H)) * 24 * H + 3 * 24 * H);
  const at = (hour: number, day = D) => new Date(day.getTime() + hour * H);
  const isoAt = (hour: number, day = D) => at(hour, day).toISOString();

  const startState = async (agent: Agent, query = "") => {
    const res = await agent.get(`${base()}/calendar/oauth/google/start${query}`).expect(200);
    const url = new URL(res.body.data.url as string);
    return { url, state: url.searchParams.get("state")! };
  };

  const slotsOn = async (slug: string, day = D, timezone = "UTC") =>
    (await t.http().get(`/v1/public/booking/${slug}/slots`).query({ from: day.toISOString(), to: new Date(day.getTime() + 24 * H).toISOString(), timezone }).expect(200)).body.data as {
      days: { date: string; slots: string[] }[];
    };

  const book = (slug: string, start: Date, extra: Record<string, unknown> = {}) =>
    t
      .http()
      .post(`/v1/public/booking/${slug}/book`)
      .send({ name: "Ada Lovelace", email: "ada@visitor.test", timezone: "Europe/Berlin", start: start.toISOString(), answers: { company: "Analytical Engines" }, ...extra });

  beforeAll(async () => {
    fake = fakeGoogle();
    await new Promise<void>((r) => fake.server.listen(0, "127.0.0.1", () => r()));
    const url = `http://127.0.0.1:${(fake.server.address() as AddressInfo).port}`;
    process.env.GOOGLE_OAUTH_URL = url;
    process.env.GOOGLE_USERINFO_URL = url;
    process.env.GOOGLE_CALENDAR_API_URL = url;
    process.env.BOOKING_RATE_LIMIT = "10000";
    t = await bootApp();
    owner = await signUp(t, "booking-owner@acme.test", "Olive Owner");
    w = await createWorkspace(owner, "Booking Co");
    await setPlan(t, w, "agency");
    rep = await addMember(t, owner, w, "booking-rep@acme.test", "member");
    viewer = await addMember(t, owner, w, "booking-viewer@acme.test", "viewer");
    outsider = await signUp(t, "booking-outsider@other.test", "Otto Outsider");
    w2 = await createWorkspace(outsider, "Other Co");
    await setPlan(t, w2, "agency");
  });

  afterAll(async () => {
    for (const k of ["GOOGLE_OAUTH_URL", "GOOGLE_USERINFO_URL", "GOOGLE_CALENDAR_API_URL", "BOOKING_RATE_LIMIT"]) delete process.env[k];
    await t?.close();
    await new Promise((r) => fake.server.close(r));
  });

  it("says when the installation has no Google client, and refuses to start", async () => {
    await t.app.get(PlatformSettingsService).update({ googleClientId: "", googleClientSecret: "" }, null);
    const mine = await owner.get(`${base()}/calendar/connections`).expect(200);
    expect(mine.body.data).toMatchObject({ available: { google: false, microsoft: false }, redirectUris: { google: "http://localhost:3600/api/calendar/oauth/google/callback" }, connections: [] });
    const res = await owner.get(`${base()}/calendar/oauth/google/start`).expect(503);
    expect(res.body.error.message).toMatch(/admin console/);
    await enableGoogleSignIn(t);
  });

  it("connects a Google calendar through the signed callback, only for the person who started it", async () => {
    const { url, state } = await startState(owner);
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:3600/api/calendar/oauth/google/callback");
    expect(url.searchParams.get("scope")).toContain("https://www.googleapis.com/auth/calendar.events");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");

    // Someone else's browser finishing the owner's flow connects nothing.
    const stolen = await rep.get(`/v1/calendar/oauth/google/callback?code=good-code&state=${encodeURIComponent(state)}`).expect(302);
    expect(stolen.headers.location).toMatch(new RegExp(`/w/${w}/settings/calendar\\?calendarError=.*started`));
    // A tampered state is refused.
    const tampered = await owner.get(`/v1/calendar/oauth/google/callback?code=good-code&state=${encodeURIComponent(`${state.slice(0, -2)}xx`)}`).expect(302);
    expect(tampered.headers.location).toMatch(/calendarError=.*expired/);
    const denied = await owner.get(`/v1/calendar/oauth/google/callback?error=access_denied&state=${encodeURIComponent(state)}`).expect(302);
    expect(denied.headers.location).toMatch(/calendarError=Google%20Calendar%20access%20was%20not%20granted/);
    expect(await t.prisma.db.calendarConnection.count({ where: { workspaceId: w } })).toBe(0);

    const ok = await owner.get(`/v1/calendar/oauth/google/callback?code=good-code&state=${encodeURIComponent(state)}`).expect(302);
    expect(ok.headers.location).toMatch(new RegExp(`^http://localhost:3600/w/${w}/settings/calendar\\?calendar=connected&connection=`));
    expect(fake.state.tokenRequests.at(-1)?.get("redirect_uri")).toBe("http://localhost:3600/api/calendar/oauth/google/callback");

    const mine = await owner.get(`${base()}/calendar/connections`).expect(200);
    expect(mine.body.data.available.google).toBe(true);
    expect(mine.body.data.connections).toEqual([expect.objectContaining({ provider: "google", email: ACCOUNT, calendarId: ACCOUNT, busyCalendarIds: [], status: "connected" })]);
    expect(JSON.stringify(mine.body)).not.toMatch(/refresh-1|access-1/);
    connectionId = mine.body.data.connections[0].id;
    const row = await t.prisma.db.calendarConnection.findFirstOrThrow({ where: { id: connectionId, workspaceId: w } });
    expect(row.secretSealed).toBeTruthy();
    expect(row.secretSealed).not.toContain("refresh-1");

    // Connecting again (from the Meetings page) updates the same connection and lands back there.
    const again = await startState(owner, "?return=meetings");
    const back = await owner.get(`/v1/calendar/oauth/google/callback?code=good-code&state=${encodeURIComponent(again.state)}`).expect(302);
    expect(back.headers.location).toBe(`http://localhost:3600/w/${w}/meetings?calendar=connected&connection=${connectionId}`);
    expect(await t.prisma.db.calendarConnection.count({ where: { workspaceId: w } })).toBe(1);
  });

  it("lists the account's calendars and saves the write and busy calendars; nobody else can", async () => {
    const cals = await owner.get(`${base()}/calendar/connections/${connectionId}/calendars`).expect(200);
    expect(cals.body.data).toEqual([
      { id: ACCOUNT, name: ACCOUNT, primary: true, writable: true },
      { id: "team@group.calendar.google.com", name: "Team", primary: false, writable: false },
    ]);
    const saved = await owner.put(`${base()}/calendar/connections/${connectionId}`).send({ calendarId: ACCOUNT, busyCalendarIds: [ACCOUNT, "team@group.calendar.google.com"] }).expect(200);
    expect(saved.body.data.busyCalendarIds).toEqual([ACCOUNT, "team@group.calendar.google.com"]);
    // Personal: a teammate cannot read or change it, nor can another workspace.
    await rep.get(`${base()}/calendar/connections/${connectionId}/calendars`).expect(404);
    await rep.put(`${base()}/calendar/connections/${connectionId}`).send({ calendarId: "x", busyCalendarIds: [] }).expect(404);
    await rep.delete(`${base()}/calendar/connections/${connectionId}`).expect(404);
    expect((await rep.get(`${base()}/calendar/connections`).expect(200)).body.data.connections).toEqual([]);
    await outsider.get(`/v1/workspaces/${w2}/calendar/connections/${connectionId}/calendars`).expect(404);
    await outsider.get(`${base()}/calendar/connections`).expect(404);
  });

  it("creates booking pages with booking.manage only, validating slug and hosts", async () => {
    const input = {
      title: "Intro call",
      slug: "acme-intro",
      hostUserIds: [owner.userId],
      availability: { timezone: "UTC", hours: [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, from: "09:00", to: "17:00" })) },
      minNoticeMinutes: 0,
      bufferAfterMinutes: 0,
      locationType: "google_meet",
      questions: [
        { id: "company", label: "Company", type: "text", required: true },
        { id: "phone", label: "Phone", type: "phone" },
        { id: "calls", label: "You may call me about this", type: "consent" },
      ],
      confirmationMessage: "Talk soon!",
    };
    await viewer.post(`${base()}/booking-pages`).send(input).expect(403);
    await viewer.get(`${base()}/booking-pages`).expect(403);
    await rep.post(`${base()}/booking-pages`).send({ ...input, slug: "manage" }).expect(400);
    await rep.post(`${base()}/booking-pages`).send({ ...input, hostUserIds: [outsider.userId] }).expect(400);
    const res = await rep.post(`${base()}/booking-pages`).send(input).expect(201);
    pageId = res.body.data.id;
    expect(res.body.data).toMatchObject({ slug: "acme-intro", url: "http://localhost:3600/book/acme-intro", hosts: [{ userId: owner.userId, calendar: { provider: "google", status: "connected" } }], upcomingBookings: 0 });
    // Slugs are unique across the installation.
    expect((await outsider.post(`/v1/workspaces/${w2}/booking-pages`).send({ ...input, hostUserIds: [outsider.userId] }).expect(409)).body.error.message).toMatch(/taken/);
    // Another workspace cannot see or change it.
    await outsider.get(`/v1/workspaces/${w2}/booking-pages/${pageId}`).expect(404);
    await outsider.patch(`/v1/workspaces/${w2}/booking-pages/${pageId}`).send({ title: "Mine" }).expect(404);
    const patched = await rep.patch(`${base()}/booking-pages/${pageId}`).send({ description: "Thirty minutes to get to know each other." }).expect(200);
    expect(patched.body.data).toMatchObject({ description: "Thirty minutes to get to know each other.", durationMinutes: 30, minNoticeMinutes: 0 });
  });

  it("shows the public page and its free slots, with calendar busy times removed", async () => {
    const page = await t.http().get("/v1/public/booking/acme-intro").expect(200);
    expect(page.body.data).toMatchObject({ title: "Intro call", durationMinutes: 30, timezone: "UTC", workspaceName: "Booking Co", hostName: "Olive Owner", locationType: "google_meet" });
    await t.http().get("/v1/public/booking/nope-nope").expect(404);

    fake.state.busy = [{ start: isoAt(10), end: isoAt(11) }];
    const { days } = await slotsOn("acme-intro");
    const slots = days.flatMap((d) => d.slots);
    expect(slots).toContain(isoAt(9));
    expect(slots).toContain(isoAt(9.5));
    expect(slots).not.toContain(isoAt(10));
    expect(slots).not.toContain(isoAt(10.5));
    expect(slots).toContain(isoAt(11));
    expect(slots).not.toContain(isoAt(17));
    // Both chosen calendars were asked.
    expect(fake.state.freeBusyRequests.at(-1)?.items.map((i) => i.id)).toEqual([ACCOUNT, "team@group.calendar.google.com"]);
    // Grouped into the visitor's own days: 09:00–17:00 UTC is one day in Berlin, and runs past midnight in Auckland (UTC+13).
    expect((await slotsOn("acme-intro", D, "Europe/Berlin")).days.map((d) => d.date)).toEqual([D.toISOString().slice(0, 10)]);
    expect((await slotsOn("acme-intro", D, "Pacific/Auckland")).days.map((d) => d.date)).toEqual([D.toISOString().slice(0, 10), new Date(D.getTime() + 24 * H).toISOString().slice(0, 10)]);
  });

  it("books: finds or creates the contact, writes the meeting and the calendar event, and tells everyone", async () => {
    await book("acme-intro", at(9), { answers: {} }).expect(400); // the required question
    await book("acme-intro", at(10)).expect(409); // busy on the calendar
    await book("acme-intro", new Date(at(9).getTime() + 5 * 60_000)).expect(409); // not a slot
    await book("acme-intro", at(9), { consent: true }).expect(400); // consent to be called needs a phone

    const res = await book("acme-intro", at(9), { phone: "+1 415 555 0123", consent: true }).expect(201);
    const b = res.body.data;
    expect(b).toMatchObject({ title: "Intro call", startsAt: isoAt(9), endsAt: isoAt(9.5), status: "scheduled", attendeeEmail: "ada@visitor.test", hostName: "Olive Owner", confirmationMessage: "Talk soon!", conferenceUrl: "https://meet.google.com/abc-evt-1" });
    tokens.ada = b.manageToken;
    expect(tokens.ada).toMatch(/^[A-Za-z0-9_-]{30,}$/);

    const m = await t.prisma.db.meeting.findFirstOrThrow({ where: { workspaceId: w, id: b.id } });
    expect(m).toMatchObject({ source: "booking", bookingPageId: pageId, ownerId: owner.userId, attendeeName: "Ada Lovelace", timezone: "Europe/Berlin", externalEventId: "evt-1", calendarConnectionId: connectionId, location: "https://meet.google.com/abc-evt-1" });
    expect(m.answers).toEqual([{ question: "Company", answer: "Analytical Engines" }]);
    const contact = await t.prisma.db.contact.findFirstOrThrow({ where: { workspaceId: w, id: m.contactId! } });
    expect(contact).toMatchObject({ email: "ada@visitor.test", phone: "+14155550123", fullName: "Ada Lovelace", ownerId: owner.userId, consentStatus: "granted", consentSource: "Booking page: Intro call" });
    expect(await t.prisma.db.contactSource.count({ where: { workspaceId: w, contactId: contact.id, source: "booking" } })).toBe(1);
    expect(await t.prisma.db.consentEvent.count({ where: { workspaceId: w, contactId: contact.id, status: "granted" } })).toBe(1);
    const event = await t.prisma.db.domainEvent.findFirstOrThrow({ where: { workspaceId: w, type: "meeting.booked", subjectId: m.id } });
    expect(event.payload).toEqual({ contactId: contact.id, dealId: null, startsAt: isoAt(9) });
    expect(await t.prisma.db.activity.count({ where: { workspaceId: w, contactId: contact.id, type: "meeting.booked" } })).toBe(1);
    expect(await t.prisma.db.notification.count({ where: { workspaceId: w, userId: owner.userId, type: "meeting.booked" } })).toBe(1);

    const sent = fake.state.events[0]!;
    expect(sent.calendarId).toBe(ACCOUNT);
    expect(sent.query).toContain("sendUpdates=all");
    expect(sent.query).toContain("conferenceDataVersion=1");
    expect(sent.body).toMatchObject({ attendees: [{ email: "ada@visitor.test", displayName: "Ada Lovelace" }], start: { dateTime: isoAt(9), timeZone: "Europe/Berlin" }, conferenceData: { createRequest: { requestId: m.id } } });

    const mail = t.mail.outbox.filter((x) => x.to === "ada@visitor.test" && x.template === "booking_booked");
    expect(mail).toHaveLength(1);
    expect(mail[0]!.text).toContain(`/book/manage/${tokens.ada}`);
    expect(mail[0]!.text).toContain(`/api/public/booking/manage/${tokens.ada}/ics`);

    // The same slot again: refused, and gone from the slots.
    await book("acme-intro", at(9), { email: "someone@else.test" }).expect(409);
    expect((await slotsOn("acme-intro")).days.flatMap((d) => d.slots)).not.toContain(isoAt(9));
  });

  it("matches an existing contact instead of creating another", async () => {
    const bob = (await owner.post(`${base()}/contacts`).send({ fullName: "Bob Known", email: "bob@visitor.test" }).expect(201)).body.data.id as string;
    const before = await t.prisma.db.contact.count({ where: { workspaceId: w } });
    const res = await book("acme-intro", at(11), { name: "Bobby", email: "BOB@visitor.test" }).expect(201);
    tokens.bob = res.body.data.manageToken;
    const m = await t.prisma.db.meeting.findFirstOrThrow({ where: { workspaceId: w, id: res.body.data.id } });
    expect(m.contactId).toBe(bob);
    expect(await t.prisma.db.contact.count({ where: { workspaceId: w } })).toBe(before);
    // No consent question ticked: consent untouched.
    expect((await t.prisma.db.contact.findFirstOrThrow({ where: { workspaceId: w, id: bob } })).consentStatus).toBe("unknown");
  });

  it("lets the attendee see, download, reschedule and cancel by token", async () => {
    const got = await t.http().get(`/v1/public/booking/manage/${tokens.ada}`).expect(200);
    expect(got.body.data).toMatchObject({ status: "scheduled", startsAt: isoAt(9), page: { slug: "acme-intro", durationMinutes: 30 } });
    await t.http().get("/v1/public/booking/manage/not-a-real-token-at-all-000").expect(404);
    const ics = await t.http().get(`/v1/public/booking/manage/${tokens.ada}/ics`).expect(200);
    expect(ics.headers["content-type"]).toMatch(/text\/calendar/);
    expect(ics.text).toContain("BEGIN:VEVENT");
    expect(ics.text).toContain(`DTSTART:${isoAt(9).replace(/[-:]/g, "").replace(".000", "")}`);

    // Busy on the calendar, or taken by Bob: refused.
    await t.http().post(`/v1/public/booking/manage/${tokens.ada}/reschedule`).send({ start: isoAt(10) }).expect(409);
    await t.http().post(`/v1/public/booking/manage/${tokens.ada}/reschedule`).send({ start: isoAt(11) }).expect(409);
    const moved = await t.http().post(`/v1/public/booking/manage/${tokens.ada}/reschedule`).send({ start: isoAt(13) }).expect(200);
    expect(moved.body.data).toMatchObject({ startsAt: isoAt(13), endsAt: isoAt(13.5), status: "scheduled" });
    expect(fake.state.events[0]!.patches.at(-1)).toMatchObject({ start: { dateTime: isoAt(13) }, end: { dateTime: isoAt(13.5) } });
    expect(t.mail.outbox.some((x) => x.to === "ada@visitor.test" && x.template === "booking_rescheduled")).toBe(true);
    // Moving it to a time next to its own old slot works (it does not block itself).
    await t.http().post(`/v1/public/booking/manage/${tokens.ada}/reschedule`).send({ start: isoAt(13.5) }).expect(200);

    const canceled = await t.http().post(`/v1/public/booking/manage/${tokens.ada}/cancel`).send({ reason: "Something came up" }).expect(200);
    expect(canceled.body.data).toMatchObject({ status: "canceled", cancelReason: "Something came up" });
    expect(fake.state.events[0]!.deleted).toBe(true);
    const row = await t.prisma.db.meeting.findFirstOrThrow({ where: { workspaceId: w, manageToken: tokens.ada } });
    expect(row.canceledAt).not.toBeNull();
    expect(await t.prisma.db.notification.count({ where: { workspaceId: w, userId: owner.userId, type: "meeting.canceled" } })).toBe(1);
    // Again: a no-op. Rescheduling a canceled meeting: refused.
    await t.http().post(`/v1/public/booking/manage/${tokens.ada}/cancel`).send({}).expect(200);
    await t.http().post(`/v1/public/booking/manage/${tokens.ada}/reschedule`).send({ start: isoAt(14) }).expect(409);
  });

  it("cancels the calendar event when the meeting is canceled in the app, and lists booked meetings with their details", async () => {
    const bobMeeting = await t.prisma.db.meeting.findFirstOrThrow({ where: { workspaceId: w, manageToken: tokens.bob } });
    const list = await owner.get(`${base()}/meetings`).query({ from: D.toISOString() }).expect(200);
    const row = list.body.data.find((x: { id: string }) => x.id === bobMeeting.id);
    expect(row).toMatchObject({ source: "booking", attendeeEmail: "bob@visitor.test", conferenceUrl: "https://meet.google.com/abc-evt-2", bookingPage: { id: pageId, title: "Intro call", slug: "acme-intro" } });
    expect(row.manageToken).toBeUndefined();

    await owner.patch(`${base()}/meetings/${bobMeeting.id}`).send({ status: "canceled" }).expect(200);
    expect(fake.state.events.find((e) => e.id === "evt-2")?.deleted).toBe(true);
    const after = await t.prisma.db.meeting.findFirstOrThrow({ where: { workspaceId: w, id: bobMeeting.id } });
    expect(after).toMatchObject({ status: "canceled", externalEventId: null });
    expect(after.canceledAt).not.toBeNull();
  });

  it("round robin gives each booking to the next free host; a host without a calendar still gets booked", async () => {
    const res = await rep
      .post(`${base()}/booking-pages`)
      .send({ title: "Demo", slug: "acme-demo", assignment: "round_robin", hostUserIds: [owner.userId, rep.userId], availability: { timezone: "UTC", hours: [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, from: "09:00", to: "12:00" })) }, minNoticeMinutes: 0 })
      .expect(201);
    expect(res.body.data.hosts[1]).toMatchObject({ userId: rep.userId, calendar: null });
    const day = new Date(D.getTime() + 24 * H);
    fake.state.busy = [];
    const first = await book("acme-demo", at(9, day), { email: "one@visitor.test" }).expect(201);
    const second = await book("acme-demo", at(9, day), { email: "two@visitor.test" }).expect(201);
    await book("acme-demo", at(9, day), { email: "three@visitor.test" }).expect(409);
    const [m1, m2] = await Promise.all([first, second].map((r) => t.prisma.db.meeting.findFirstOrThrow({ where: { workspaceId: w, id: r.body.data.id } })));
    expect(m1!.ownerId).toBe(owner.userId);
    expect(m1!.externalEventId).toBeTruthy();
    expect(m2!.ownerId).toBe(rep.userId);
    expect(m2!.externalEventId).toBeNull();
    // The rotation goes on from the second host: the next free slot goes to the owner again.
    const third = await book("acme-demo", at(10, day), { email: "four@visitor.test" }).expect(201);
    expect((await t.prisma.db.meeting.findFirstOrThrow({ where: { workspaceId: w, id: third.body.data.id } })).ownerId).toBe(owner.userId);
    // Two people pressing Book at once for one single-host slot: one meeting.
    const race = await Promise.all([book("acme-intro", at(15), { email: "r1@visitor.test" }), book("acme-intro", at(15), { email: "r2@visitor.test" })]);
    expect(race.map((r) => r.status).sort()).toEqual([201, 409]);
  });

  it("sends the reminder only for a meeting still at the time it was made for", async () => {
    const svc = t.app.get(BookingService);
    const m = await t.prisma.db.meeting.findFirstOrThrow({ where: { workspaceId: w, attendeeEmail: "one@visitor.test" } });
    expect(await svc.remind(w, m.id, new Date(m.startsAt.getTime() - H).toISOString())).toBe(false);
    expect(await svc.remind(w, m.id, m.startsAt.toISOString())).toBe(true);
    expect(t.mail.outbox.some((x) => x.to === "one@visitor.test" && x.template === "booking_reminder")).toBe(true);
  });

  it("flags a revoked calendar, keeps booking without it, and disconnects", async () => {
    await t.prisma.db.calendarConnection.update({ where: { id: connectionId, workspaceId: w }, data: { accessExpiresAt: new Date(Date.now() - 1000) } });
    fake.state.refuseRefresh = true;
    // The slots still show (the broken calendar is skipped), and the owner is told to reconnect.
    const { days } = await slotsOn("acme-intro", new Date(D.getTime() + 2 * 24 * H));
    expect(days.flatMap((d) => d.slots).length).toBeGreaterThan(0);
    const row = await t.prisma.db.calendarConnection.findFirstOrThrow({ where: { id: connectionId, workspaceId: w } });
    expect(row.status).toBe("error");
    expect(await t.prisma.db.notification.count({ where: { workspaceId: w, userId: owner.userId, type: "calendar.disconnected" } })).toBe(1);
    const booked = await book("acme-intro", at(9, new Date(D.getTime() + 2 * 24 * H)), { email: "late@visitor.test" }).expect(201);
    expect((await t.prisma.db.meeting.findFirstOrThrow({ where: { workspaceId: w, id: booked.body.data.id } })).externalEventId).toBeNull();
    expect((await t.app.get(CalendarService).checkHealth()).checked).toBe(0);

    await owner.delete(`${base()}/calendar/connections/${connectionId}`).expect(200);
    expect((await owner.get(`${base()}/calendar/connections`).expect(200)).body.data.connections).toEqual([]);
    const gone = await t.prisma.db.calendarConnection.findFirstOrThrow({ where: { id: connectionId, workspaceId: w } });
    expect(gone).toMatchObject({ status: "disconnected", secretSealed: null, accessSealed: null });
  });

  it("hides inactive and deleted pages, frees a deleted page's slug, and rate limits public writes", async () => {
    await rep.patch(`${base()}/booking-pages/${pageId}`).send({ active: false }).expect(200);
    await t.http().get("/v1/public/booking/acme-intro").expect(404);
    await book("acme-intro", at(16)).expect(404);
    await rep.delete(`${base()}/booking-pages/${pageId}`).expect(200);
    expect((await rep.get(`${base()}/booking-pages`).expect(200)).body.data.map((p: { slug: string }) => p.slug)).toEqual(["acme-demo"]);
    await outsider
      .post(`/v1/workspaces/${w2}/booking-pages`)
      .send({ title: "Theirs", slug: "acme-intro", hostUserIds: [outsider.userId], availability: { timezone: "UTC", hours: [{ day: 1, from: "09:00", to: "10:00" }] } })
      .expect(201);

    process.env.BOOKING_RATE_LIMIT = "2";
    try {
      const codes: number[] = [];
      for (let i = 0; i < 4; i++) codes.push((await t.http().post("/v1/public/booking/manage/nope-nope-nope-nope-nope/cancel").send({})).status);
      // Earlier cancels in this minute count too; past the limit, every answer is 429 before the token is even looked up.
      expect(codes.every((c) => c === 404 || c === 429)).toBe(true);
      expect(codes.at(-1)).toBe(429);
    } finally {
      process.env.BOOKING_RATE_LIMIT = "10000";
    }
  });
});
