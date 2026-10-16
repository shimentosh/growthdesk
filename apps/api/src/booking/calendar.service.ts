import { Inject, Injectable, Logger } from "@nestjs/common";
import { randomBytes } from "node:crypto";
import { CALENDAR_PROVIDER_LABELS, CALENDAR_PROVIDERS, normalizeEmail, type BusyInterval, type CalendarProvider } from "@growthdesk/shared";
import type { z } from "zod";
import type { CalendarSettingsInput } from "@growthdesk/shared";
import { APP_CONFIG, type AppConfig } from "../config/config.js";
import { PrismaService } from "../prisma/prisma.service.js";
import type { CalendarConnection } from "../generated/prisma/client.js";
import { AuditService } from "../core/audit.service.js";
import { PlatformSettingsService } from "../core/platform-settings.service.js";
import { NotificationsService } from "../notifications/notifications.service.js";
import { derivedKey, hmac, open, safeEqual, seal } from "../common/crypto.js";
import { me, ws, type RequestContext } from "../common/context.js";
import { badRequest, isApiError, notFound, unavailable } from "../common/errors.js";
import { authorizeUrl, CALENDAR_API, CALENDAR_SCOPES, CalendarApiError, googleAccountEmail, microsoftIdTokenEmail, tokenRequest, tokenUrl, type CreatedEvent, type NewEvent } from "./calendar-providers.js";

const STATE_TTL_MS = 10 * 60_000;
const isProvider = (p: string): p is CalendarProvider => (CALENDAR_PROVIDERS as readonly string[]).includes(p);
const LABEL = CALENDAR_PROVIDER_LABELS;

/** Where the browser lands after the provider: the personal calendar settings, or the Meetings page it started from. */
const RETURN_TO = { settings: "/settings/calendar", meetings: "/meetings" } as const;
export type CalendarReturn = keyof typeof RETURN_TO;

type State = { w: string; u: string; p: CalendarProvider; exp: number; n: string; r: CalendarReturn };

/** A failure to show the person (as ?calendarError=). */
class FlowError extends Error {}

export const connectionDto = (c: CalendarConnection) => ({
  id: c.id,
  provider: c.provider as CalendarProvider,
  email: c.email,
  calendarId: c.calendarId,
  busyCalendarIds: Array.isArray(c.busyCalendarIds) ? (c.busyCalendarIds as string[]) : [],
  status: c.status,
  lastError: c.lastError,
  lastSyncedAt: c.lastSyncedAt,
  createdAt: c.createdAt,
});

/*
 * A teammate's own Google or Microsoft calendar, for booking pages: its busy
 * times hide slots, and booked meetings are written to it with the attendee
 * invited. Personal — anyone in the workspace connects their own; nobody can
 * connect, read or change someone else's.
 *
 * Sign-in reuses the installation's Google / Microsoft OAuth clients (the
 * ones mailbox sign-in uses, platform admin → Settings → Google and Microsoft
 * sign-in) with calendar scopes. The admin must add this redirect URI to each
 * OAuth app: ${PUBLIC_APP_URL}/api/calendar/oauth/<google|microsoft>/callback.
 *
 * The state is HMAC-signed (key derived for "calendar-oauth"), names the
 * workspace, the person, the provider and the page to return to, and lives
 * ten minutes; the callback also requires the browser's own session to be
 * that person (as MailboxOAuthService does). The refresh token is sealed into
 * `secretSealed`, the access token and its expiry into `accessSealed` /
 * `accessExpiresAt`, refreshed within a minute of expiry.
 *
 * Events are written to the person's first connected calendar (the oldest
 * connection); busy times are read from every connection they have.
 */
@Injectable()
export class CalendarService {
  private readonly log = new Logger("calendar");

