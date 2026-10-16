import { Inject, Injectable, Logger } from "@nestjs/common";
import { createHash, randomBytes } from "node:crypto";
import type { z } from "zod";
import {
  DISCORD_CHANNEL_TYPES,
  DISCORD_PERMISSION,
  discordBasePermissions,
  discordChannelPermissions,
  discordInstallPermissions,
  hasDiscordPermission,
  normalizeDiscordChannelName,
  permissionsFor,
  snowflake,
  type DiscordChannelKind,
  type DiscordCreateChannelInput,
  type DiscordDestinationInput,
  type RolePermissionOverrides,
} from "@growthdesk/shared";
import { APP_CONFIG, type AppConfig } from "../config/config.js";
import { PrismaService } from "../prisma/prisma.service.js";
import type { DiscordConnection, DiscordDestination } from "../generated/prisma/client.js";
import { AuditService } from "../core/audit.service.js";
import { PlatformSettingsService, type DiscordApp } from "../core/platform-settings.service.js";
import { derivedKey, hmac, safeEqual } from "../common/crypto.js";
import { actorId, me, ws, type RequestContext } from "../common/context.js";
import { badRequest, conflict, isApiError, notFound, unavailable } from "../common/errors.js";
import { DISCORD_AUTHORIZE_URL, DiscordApi, DiscordApiError, explainDiscordError, type DiscordChannel, type DiscordGuild } from "./discord-api.js";

const STATE_TTL_MS = 10 * 60_000;
/** Manage Server or Administrator: what Discord itself requires to add a bot. */
const MANAGE_GUILD = 1n << 5n;
const KIND_BY_TYPE: Record<number, DiscordChannelKind> = { [DISCORD_CHANNEL_TYPES.text]: "text", [DISCORD_CHANNEL_TYPES.announcement]: "announcement", [DISCORD_CHANNEL_TYPES.category]: "category" };

type State = { w: string; u: string; m: boolean; exp: number; n: string };

/** A failure to show the person (as ?discordError=). */
class FlowError extends Error {}

export const connectionDto = (c: DiscordConnection) => ({
  id: c.id,
  guildId: c.guildId,
  guildName: c.guildName,
  guildIconUrl: c.guildIcon ? `https://cdn.discordapp.com/icons/${c.guildId}/${c.guildIcon}.png?size=64` : null,
  status: c.status as "connected" | "lost" | "disconnected",
  permissions: permissionSummary(c.permissions),
  manageChannels: c.manageChannels,
  lastError: c.lastError,
  lastCheckedAt: c.lastCheckedAt,
  createdAt: c.createdAt,
});

export const destinationDto = (d: DiscordDestination & { connection?: { guildName: string; status: string } }) => ({
  id: d.id,
  connectionId: d.connectionId,
  guildName: d.connection?.guildName ?? "",
  connectionStatus: d.connection?.status ?? "connected",
  channelId: d.channelId,
  name: d.name,
  categoryName: d.categoryName,
  kind: d.kind,
  group: d.group,
  status: d.status as "active" | "missing" | "forbidden",
  lastError: d.lastError,
  lastDeliveryAt: d.lastDeliveryAt,
  createdAt: d.createdAt,
});

/** The bot's server-wide permissions, as the four that matter here. */
export function permissionSummary(perms: string | bigint) {
  const p = typeof perms === "bigint" ? perms : BigInt(/^\d+$/.test(perms) ? perms : "0");
  return {
    viewChannels: hasDiscordPermission(p, DISCORD_PERMISSION.VIEW_CHANNEL),
    sendMessages: hasDiscordPermission(p, DISCORD_PERMISSION.SEND_MESSAGES),
    embedLinks: hasDiscordPermission(p, DISCORD_PERMISSION.EMBED_LINKS),
    manageChannels: hasDiscordPermission(p, DISCORD_PERMISSION.MANAGE_CHANNELS),
    administrator: (p & DISCORD_PERMISSION.ADMINISTRATOR) === DISCORD_PERMISSION.ADMINISTRATOR,
  };
}

