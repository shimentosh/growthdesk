/*
 * Shapes of the Discord notification responses — apps/api/src/discord
 * (discord.service.ts, discord-routing.service.ts, discord-delivery.service.ts).
 */
import type { DiscordCondition, DiscordDeliveryStatus, DiscordMessage, DiscordTemplateBodyT, DiscordUnroutedMode } from "@growthdesk/shared";

export type DiscordConnectionStatus = "connected" | "lost" | "disconnected";

/** discord.service.ts `connectionDto()` */
export type DiscordConnection = {
  id: string;
  guildId: string;
  guildName: string;
  guildIconUrl: string | null;
  status: DiscordConnectionStatus;
  permissions: { viewChannels: boolean; sendMessages: boolean; embedLinks: boolean; manageChannels: boolean; administrator: boolean };
  manageChannels: boolean;
  lastError: string;
  lastCheckedAt: string | null;
  createdAt: string;
};

/** GET /discord */
export type DiscordOverview = {
  /** A bot is available to this workspace: its own, or the installation's. */
  configured: boolean;
  /** Whose bot the workspace uses; null = none. */
  appSource: "workspace" | "platform" | null;
  /** The workspace's own Discord application, when saved (secrets never returned). */
  ownApp: { clientId: string; clientSecretSet: boolean; botTokenSet: boolean } | null;
  /** The installation offers its own bot as well. */
  platformAvailable: boolean;
  redirectUri: string;
  connections: DiscordConnection[];
  settings: { unrouted: DiscordUnroutedMode; fallbackDestinationId: string | null };
};

/** One channel or category of GET /discord/connections/:id/structure (only those the bot can see). */
export type DiscordStructureChannel = {
  id: string;
  name: string;
  kind: "text" | "announcement" | "category";
  parentId: string | null;
  position: number;
  canView: boolean;
  canSend: boolean;
  canManage: boolean;
  destinationId: string | null;
};

export type DiscordStructure = {
  connection: DiscordConnection;
  categories: DiscordStructureChannel[];
  channels: DiscordStructureChannel[];
  /** Channels the bot cannot see. */
  hiddenCount: number;
};

/** discord.service.ts `destinationDto()` */
export type DiscordDestination = {
  id: string;
  connectionId: string;
  guildName: string;
  connectionStatus: DiscordConnectionStatus;
  channelId: string;
  name: string;
  categoryName: string;
  kind: string;
  group: string;
  status: "active" | "missing" | "forbidden";
  lastError: string;
  lastDeliveryAt: string | null;
  createdAt: string;
};

/** GET /discord/events */
export type DiscordEventEntry = { type: string; label: string; registered: boolean; recentCount: number; lastAt: string | null };

/** GET /discord/fields?types=… */
export type DiscordField = { path: string; example: string; types: string[] };

/** discord-routing.service.ts `ruleDto()` */
export type DiscordRule = {
  id: string;
  name: string;
  events: string[];
  destinationIds: string[];
  templateId: string | null;
  templateName: string | null;
  conditions: DiscordCondition[];
  enabled: boolean;
  lastMatchedAt: string | null;
  lastTestedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

/** discord-routing.service.ts `templateDto()` */
export type DiscordTemplate = {
  id: string;
  name: string;
  description: string;
  body: DiscordTemplateBodyT;
  ruleCount: number;
  createdAt: string;
  updatedAt: string;
};

/** GET /discord/templates */
export type DiscordTemplates = { default: DiscordTemplateBodyT; items: DiscordTemplate[] };

/** GET /discord/sample?type=… */
export type DiscordSample = { source: "event" | "sample"; eventId: string | null; context: Record<string, unknown> };

/** discord-delivery.service.ts `deliveryDto()` (`message` only on GET /deliveries/:id) */
export type DiscordDelivery = {
  id: string;
  ruleId: string | null;
  ruleName: string;
  destinationId: string | null;
  channelName: string;
  guildName: string;
  eventId: string | null;
  eventType: string;
  test: boolean;
  status: DiscordDeliveryStatus;
  attempts: number;
  nextAttemptAt: string | null;
  error: string;
  errorCode: string;
  responseStatus: number | null;
  messageId: string | null;
  sentAt: string | null;
  createdAt: string;
  updatedAt: string;
  message?: DiscordMessage;
};

/** GET /discord/deliveries */
export type DiscordDeliveryPage = { items: DiscordDelivery[]; nextCursor: string | null; last24h: Partial<Record<DiscordDeliveryStatus, number>> };

/** POST /discord/rules/test, /discord/rules/:id/test */
export type DiscordTestResult = {
  source: "event" | "sample";
  eventId: string | null;
  context: Record<string, unknown>;
  conditions: { met: boolean; failed: string | null };
  message: DiscordMessage;
  missing: string[];
  skip: string | null;
  truncated: string[];
  warnings: string[];
  errors: Record<string, string>;
  deliveries: DiscordDelivery[];
};

/** GET /discord/unrouted */
export type DiscordUnrouted = { eventType: string; count: number; lastEventId: string | null; lastAt: string }[];