  constructor(
    private readonly prisma: PrismaService,
    private readonly platform: PlatformSettingsService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  private base() {
    return this.config.PUBLIC_APP_URL.replace(/\/+$/, "");
  }

  redirectUri(provider: CalendarProvider) {
    return `${this.base()}/api/calendar/oauth/${provider}/callback`;
  }

  private async client(provider: CalendarProvider) {
    const client = await this.platform.oauthClient(provider);
    if (!client) throw unavailable(`${LABEL[provider]} sign-in is not configured on this installation. A platform admin adds the ${provider === "google" ? "Google" : "Microsoft"} OAuth client in the admin console under Settings → Google and Microsoft sign-in.`);
    return client;
  }

  async available(): Promise<Record<CalendarProvider, boolean>> {
    const [google, microsoft] = await Promise.all([this.platform.oauthClient("google"), this.platform.oauthClient("microsoft")]);
    return { google: Boolean(google), microsoft: Boolean(microsoft) };
  }

  /** The person's own connections, and which providers this installation can connect. */
  async mine(ctx: RequestContext) {
    const rows = await this.prisma.db.calendarConnection.findMany({ where: { workspaceId: ws(ctx).id, userId: me(ctx).userId, deletedAt: null }, orderBy: { createdAt: "asc" } });
    return {
      available: await this.available(),
      redirectUris: { google: this.redirectUri("google"), microsoft: this.redirectUri("microsoft") },
      connections: rows.map(connectionDto),
    };
  }

  // ─── OAuth ────────────────────────────────────────────────────────────────

  signState(state: State): string {
    const body = Buffer.from(JSON.stringify(state), "utf8").toString("base64url");
    return `${body}.${hmac(derivedKey("calendar-oauth"), body, "base64url")}`;
  }

  readState(raw: string | undefined): State | null {
    const [body, sig, extra] = String(raw ?? "").split(".");
    if (!body || !sig || extra !== undefined) return null;
    if (!safeEqual(sig, hmac(derivedKey("calendar-oauth"), body, "base64url"))) return null;
    try {
      const s = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as State;
      if (!s || typeof s.w !== "string" || typeof s.u !== "string" || !isProvider(s.p) || typeof s.exp !== "number" || !(s.r in RETURN_TO)) return null;
      if (s.exp < Date.now()) return null;
      return s;
    } catch {
      return null;
    }
  }

  /** The workspace id in a state whose signature or expiry failed: only a well-formed UUID, for choosing where to redirect. */
  private peekWorkspace(raw: string | undefined): string | null {
    try {
      const w = (JSON.parse(Buffer.from(String(raw ?? "").split(".")[0] ?? "", "base64url").toString("utf8")) as { w?: unknown })?.w;
      return typeof w === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(w) ? w : null;
    } catch {
      return null;
    }
  }

  async start(ctx: RequestContext, provider: string, returnTo: string | undefined) {
    if (!isProvider(provider)) throw notFound("That calendar provider");
    const client = await this.client(provider);
    const r: CalendarReturn = returnTo === "meetings" ? "meetings" : "settings";
    const state = this.signState({ w: ws(ctx).id, u: me(ctx).userId, p: provider, exp: Date.now() + STATE_TTL_MS, n: randomBytes(9).toString("base64url"), r });
    const params = new URLSearchParams({
      client_id: client.id,
      redirect_uri: this.redirectUri(provider),
      response_type: "code",
      scope: CALENDAR_SCOPES[provider],
      state,
      ...(provider === "google" ? { access_type: "offline", prompt: "consent", include_granted_scopes: "true" } : { response_mode: "query", prompt: "select_account" }),
    });
    return { url: `${authorizeUrl(provider, await this.platform.microsoftTenant())}?${params.toString()}` };
  }

  /** Handles the provider's redirect; returns where to send the browser next. */
  async callback(provider: string, query: { code?: string; state?: string; error?: string; error_description?: string }, ctx: RequestContext): Promise<string> {
    const state = isProvider(provider) ? this.readState(query.state) : null;
    const workspaceId = state?.w ?? this.peekWorkspace(query.state);
    const page = workspaceId ? `${this.base()}/w/${workspaceId}${RETURN_TO[state?.r ?? "settings"]}` : `${this.base()}/`;
    const fail = (message: string) => `${page}?calendarError=${encodeURIComponent(message.slice(0, 300))}`;
    if (!isProvider(provider)) return fail("Unknown calendar provider.");
    if (!state || state.p !== provider) return fail("That sign-in link has expired or is not valid. Start connecting the calendar again.");
    try {
      const row = await this.complete(provider, state, query, ctx);
      return `${page}?calendar=connected&connection=${encodeURIComponent(row.id)}`;
    } catch (e) {
      if (e instanceof FlowError || isApiError(e)) return fail(e.message);
      if (e instanceof CalendarApiError) return fail(`${LABEL[provider]} refused: ${e.message}`);
      this.log.error(`${provider} calendar callback failed: ${e instanceof Error ? e.stack : String(e)}`);
      return fail(`${LABEL[provider]} sign-in could not be completed. Try again.`);
    }
  }

  private async complete(provider: CalendarProvider, state: State, query: { code?: string; error?: string; error_description?: string }, ctx: RequestContext): Promise<CalendarConnection> {
    if (query.error) throw new FlowError(query.error === "access_denied" ? `${LABEL[provider]} access was not granted.` : `${LABEL[provider]} said: ${query.error_description || query.error}`);
    if (!query.code) throw new FlowError(`${LABEL[provider]} did not return an authorisation code.`);
    // The browser finishing the flow must be the person who started it.
    if (!ctx.identity || ctx.identity.userId !== state.u) throw new FlowError("Sign in as the person who started connecting this calendar, then try again.");
    const membership = await this.prisma.db.membership.findUnique({ where: { workspaceId_userId: { workspaceId: state.w, userId: state.u } }, include: { workspace: true } });
    if (!membership) throw new FlowError("You are no longer a member of that workspace.");
    if (membership.workspace.status !== "active") throw new FlowError("This workspace is suspended.");

    const client = await this.client(provider);
    const tenant = await this.platform.microsoftTenant();
    const tokens = await tokenRequest(tokenUrl(provider, tenant), {
      client_id: client.id,
      client_secret: client.secret,
      code: query.code,
      redirect_uri: this.redirectUri(provider),
      grant_type: "authorization_code",
      ...(provider === "microsoft" ? { scope: CALENDAR_SCOPES.microsoft } : {}),
    }).catch((e: unknown) => {
      throw new FlowError(`${LABEL[provider]} refused the sign-in: ${e instanceof Error ? e.message : String(e)}`);
    });
    let raw: string | null;
    if (provider === "google") {
      const info = await googleAccountEmail(tokens.access_token).catch(() => ({ email: null, verified: true }));
      if (!info.verified) throw new FlowError("That Google account's address is not verified.");
      raw = info.email;
    } else raw = microsoftIdTokenEmail(tokens.id_token);
    const email = normalizeEmail(raw);
    if (!email) throw new FlowError(`${LABEL[provider]} did not tell us the account's email address.`);
    if (!tokens.refresh_token) throw new FlowError(`${LABEL[provider]} did not grant offline access. Remove Growthdesk from the account's connected apps and connect again.`);
    // Prove calendar access before storing anything (a sign-in without the calendar scopes ticked fails here).
    const calendars = await CALENDAR_API[provider].calendars(tokens.access_token).catch((e: unknown) => {
      throw new FlowError(`${LABEL[provider]} accepted the sign-in, but its calendar could not be read: ${e instanceof Error ? e.message : String(e)}. Make sure calendar access is allowed.`);
    });

    const existing = await this.prisma.db.calendarConnection.findFirst({ where: { workspaceId: state.w, userId: state.u, provider, email }, orderBy: { createdAt: "asc" } });
    const data = {
      status: "connected" as const,
      lastError: "",
      secretSealed: seal(tokens.refresh_token),
      accessSealed: seal(tokens.access_token),
      accessExpiresAt: new Date(Date.now() + (tokens.expires_in ?? 3600) * 1000),
      scope: (tokens.scope ?? CALENDAR_SCOPES[provider]).slice(0, 1000),
      lastSyncedAt: new Date(),
      deletedAt: null,
    };
    const primary = calendars.find((c) => c.primary)?.id ?? "primary";
    const row = existing
      ? await this.prisma.db.calendarConnection.update({ where: { id: existing.id, workspaceId: state.w }, data: { ...data, ...(existing.deletedAt ? { calendarId: primary, busyCalendarIds: [] } : {}) } })
      : await this.prisma.db.calendarConnection.create({ data: { workspaceId: state.w, userId: state.u, provider, email, calendarId: primary, ...data } });
    await this.audit.record(ctx, { workspaceId: state.w, action: existing && !existing.deletedAt ? "calendar.reconnected" : "calendar.connected", targetType: "calendar_connection", targetId: row.id, metadata: { email, provider } });
    return row;
  }

  // ─── The person's settings ────────────────────────────────────────────────

  private async own(ctx: RequestContext, id: string) {
    const row = await this.prisma.db.calendarConnection.findFirst({ where: { id, workspaceId: ws(ctx).id, userId: me(ctx).userId, deletedAt: null } });
    if (!row) throw notFound("That calendar connection");
    return row;
  }

  /** The account's calendars, to choose the write calendar and the busy ones from. */
  async calendars(ctx: RequestContext, id: string) {
    const row = await this.own(ctx, id);
    try {
      return await CALENDAR_API[row.provider as CalendarProvider].calendars(await this.accessToken(row));
    } catch (e) {
      if (e instanceof CalendarApiError) throw badRequest(`${LABEL[row.provider as CalendarProvider]} could not list the calendars: ${e.message}`);
      throw e;
    }
  }

  async update(ctx: RequestContext, id: string, input: z.infer<typeof CalendarSettingsInput>) {
    const row = await this.own(ctx, id);
    const updated = await this.prisma.db.calendarConnection.update({
      where: { id: row.id, workspaceId: row.workspaceId },
      data: { calendarId: input.calendarId, busyCalendarIds: [...new Set(input.busyCalendarIds)] },
    });
    return connectionDto(updated);
  }

  async disconnect(ctx: RequestContext, id: string) {
    const row = await this.own(ctx, id);
    await this.prisma.db.calendarConnection.update({
      where: { id: row.id, workspaceId: row.workspaceId },
      data: { deletedAt: new Date(), status: "disconnected", secretSealed: null, accessSealed: null, accessExpiresAt: null },
    });
    await this.audit.record(ctx, { action: "calendar.disconnected", targetType: "calendar_connection", targetId: row.id, metadata: { email: row.email, provider: row.provider } });
  }

  // ─── Tokens ───────────────────────────────────────────────────────────────

  /** A valid access token, refreshing and persisting it when it is within a minute of expiry. A refused refresh marks the connection as needing a reconnect. */
  async accessToken(row: CalendarConnection): Promise<string> {
    const current = open(row.accessSealed);
    if (current && row.accessExpiresAt && row.accessExpiresAt.getTime() - Date.now() > 60_000) return current;
    const refresh = open(row.secretSealed);
    if (!refresh) throw new CalendarApiError("The calendar's sign-in has expired — reconnect it.", 401);
    const provider = row.provider as CalendarProvider;
    const client = await this.platform.oauthClient(provider);
    if (!client) throw new CalendarApiError(`${LABEL[provider]} sign-in is not configured on this installation.`, 503);
    try {
      const body = await tokenRequest(tokenUrl(provider, await this.platform.microsoftTenant()), { client_id: client.id, client_secret: client.secret, refresh_token: refresh, grant_type: "refresh_token" });
      await this.prisma.db.calendarConnection.update({
        where: { id: row.id, workspaceId: row.workspaceId },
        data: {
          accessSealed: seal(body.access_token),
          accessExpiresAt: new Date(Date.now() + (body.expires_in ?? 3600) * 1000),
          // Microsoft rotates refresh tokens; keep the newest.
          ...(body.refresh_token ? { secretSealed: seal(body.refresh_token) } : {}),
          ...(row.status !== "connected" ? { status: "connected", lastError: "" } : {}),
        },
      });
      return body.access_token;
    } catch (e) {
      if (e instanceof CalendarApiError && e.isAuth) await this.markBroken(row, `Sign-in refresh failed: ${e.message}`);
      throw e;
    }
  }

  /** The provider refused the sign-in: the connection stops being used until it is reconnected, and its owner is told once. */
  async markBroken(row: CalendarConnection, why: string) {
    const res = await this.prisma.db.calendarConnection.updateMany({ where: { id: row.id, workspaceId: row.workspaceId, status: "connected" }, data: { status: "error", lastError: why.slice(0, 500) } });
    if (res.count) {
      await this.notifications.notify(row.workspaceId, [row.userId], {
        type: "calendar.disconnected",
        title: `Reconnect your calendar (${row.email})`,
        body: `${LABEL[row.provider as CalendarProvider]} stopped accepting Growthdesk's access, so your booking pages can no longer see your busy times or add meetings to it. ${why}`,
        link: `/w/${row.workspaceId}/settings/calendar`,
        email: true,
      });
    }
  }

  /** Runs a provider call with a fresh token; an expired-access answer marks the connection broken. */
  private async withToken<T>(row: CalendarConnection, fn: (token: string) => Promise<T>): Promise<T> {
    const token = await this.accessToken(row);
    try {
      return await fn(token);
    } catch (e) {
      if (e instanceof CalendarApiError && e.isAuth) await this.markBroken(row, e.message);
      throw e;
    }
  }

  // ─── What booking pages use ───────────────────────────────────────────────

  /** A person's usable connections, oldest (the one events are written to) first. */
  connectionsOf(workspaceId: string, userIds: string[]) {
    return this.prisma.db.calendarConnection.findMany({ where: { workspaceId, userId: { in: userIds }, status: "connected", deletedAt: null }, orderBy: { createdAt: "asc" } });
  }

  /**
   * A person's busy times in [from, to) from every connected calendar. A
   * calendar that cannot be read right now throws (the caller then offers
   * none of this person's slots rather than risk a double booking); one whose
   * access was revoked is marked broken and skipped from then on.
   */
  async busy(row: CalendarConnection, from: Date, to: Date): Promise<BusyInterval[]> {
    const ids = Array.isArray(row.busyCalendarIds) && row.busyCalendarIds.length ? (row.busyCalendarIds as string[]) : [row.calendarId];
    const busy = await this.withToken(row, (token) => CALENDAR_API[row.provider as CalendarProvider].busy(token, ids, from, to));
    return busy;
  }

  /** Writes the booked event to the host's first connected calendar. null = the host has none (booking still goes ahead). */
  async createEvent(workspaceId: string, hostUserId: string, event: Omit<NewEvent, "conference">, locationType: string): Promise<(CreatedEvent & { connectionId: string }) | null> {
    const [row] = await this.connectionsOf(workspaceId, [hostUserId]);
    if (!row) return null;
    const provider = row.provider as CalendarProvider;
    const conference = (locationType === "google_meet" && provider === "google") || (locationType === "teams" && provider === "microsoft");
    const created = await this.withToken(row, (token) => CALENDAR_API[provider].create(token, row.calendarId, { ...event, conference }));
    return { ...created, connectionId: row.id };
  }

  private async connectionFor(workspaceId: string, connectionId: string | null) {
    if (!connectionId) return null;
    return this.prisma.db.calendarConnection.findFirst({ where: { id: connectionId, workspaceId, deletedAt: null } });
  }

  /** Moves the event a meeting mirrors. false = nothing to move (no event, or its calendar is gone). */
  async moveEvent(m: { workspaceId: string; calendarConnectionId: string | null; externalEventId: string | null; startsAt: Date; endsAt: Date | null; timezone: string }): Promise<boolean> {
    const row = await this.connectionFor(m.workspaceId, m.calendarConnectionId);
    if (!row || !m.externalEventId) return false;
    const end = m.endsAt ?? new Date(m.startsAt.getTime() + 30 * 60_000);
    await this.withToken(row, (token) => CALENDAR_API[row.provider as CalendarProvider].move(token, row.calendarId, m.externalEventId!, m.startsAt, end, m.timezone || "UTC"));
    return true;
  }

  /** Cancels (deletes, telling the attendee) the event a meeting mirrors. */
  async cancelEvent(m: { workspaceId: string; calendarConnectionId: string | null; externalEventId: string | null }): Promise<boolean> {
    const row = await this.connectionFor(m.workspaceId, m.calendarConnectionId);
    if (!row || !m.externalEventId) return false;
    await this.withToken(row, (token) => CALENDAR_API[row.provider as CalendarProvider].cancel(token, row.calendarId, m.externalEventId!));
    return true;
  }

  /**
   * Worker sweep: refreshes tokens that are about to expire for connections
   * nobody has used lately, so a revoked grant is noticed (and its owner told)
   * before a visitor tries to book. Unscoped: it looks across workspaces;
   * each update names the row's workspace.
   */
  async checkHealth(limit = 200) {
    const rows = await this.prisma.unscoped.calendarConnection.findMany({
      where: { status: "connected", deletedAt: null, OR: [{ lastSyncedAt: null }, { lastSyncedAt: { lt: new Date(Date.now() - 12 * 3600_000) } }] },
      orderBy: { lastSyncedAt: "asc" },
      take: limit,
    });
    let ok = 0;
    for (const row of rows) {
      try {
        await this.withToken(row, (token) => CALENDAR_API[row.provider as CalendarProvider].calendars(token));
        await this.prisma.db.calendarConnection.update({ where: { id: row.id, workspaceId: row.workspaceId }, data: { lastSyncedAt: new Date(), lastError: "" } });
        ok += 1;
      } catch (e) {
        if (!(e instanceof CalendarApiError && e.isAuth)) this.log.warn(`calendar ${row.id} health check: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return { checked: rows.length, ok };
  }
}