export type StructureChannel = {
  id: string;
  name: string;
  kind: DiscordChannelKind;
  parentId: string | null;
  position: number;
  canView: boolean;
  canSend: boolean;
  canManage: boolean;
  destinationId: string | null;
};

/*
 * Discord servers connected to a workspace, their channels, and the channels
 * saved as destinations.
 *
 * Connecting is Discord's bot install over OAuth2 (scopes `bot guilds`,
 * response_type=code). The signed state names the workspace and the person
 * and lives ten minutes; the callback also requires the browser's session to
 * be that person, still holding integrations.manage. Discord's redirect names
 * the server (guild_id), but that is only a claim: the code is exchanged, the
 * person's own server list (the `guilds` scope) must show them owning or
 * managing that server, and the bot must actually be in it. The person's token
 * is revoked straight after; only the server id and names are kept. The bot
 * token is the installation's, never stored per workspace.
 *
 * Reads always go to Discord (nothing is cached but names for the log), so
 * the channel list is exactly what the bot can see now. Creating or renaming
 * a channel happens only on an admin's explicit request; nothing here ever
 * deletes anything in Discord.
 */
@Injectable()
export class DiscordService {
  private readonly log = new Logger("discord");
  /** The bot's own user id, per token (by digest), for permission maths. */
  private botIds = new Map<string, string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly platform: PlatformSettingsService,
    private readonly audit: AuditService,
    private readonly api: DiscordApi,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  private base() {
    return this.config.PUBLIC_APP_URL.replace(/\/+$/, "");
  }

  redirectUri() {
    return `${this.base()}/api/discord/oauth/callback`;
  }

  async requireApp(): Promise<DiscordApp> {
    const app = await this.platform.discordApp();
    if (!app) throw unavailable("Discord is not set up on this installation. A platform admin adds the Discord application (client id, client secret and bot token) under admin → Settings → Discord.");
    return app;
  }

  async botId(app: DiscordApp): Promise<string> {
    const key = createHash("sha256").update(app.botToken).digest("hex");
    const known = this.botIds.get(key);
    if (known) return known;
    const user = await this.api.botUser(app.botToken);
    this.botIds.set(key, user.id);
    return user.id;
  }

  /** A Discord failure as an API error the UI can show. */
  private refuse(e: unknown): never {
    if (e instanceof DiscordApiError) {
      if (e.rateLimited) throw conflict(`${explainDiscordError(e)} Try again in a moment.`);
      if (e.badToken) throw unavailable(explainDiscordError(e));
      throw badRequest(explainDiscordError(e));
    }
    throw e;
  }

  // ─── Overview ─────────────────────────────────────────────────────────────

  async overview(ctx: RequestContext) {
    const w = ws(ctx).id;
    const [app, connections, settings] = await Promise.all([
      this.platform.discordApp(),
      this.prisma.db.discordConnection.findMany({ where: { workspaceId: w }, orderBy: { createdAt: "asc" } }),
      this.prisma.db.discordSettings.findUnique({ where: { workspaceId: w } }),
    ]);
    return {
      configured: Boolean(app),
      redirectUri: this.redirectUri(),
      connections: connections.map(connectionDto),
      settings: { unrouted: (settings?.unrouted ?? "ignore") as "ignore" | "log" | "fallback", fallbackDestinationId: settings?.fallbackDestinationId ?? null },
    };
  }

  async connection(workspaceId: string, id: string) {
    const row = await this.prisma.db.discordConnection.findFirst({ where: { id, workspaceId } });
    if (!row) throw notFound("That Discord server");
    return row;
  }

  // ─── Connect (OAuth2 bot install) ─────────────────────────────────────────

  signState(state: State): string {
    const body = Buffer.from(JSON.stringify(state), "utf8").toString("base64url");
    return `${body}.${hmac(derivedKey("discord-oauth"), body, "base64url")}`;
  }

  readState(raw: string | undefined): State | null {
    const [body, sig, extra] = String(raw ?? "").split(".");
    if (!body || !sig || extra !== undefined) return null;
    if (!safeEqual(sig, hmac(derivedKey("discord-oauth"), body, "base64url"))) return null;
    try {
      const s = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as State;
      if (!s || typeof s.w !== "string" || typeof s.u !== "string" || typeof s.m !== "boolean" || typeof s.exp !== "number" || s.exp < Date.now()) return null;
      return s;
    } catch {
      return null;
    }
  }

