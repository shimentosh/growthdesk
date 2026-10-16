import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service.js";
import { PlatformSettingsService, type DiscordApp } from "../core/platform-settings.service.js";
import { open } from "../common/crypto.js";

/** A Discord application, and whose it is: the workspace's own bot, or the installation's. */
export type ResolvedDiscordApp = DiscordApp & { source: "workspace" | "platform" };

/*
 * Which Discord application (bot) a workspace acts through. A workspace that
 * saved its own (Settings → Discord, "bring your own bot") always uses it —
 * its servers were added with that bot, so falling back to another would not
 * reach them; when its secrets cannot be opened it has none. Otherwise the
 * installation's application, when the platform admin set one up.
 */
@Injectable()
export class DiscordAppResolver {
  constructor(
    private readonly prisma: PrismaService,
    private readonly platform: PlatformSettingsService,
  ) {}

  /** The workspace's saved application id ("" when it uses the installation's). */
  async ownClientId(workspaceId: string): Promise<string> {
    const s = await this.prisma.db.discordSettings.findUnique({ where: { workspaceId }, select: { appClientId: true } });
    return s?.appClientId ?? "";
  }

  async forWorkspace(workspaceId: string): Promise<ResolvedDiscordApp | null> {
    const s = await this.prisma.db.discordSettings.findUnique({
      where: { workspaceId },
      select: { appClientId: true, appClientSecretSealed: true, appBotTokenSealed: true },
    });
    if (s?.appClientId) {
      const clientSecret = open(s.appClientSecretSealed) ?? "";
      const botToken = open(s.appBotTokenSealed) ?? "";
      return clientSecret && botToken ? { clientId: s.appClientId, clientSecret, botToken, fromEnv: false, source: "workspace" } : null;
    }
    const app = await this.platform.discordApp();
    return app ? { ...app, source: "platform" } : null;
  }
}
