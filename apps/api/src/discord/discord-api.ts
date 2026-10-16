import { Injectable } from "@nestjs/common";
import type { DiscordOverwrite, DiscordRole } from "@growthdesk/shared";

export const DISCORD_API = "https://discord.com/api/v10";
export const DISCORD_AUTHORIZE_URL = "https://discord.com/oauth2/authorize";
const TIMEOUT_MS = 10_000;
const USER_AGENT = "DiscordBot (https://growthdesk.app, 1.0)";

/*
 * Discord's REST API (v10), the only way Growthdesk talks to Discord. Every
 * call names its credential: the installation's bot token, or a person's
 * short-lived OAuth token during the connect flow. Neither ever appears in an
 * error or a log line — errors carry the HTTP status, Discord's JSON error
 * code and message, and the rate limit's wait.
 *
 * `fetchImpl` is replaceable so tests can stand in for Discord.
 */

export type DiscordAuth = { bot: string } | { bearer: string };

export type DiscordGuild = { id: string; name: string; icon: string | null; owner_id: string; roles: DiscordRole[] };
export type DiscordChannel = {
  id: string;
  type: number;
  name: string;
  position: number;
  parent_id: string | null;
  permission_overwrites?: DiscordOverwrite[];
};
export type DiscordUserGuild = { id: string; name: string; icon: string | null; owner: boolean; permissions: string };
export type DiscordTokenResponse = { access_token: string; token_type: string; scope: string; guild?: { id: string; name: string } };

/** A failed Discord call. `status` 0 = no answer (network error, timeout). */
export class DiscordApiError extends Error {
  constructor(
    readonly status: number,
    /** Discord's JSON error code (10003 Unknown Channel, 50001 Missing Access, 50013 Missing Permissions…), 0 if none. */
    readonly code: number,
    message: string,
    /** How long Discord asked us to wait (429), in ms. */
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = "DiscordApiError";
  }

  get rateLimited() {
    return this.status === 429;
  }

  /** Worth trying again later: rate limits, Discord's own errors, no answer. Everything else will fail the same way again. */
  get retryable() {
    return this.status === 429 || this.status === 0 || this.status === 408 || this.status >= 500;
  }

  /** The bot's token is wrong or was reset: an installation problem, not the workspace's. */
  get badToken() {
    return this.status === 401;
  }

  /** The channel (or server) is gone. */
  get unknownChannel() {
    return this.code === 10003;
  }

  get unknownGuild() {
    return this.code === 10004;
  }

  /** The bot cannot see the channel or server (50001), or lacks a permission there (50013). */
  get forbidden() {
    return this.status === 403 || this.code === 50001 || this.code === 50013;
  }

  /** Our own short code for the delivery log. */
  get kind(): string {
    if (this.rateLimited) return "rate_limited";
    if (this.badToken) return "invalid_bot_token";
    if (this.unknownChannel) return "unknown_channel";
    if (this.unknownGuild) return "unknown_server";
    if (this.code === 50001) return "missing_access";
    if (this.code === 50013) return "missing_permissions";
    if (this.status === 0) return "no_response";
    if (this.status >= 500) return "discord_unavailable";
    return this.code ? `discord_${this.code}` : `http_${this.status}`;
  }
}

/** Plain words for the people reading the error, per kind. */
export function explainDiscordError(e: DiscordApiError): string {
  switch (e.kind) {
    case "rate_limited":
      return `Discord asked us to slow down${e.retryAfterMs ? ` for ${Math.ceil(e.retryAfterMs / 1000)}s` : ""}.`;
    case "invalid_bot_token":
      return "Discord refused the bot's token. A platform admin needs to check the Discord bot token (admin → Settings → Discord).";
    case "unknown_channel":
      return "The channel no longer exists in Discord.";
    case "unknown_server":
      return "The Discord server no longer exists, or the bot was removed from it.";
    case "missing_access":
      return "The bot cannot see this channel. Give the Growthdesk bot (or its role) View Channel there.";
    case "missing_permissions":
      return "The bot lacks a permission it needs here (Send Messages, Embed Links, or Manage Channels for changes).";
    case "no_response":
      return "Discord did not answer in time.";
    case "discord_unavailable":
      return `Discord had a problem (HTTP ${e.status}).`;
    default:
      return `Discord refused: ${e.message}`;
  }
}