  async start(ctx: RequestContext, manageChannels: boolean) {
    const app = await this.requireApp();
    const state = this.signState({ w: ws(ctx).id, u: me(ctx).userId, m: manageChannels, exp: Date.now() + STATE_TTL_MS, n: randomBytes(9).toString("base64url") });
    const params = new URLSearchParams({
      client_id: app.clientId,
      scope: "bot guilds",
      permissions: discordInstallPermissions(manageChannels),
      response_type: "code",
      redirect_uri: this.redirectUri(),
      integration_type: "0",
      state,
    });
    return { url: `${DISCORD_AUTHORIZE_URL}?${params.toString()}` };
  }

  /** Handles Discord's redirect; returns where to send the browser next. */
  async callback(query: { code?: string; state?: string; guild_id?: string; error?: string; error_description?: string }, ctx: RequestContext): Promise<string> {
    const state = this.readState(query.state);
    const page = state ? `${this.base()}/w/${state.w}/settings/discord` : `${this.base()}/`;
    const fail = (message: string) => `${page}?discordError=${encodeURIComponent(message.slice(0, 300))}`;
    if (!state) return fail("That Discord link has expired or is not valid. Start connecting again.");
    try {
      const row = await this.complete(state, query, ctx);
      return `${page}?discord=connected&connection=${encodeURIComponent(row.id)}`;
    } catch (e) {
      if (e instanceof FlowError || isApiError(e)) return fail(e.message);
      if (e instanceof DiscordApiError) return fail(explainDiscordError(e));
      this.log.error(`discord connect failed: ${e instanceof Error ? e.message : String(e)}`);
      return fail("Discord could not be connected. Try again.");
    }
  }

  private async complete(state: State, query: { code?: string; guild_id?: string; error?: string; error_description?: string }, ctx: RequestContext): Promise<DiscordConnection> {
    if (query.error) throw new FlowError(query.error === "access_denied" ? "Discord access was not granted." : `Discord said: ${query.error_description || query.error}`);
    if (!query.code) throw new FlowError("Discord did not return an authorisation code.");
    if (!ctx.identity || ctx.identity.userId !== state.u) throw new FlowError("Sign in as the person who started connecting Discord, then try again.");
    const membership = await this.prisma.db.membership.findUnique({ where: { workspaceId_userId: { workspaceId: state.w, userId: state.u } }, include: { workspace: true } });
    if (!membership) throw new FlowError("You are no longer a member of that workspace.");
    if (membership.workspace.status !== "active") throw new FlowError("This workspace is suspended.");
    if (!permissionsFor(membership.role, membership.workspace.rolePermissions as RolePermissionOverrides | null).includes("integrations.manage")) {
      throw new FlowError("Your role can no longer connect integrations in this workspace.");
    }

    const app = await this.requireApp();
    const token = await this.api.exchangeCode(app, query.code, this.redirectUri()).catch((e: unknown) => {
      throw new FlowError(`Discord refused the sign-in: ${e instanceof DiscordApiError ? e.message : "no answer"}.`);
    });
    try {
      // The redirect's guild_id is only a claim; Discord's token response names the server the bot was really added to.
      const guildId = token.guild?.id ?? query.guild_id ?? "";
      if (!snowflake.safeParse(guildId).success) throw new FlowError("Discord did not say which server the bot was added to. Choose a server on Discord's screen.");
      if (query.guild_id && token.guild?.id && query.guild_id !== token.guild.id) throw new FlowError("Discord's answer did not match the server chosen. Start again.");
      // The person must manage that server themselves (Discord requires it to add a bot; we check it too).
      const theirs = await this.api.userGuilds(token.access_token);
      const g = theirs.find((x) => x.id === guildId);
      const perms = g ? BigInt(/^\d+$/.test(g.permissions) ? g.permissions : "0") : 0n;
      if (!g || !(g.owner || (perms & MANAGE_GUILD) === MANAGE_GUILD || (perms & DISCORD_PERMISSION.ADMINISTRATOR) === DISCORD_PERMISSION.ADMINISTRATOR)) {
        throw new FlowError("You need Manage Server in that Discord server to connect it.");
      }

      let guild: DiscordGuild;
      let base: bigint;
      try {
        guild = await this.api.guild(app.botToken, guildId);
        const botId = await this.botId(app);
        const member = await this.api.member(app.botToken, guildId, botId);
        base = discordBasePermissions({ guildId, ownerId: guild.owner_id, userId: botId, roles: guild.roles, memberRoleIds: member.roles });
      } catch (e) {
        if (e instanceof DiscordApiError && !e.retryable && !e.badToken) throw new FlowError("The Growthdesk bot is not in that server. Add it again and leave its permissions ticked.");
        throw e;
      }

      const existing = await this.prisma.db.discordConnection.findUnique({ where: { workspaceId_guildId: { workspaceId: state.w, guildId } } });
      const data = {
        guildName: guild.name.slice(0, 100),
        guildIcon: guild.icon ?? "",
        status: "connected",
        permissions: base.toString(),
        manageChannels: state.m && hasDiscordPermission(base, DISCORD_PERMISSION.MANAGE_CHANNELS),
        lastError: "",
        lastCheckedAt: new Date(),
        connectedById: state.u,
      };
      const row = existing
        ? await this.prisma.db.discordConnection.update({ where: { id: existing.id, workspaceId: state.w }, data })
        : await this.prisma.db.discordConnection.create({ data: { workspaceId: state.w, guildId, ...data } });
      await this.audit.record(ctx, {
        workspaceId: state.w,
        action: existing ? "discord.reconnected" : "discord.connected",
        targetType: "discord_connection",
        targetId: row.id,
        metadata: { guildId, guildName: row.guildName, permissions: permissionSummary(base) },
      });
      return row;
    } finally {
      await this.api.revokeToken(app, token.access_token);
    }
  }

  async disconnect(ctx: RequestContext, id: string, leaveServer: boolean) {
    const w = ws(ctx).id;
    const row = await this.connection(w, id);
    await this.prisma.db.discordConnection.update({ where: { id: row.id, workspaceId: w }, data: { status: "disconnected" } });
    let left = false;
    if (leaveServer) {
      // Unscoped by necessity: another workspace may use the same server through the same bot; it stays then.
      const others = await this.prisma.unscoped.discordConnection.count({ where: { guildId: row.guildId, status: "connected", NOT: { id: row.id } } });
      const app = await this.platform.discordApp();
      if (!others && app) {
        await this.api.leaveGuild(app.botToken, row.guildId).then(
          () => (left = true),
          (e: unknown) => this.log.warn(`could not leave server ${row.guildId}: ${e instanceof DiscordApiError ? e.kind : String(e)}`),
        );
      }
    }
    await this.audit.record(ctx, { action: "discord.disconnected", targetType: "discord_connection", targetId: row.id, metadata: { guildId: row.guildId, guildName: row.guildName, leftServer: left } });
    return { disconnected: true, leftServer: left };
  }

  // ─── Server structure ─────────────────────────────────────────────────────

  /**
   * The server as the bot sees it now: categories and the channels it may
   * post in, each with what the bot can do there. Channels it cannot see are
   * counted, not listed. Refreshes the connection's status and permissions
   * and every destination's snapshot and status on the way.
   */
  async structure(ctx: RequestContext, id: string) {
    const w = ws(ctx).id;
    const row = await this.connection(w, id);
    if (row.status === "disconnected") throw conflict("This server is disconnected. Connect it again to see its channels.");
    const app = await this.requireApp();
    let guild: DiscordGuild;
    let channels: DiscordChannel[];
    let base: bigint;
    let botId: string;
    let memberRoles: string[];
    try {
      botId = await this.botId(app);
      [guild, channels, { roles: memberRoles }] = await Promise.all([this.api.guild(app.botToken, row.guildId), this.api.channels(app.botToken, row.guildId), this.api.member(app.botToken, row.guildId, botId)]);
      base = discordBasePermissions({ guildId: row.guildId, ownerId: guild.owner_id, userId: botId, roles: guild.roles, memberRoleIds: memberRoles });
    } catch (e) {
      if (e instanceof DiscordApiError && (e.unknownGuild || e.code === 50001 || e.code === 10007 || e.status === 404 || e.status === 403)) {
        await this.prisma.db.discordConnection.update({ where: { id: row.id, workspaceId: w }, data: { status: "lost", lastError: "The bot is no longer in this server (removed, or the server was deleted). Connect it again.", lastCheckedAt: new Date() } });
        throw conflict("The Growthdesk bot is no longer in this Discord server. Connect it again to keep posting there.");
      }
      if (e instanceof DiscordApiError) {
        await this.prisma.db.discordConnection.update({ where: { id: row.id, workspaceId: w }, data: { lastError: explainDiscordError(e), lastCheckedAt: new Date() } });
      }
      return this.refuse(e);
    }

    const destinations = await this.prisma.db.discordDestination.findMany({ where: { workspaceId: w, connectionId: row.id } });
    const destByChannel = new Map(destinations.map((d) => [d.channelId, d]));
    const categoryName = new Map(channels.filter((c) => c.type === DISCORD_CHANNEL_TYPES.category).map((c) => [c.id, c.name]));
    const list: StructureChannel[] = [];
    let hidden = 0;
    for (const c of channels) {
      const kind = KIND_BY_TYPE[c.type];
      if (!kind) continue;
      const p = discordChannelPermissions(base, { guildId: row.guildId, userId: botId, memberRoleIds: memberRoles, overwrites: c.permission_overwrites ?? [] });
      const canView = hasDiscordPermission(p, DISCORD_PERMISSION.VIEW_CHANNEL);
      if (!canView) {
        hidden++;
        continue;
      }
      list.push({
        id: c.id,
        name: c.name,
        kind,
        parentId: c.parent_id ?? null,
        position: c.position,
        canView,
        canSend: kind !== "category" && hasDiscordPermission(p, DISCORD_PERMISSION.SEND_MESSAGES) && hasDiscordPermission(p, DISCORD_PERMISSION.EMBED_LINKS),
        canManage: hasDiscordPermission(p, DISCORD_PERMISSION.MANAGE_CHANNELS),
        destinationId: destByChannel.get(c.id)?.id ?? null,
      });
    }
    list.sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));

    // Bring the stored snapshots and statuses in line with Discord. Nothing is created or removed here.
    const byId = new Map(list.map((c) => [c.id, c]));
    const present = new Set(channels.map((c) => c.id));
    for (const d of destinations) {
      const c = byId.get(d.channelId);
      const status = !present.has(d.channelId) ? "missing" : !c || !c.canSend ? "forbidden" : "active";
      const lastError = status === "missing" ? "The channel was deleted in Discord." : status === "forbidden" ? "The bot cannot see this channel, or lacks Send Messages / Embed Links there." : "";
      const name = c?.name ?? d.name;
      const cat = c?.parentId ? (categoryName.get(c.parentId) ?? "") : c ? "" : d.categoryName;
      if (d.status !== status || d.name !== name || d.categoryName !== cat || d.lastError !== lastError) {
        await this.prisma.db.discordDestination.update({ where: { id: d.id, workspaceId: w }, data: { status, name, categoryName: cat, lastError } });
      }
    }
    const updated = await this.prisma.db.discordConnection.update({
      where: { id: row.id, workspaceId: w },
      data: { status: "connected", guildName: guild.name.slice(0, 100), guildIcon: guild.icon ?? "", permissions: base.toString(), lastError: "", lastCheckedAt: new Date() },
    });
    return {
      connection: connectionDto(updated),
      categories: list.filter((c) => c.kind === "category"),
      channels: list.filter((c) => c.kind !== "category"),
      hiddenCount: hidden,
    };
  }

  /** The guild's channels, for checking that an id the client sent belongs to this server. */
  private async liveChannels(app: DiscordApp, row: DiscordConnection) {
    try {
      return await this.api.channels(app.botToken, row.guildId);
    } catch (e) {
      return this.refuse(e);
    }
  }

  private async connected(workspaceId: string, id: string) {
    const row = await this.connection(workspaceId, id);
    if (row.status !== "connected") throw conflict(row.status === "lost" ? "The bot is no longer in this server. Connect it again first." : "This server is disconnected. Connect it again first.");
    return row;
  }

  async createChannel(ctx: RequestContext, id: string, input: z.infer<typeof DiscordCreateChannelInput>) {
    const w = ws(ctx).id;
    const row = await this.connected(w, id);
    const app = await this.requireApp();
    if (!hasDiscordPermission(row.permissions, DISCORD_PERMISSION.MANAGE_CHANNELS)) {
      throw badRequest("The bot does not have Manage Channels in this server. Connect the server again with “Allow creating and renaming channels” on, or give the bot's role Manage Channels in Discord.");
    }
    const name = input.kind === "text" ? normalizeDiscordChannelName(input.name) : input.name.trim().slice(0, 100);
    if (!name) throw badRequest("Use letters or numbers in the name", { name: "Use letters or numbers in the name" });
    if (input.kind === "category" && input.parentId) throw badRequest("A category cannot sit inside another category", { parentId: "Categories have no parent" });
    if (input.parentId) {
      const parent = (await this.liveChannels(app, row)).find((c) => c.id === input.parentId);
      if (!parent || parent.type !== DISCORD_CHANNEL_TYPES.category) throw badRequest("That category is not in this server", { parentId: "Not a category in this server" });
    }
    const who = ctx.identity?.name ?? "a workspace admin";
    let created: DiscordChannel;
    try {
      created = await this.api.createChannel(app.botToken, row.guildId, { name, type: DISCORD_CHANNEL_TYPES[input.kind], ...(input.parentId ? { parent_id: input.parentId } : {}) }, `Growthdesk: created by ${who}`);
    } catch (e) {
      return this.refuse(e);
    }
    await this.audit.record(ctx, { action: "discord.channel_created", targetType: "discord_connection", targetId: row.id, metadata: { guildId: row.guildId, channelId: created.id, name: created.name, kind: input.kind } });
    let destination: ReturnType<typeof destinationDto> | null = null;
    if (input.kind === "text" && input.addAsDestination) {
      const categoryName = input.parentId ? ((await this.liveChannels(app, row)).find((c) => c.id === input.parentId)?.name ?? "") : "";
      const d = await this.prisma.db.discordDestination.create({
        data: { workspaceId: w, connectionId: row.id, channelId: created.id, name: created.name, categoryName, kind: "text", group: input.group, createdById: actorId(ctx) },
        include: { connection: { select: { guildName: true, status: true } } },
      });
      destination = destinationDto(d);
    }
    return { channel: { id: created.id, name: created.name, kind: input.kind, parentId: created.parent_id ?? null }, destination };
  }

  async renameChannel(ctx: RequestContext, id: string, channelId: string, rawName: string) {
    const w = ws(ctx).id;
    if (!snowflake.safeParse(channelId).success) throw notFound("That channel");
    const row = await this.connected(w, id);
    const app = await this.requireApp();
    const channel = (await this.liveChannels(app, row)).find((c) => c.id === channelId);
    const kind = channel ? KIND_BY_TYPE[channel.type] : undefined;
    if (!channel || !kind) throw notFound("That channel in this server");
    const name = kind === "category" ? rawName.trim().slice(0, 100) : normalizeDiscordChannelName(rawName);
    if (!name) throw badRequest("Use letters or numbers in the name", { name: "Use letters or numbers in the name" });
    let renamed: DiscordChannel;
    try {
      renamed = await this.api.renameChannel(app.botToken, channelId, name, `Growthdesk: renamed by ${ctx.identity?.name ?? "a workspace admin"}`);
    } catch (e) {
      // Discord allows two renames per channel every ten minutes.
      if (e instanceof DiscordApiError && e.rateLimited) throw conflict(`Discord limits renaming a channel to twice every ten minutes. Try again in ${Math.ceil((e.retryAfterMs ?? 60_000) / 60_000)} minute(s).`);
      return this.refuse(e);
    }
    if (kind === "category") {
      await this.prisma.db.discordDestination.updateMany({ where: { workspaceId: w, connectionId: row.id, categoryName: channel.name }, data: { categoryName: renamed.name } });
    } else {
      await this.prisma.db.discordDestination.updateMany({ where: { workspaceId: w, connectionId: row.id, channelId }, data: { name: renamed.name } });
    }
    await this.audit.record(ctx, { action: "discord.channel_renamed", targetType: "discord_connection", targetId: row.id, metadata: { guildId: row.guildId, channelId, from: channel.name, to: renamed.name } });
    return { id: renamed.id, name: renamed.name, kind };
  }

  // ─── Destinations ─────────────────────────────────────────────────────────

  async destinations(ctx: RequestContext) {
    const rows = await this.prisma.db.discordDestination.findMany({
      where: { workspaceId: ws(ctx).id },
      include: { connection: { select: { guildName: true, status: true } } },
      orderBy: [{ group: "asc" }, { name: "asc" }],
    });
    return rows.map(destinationDto);
  }

  async addDestination(ctx: RequestContext, input: z.infer<typeof DiscordDestinationInput>) {
    const w = ws(ctx).id;
    const row = await this.connected(w, input.connectionId);
    const existing = await this.prisma.db.discordDestination.findFirst({ where: { workspaceId: w, connectionId: row.id, channelId: input.channelId } });
    if (existing) throw conflict("That channel is already a destination", { channelId: "Already a destination" });
    // The channel must be in this server, be one a bot can post in, and be visible to the bot.
    const s = await this.structure(ctx, row.id);
    const channel = s.channels.find((c) => c.id === input.channelId);
    if (!channel) throw badRequest("That channel is not in this server, or the bot cannot see it", { channelId: "Not a channel the bot can see in this server" });
    const categoryName = channel.parentId ? (s.categories.find((c) => c.id === channel.parentId)?.name ?? "") : "";
    const d = await this.prisma.db.discordDestination.create({
      data: {
        workspaceId: w,
        connectionId: row.id,
        channelId: channel.id,
        name: channel.name,
        categoryName,
        kind: channel.kind,
        group: input.group,
        status: channel.canSend ? "active" : "forbidden",
        lastError: channel.canSend ? "" : "The bot lacks Send Messages / Embed Links here.",
        createdById: actorId(ctx),
      },
      include: { connection: { select: { guildName: true, status: true } } },
    });
    await this.audit.record(ctx, { action: "discord.destination_added", targetType: "discord_destination", targetId: d.id, metadata: { guildId: row.guildId, channelId: d.channelId, name: d.name } });
    return destinationDto(d);
  }

  async updateDestination(ctx: RequestContext, id: string, group: string) {
    const w = ws(ctx).id;
    const d = await this.prisma.db.discordDestination.findFirst({ where: { id, workspaceId: w } });
    if (!d) throw notFound("That destination");
    const updated = await this.prisma.db.discordDestination.update({ where: { id, workspaceId: w }, data: { group }, include: { connection: { select: { guildName: true, status: true } } } });
    return destinationDto(updated);
  }

  /** Forgets a destination (the channel stays in Discord). Refused while a rule or the fallback setting uses it. */
  async removeDestination(ctx: RequestContext, id: string) {
    const w = ws(ctx).id;
    const d = await this.prisma.db.discordDestination.findFirst({ where: { id, workspaceId: w } });
    if (!d) throw notFound("That destination");
    const rules = await this.prisma.db.discordRule.findMany({ where: { workspaceId: w, destinationIds: { has: id } }, select: { name: true } });
    if (rules.length) throw conflict(`Rules still post here: ${rules.map((r) => `“${r.name}”`).join(", ")}. Remove the channel from them first.`);
    const settings = await this.prisma.db.discordSettings.findUnique({ where: { workspaceId: w } });
    if (settings?.fallbackDestinationId === id) throw conflict("This is the fallback channel for unrouted events. Choose another one (or turn the fallback off) first.");
    await this.prisma.db.discordDestination.delete({ where: { id, workspaceId: w } });
    await this.audit.record(ctx, { action: "discord.destination_removed", targetType: "discord_destination", targetId: id, metadata: { channelId: d.channelId, name: d.name } });
  }
}