@Injectable()
export class DiscordApi {
  /** Swapped by tests for a fake Discord. */
  fetchImpl: typeof fetch = (input, init) => fetch(input, init);

  async request<T>(method: string, path: string, opts: { auth: DiscordAuth; body?: unknown; reason?: string } ): Promise<T> {
    const headers: Record<string, string> = {
      "user-agent": USER_AGENT,
      authorization: "bot" in opts.auth ? `Bot ${opts.auth.bot}` : `Bearer ${opts.auth.bearer}`,
    };
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    // Shown in the server's audit log: who in Growthdesk made a change.
    if (opts.reason) headers["x-audit-log-reason"] = encodeURIComponent(opts.reason.slice(0, 400));
    return this.send<T>(`${DISCORD_API}${path}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  }

  private async send<T>(url: string, init: RequestInit): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "error" });
    } catch (e) {
      throw new DiscordApiError(0, 0, e instanceof Error && e.name === "TimeoutError" ? "timed out" : "no response");
    }
    const text = await res.text().catch(() => "");
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (res.ok) return (json ?? {}) as T;
    const body = (json && typeof json === "object" ? json : {}) as { code?: number; message?: string; retry_after?: number; error?: string; error_description?: string };
    const retryAfter = res.status === 429 ? Math.ceil(1000 * (Number(body.retry_after ?? res.headers.get("retry-after") ?? 1) || 1)) : null;
    const message = String(body.message ?? body.error_description ?? body.error ?? `HTTP ${res.status}`).slice(0, 300);
    throw new DiscordApiError(res.status, Number(body.code ?? 0) || 0, message, retryAfter);
  }

  // ─── OAuth2 (the connect flow) ─────────────────────────────────────────────

  async exchangeCode(app: { clientId: string; clientSecret: string }, code: string, redirectUri: string): Promise<DiscordTokenResponse> {
    const body = new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: app.clientId, client_secret: app.clientSecret });
    return this.send<DiscordTokenResponse>(`${DISCORD_API}/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": USER_AGENT },
      body: body.toString(),
    });
  }

  /** Best effort: the person's token was only needed to check they manage the server. */
  async revokeToken(app: { clientId: string; clientSecret: string }, token: string): Promise<void> {
    const body = new URLSearchParams({ token, token_type_hint: "access_token", client_id: app.clientId, client_secret: app.clientSecret });
    await this.send(`${DISCORD_API}/oauth2/token/revoke`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": USER_AGENT }, body: body.toString() }).catch(() => undefined);
  }

  userGuilds(bearer: string) {
    return this.request<DiscordUserGuild[]>("GET", "/users/@me/guilds", { auth: { bearer } });
  }

  // ─── As the bot ────────────────────────────────────────────────────────────

  /** The application the bot token belongs to (its id is the OAuth2 client id). */
  application(bot: string) {
    return this.request<{ id: string; name: string }>("GET", "/applications/@me", { auth: { bot } });
  }

  botUser(bot: string) {
    return this.request<{ id: string; username: string }>("GET", "/users/@me", { auth: { bot } });
  }

  guild(bot: string, guildId: string) {
    return this.request<DiscordGuild>("GET", `/guilds/${guildId}`, { auth: { bot } });
  }

  member(bot: string, guildId: string, userId: string) {
    return this.request<{ roles: string[] }>("GET", `/guilds/${guildId}/members/${userId}`, { auth: { bot } });
  }

  channels(bot: string, guildId: string) {
    return this.request<DiscordChannel[]>("GET", `/guilds/${guildId}/channels`, { auth: { bot } });
  }

  createChannel(bot: string, guildId: string, input: { name: string; type: number; parent_id?: string | null }, reason: string) {
    return this.request<DiscordChannel>("POST", `/guilds/${guildId}/channels`, { auth: { bot }, body: input, reason });
  }

  renameChannel(bot: string, channelId: string, name: string, reason: string) {
    return this.request<DiscordChannel>("PATCH", `/channels/${channelId}`, { auth: { bot }, body: { name }, reason });
  }

  leaveGuild(bot: string, guildId: string) {
    return this.request<unknown>("DELETE", `/users/@me/guilds/${guildId}`, { auth: { bot } });
  }

  sendMessage(bot: string, channelId: string, body: Record<string, unknown>) {
    return this.request<{ id: string; channel_id: string }>("POST", `/channels/${channelId}/messages`, { auth: { bot }, body });
  }
}
