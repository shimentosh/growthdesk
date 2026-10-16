import { Injectable, Logger } from "@nestjs/common";
import type { z } from "zod";
import {
  DEFAULT_DISCORD_TEMPLATE,
  DISCORD_MAX_ATTEMPTS,
  DISCORD_RETRY_DELAYS_MS,
  DiscordConditionInput,
  DiscordTemplateBody,
  describeDiscordCondition,
  discordNonce,
  evaluateDiscordConditions,
  renderDiscordMessage,
  type DiscordDeliveriesQuery,
  type DiscordMessage,
  type DiscordTemplateBodyT,
} from "@growthdesk/shared";
import { PrismaService } from "../prisma/prisma.service.js";
import type { DiscordDelivery } from "../generated/prisma/client.js";
import { PlatformSettingsService } from "../core/platform-settings.service.js";
import { NotificationsService } from "../notifications/notifications.service.js";
import { Queues } from "../queues/queues.js";
import { ws, type RequestContext } from "../common/context.js";
import { conflict, notFound } from "../common/errors.js";
import { DiscordApi, DiscordApiError, explainDiscordError } from "./discord-api.js";
import { DiscordContextService } from "./discord-context.service.js";

/** A delivery still not through after this long is failed, whatever the reason (rate limits included). */
export const DISCORD_GIVE_UP_AFTER_MS = 24 * 3600_000;

export const discordJobOptions = (deliveryId: string, delay = 0) => ({ jobId: `discord-${deliveryId}`, attempts: 1, delay, removeOnComplete: { age: 3600, count: 1000 }, removeOnFail: { age: 7 * 86_400 } });

export type AttemptOutcome = { status: string; retryInMs: number | null; error: string };

const conditionsOf = (raw: unknown) => {
  const parsed = DiscordConditionInput.array().safeParse(raw);
  return parsed.success ? parsed.data : [];
};
export const templateBodyOf = (raw: unknown): DiscordTemplateBodyT => {
  const parsed = DiscordTemplateBody.safeParse(raw);
  return parsed.success ? parsed.data : DEFAULT_DISCORD_TEMPLATE;
};

export function deliveryDto(d: DiscordDelivery & { rule?: { name: string } | null; destination?: { name: string; connection: { guildName: string } } | null }, full = false) {
  return {
    id: d.id,
    ruleId: d.ruleId,
    ruleName: d.rule?.name ?? (d.test ? "Test" : d.ruleId ? "" : "Fallback"),
    destinationId: d.destinationId,
    channelName: d.destination?.name ?? d.channelName,
    guildName: d.destination?.connection.guildName ?? "",
    eventId: d.eventId,
    eventType: d.eventType,
    test: d.test,
    status: d.status,
    attempts: d.attempts,
    nextAttemptAt: d.nextAttemptAt,
    error: d.error,
    errorCode: d.errorCode,
    responseStatus: d.responseStatus,
    messageId: d.messageId,
    sentAt: d.sentAt,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
    ...(full ? { message: d.message } : {}),
  };
}

/*
 * Posting to Discord. A DiscordDelivery row (one rule × one channel × one
 * event, unique, written by the dispatcher in the outbox transaction) is the
 * delivery's state; the `discord` queue's job only says "try now".
 *
 * Each attempt re-reads everything: the rule (switched off → canceled), the
 * channel and server (gone → failed), the event and its records (rendered
 * fresh), then the conditions (not met → filtered) and the template. Sends
 * carry a nonce with enforce_nonce, so a retry of a send that did reach
 * Discord returns the first message instead of posting twice.
 *
 * Failures: a 429 waits exactly as long as Discord says (not counted as an
 * attempt); network errors and Discord 5xx back off (DISCORD_RETRY_DELAYS_MS)
 * up to DISCORD_MAX_ATTEMPTS; everything else is permanent at once. A deleted
 * channel or a bot that lost access marks the destination, a removed bot the
 * server, and admins are notified once per such change. Nothing is retried
 * after a day. Failed deliveries can be retried by hand.
 */
@Injectable()
export class DiscordDeliveryService {
  private readonly log = new Logger("discord");

  constructor(
    private readonly prisma: PrismaService,
    private readonly platform: PlatformSettingsService,
    private readonly notifications: NotificationsService,
    private readonly queues: Queues,
    private readonly api: DiscordApi,
    private readonly context: DiscordContextService,
  ) {}

  async enqueue(workspaceId: string, deliveryId: string, delay = 0) {
    await this.queues.add("discord", "deliver", { workspaceId, deliveryId }, discordJobOptions(deliveryId, delay));
  }

  private async finish(workspaceId: string, id: string, status: string, error = "", errorCode = "", extra: Record<string, unknown> = {}): Promise<AttemptOutcome> {
    await this.prisma.db.discordDelivery.update({ where: { id, workspaceId }, data: { status, error: error.slice(0, 1000), errorCode, nextAttemptAt: null, ...extra } });
    return { status, retryInMs: null, error };
  }

  /** One try. Returns how long to wait before the next one, or null when the delivery is settled. */
  async attempt(workspaceId: string, deliveryId: string, now = new Date()): Promise<AttemptOutcome> {
    const d = await this.prisma.db.discordDelivery.findFirst({ where: { id: deliveryId, workspaceId } });
    if (!d) return { status: "missing", retryInMs: null, error: "" };
    if (d.status !== "pending") return { status: d.status, retryInMs: null, error: d.error };
    if (now.getTime() - d.createdAt.getTime() > DISCORD_GIVE_UP_AFTER_MS) return this.finish(workspaceId, d.id, "failed", `Gave up: not delivered within a day. Last error: ${d.error || "none"}`, d.errorCode || "expired");

    const rule = d.ruleId ? await this.prisma.db.discordRule.findFirst({ where: { id: d.ruleId, workspaceId } }) : null;
    if (d.ruleId && !d.test && (!rule || !rule.enabled)) return this.finish(workspaceId, d.id, "canceled", "The rule was switched off or deleted before this was posted.", "rule_off");
    const dest = d.destinationId ? await this.prisma.db.discordDestination.findFirst({ where: { id: d.destinationId, workspaceId }, include: { connection: true } }) : null;
    if (!dest) return this.finish(workspaceId, d.id, "failed", "The destination channel was removed from Growthdesk.", "destination_removed");
    if (dest.connection.status !== "connected") {
      return this.finish(workspaceId, d.id, "failed", dest.connection.status === "lost" ? "The bot is no longer in this Discord server." : "This Discord server was disconnected.", "server_disconnected");
    }
    if (dest.status === "missing") return this.finish(workspaceId, d.id, "failed", "The channel was deleted in Discord.", "unknown_channel");
    const app = await this.platform.discordApp();
    if (!app) return this.finish(workspaceId, d.id, "failed", "Discord is not set up on this installation (admin → Settings → Discord).", "not_configured");

    // What to send: a test carries its rendered message; an event is rendered now, from current data.
    let message: DiscordMessage;
    if (d.test) {
      if (!d.message) return this.finish(workspaceId, d.id, "failed", "This test has no message to send.", "no_message");
      message = d.message as unknown as DiscordMessage;
    } else {
      const event = d.eventId ? await this.prisma.db.domainEvent.findFirst({ where: { id: d.eventId, workspaceId } }) : null;
      if (!event) return this.finish(workspaceId, d.id, "failed", "The event no longer exists.", "event_missing");
      const ctx = await this.context.build(workspaceId, event);
      if (rule) {
        const check = evaluateDiscordConditions(conditionsOf(rule.conditions), ctx);
        if (!check.met) return this.finish(workspaceId, d.id, "filtered", `Condition not met: ${describeDiscordCondition(check.failed!)}`, "condition");
      }
      const template = rule?.templateId ? await this.prisma.db.discordTemplate.findFirst({ where: { id: rule.templateId, workspaceId } }) : null;
      const rendered = renderDiscordMessage(template ? templateBodyOf(template.body) : DEFAULT_DISCORD_TEMPLATE, ctx, now);
      if (rendered.skip) return this.finish(workspaceId, d.id, "skipped", rendered.skip, "template", { message: rendered.message as never });
      message = rendered.message;
    }

    const attempts = d.attempts + 1;
    try {
      const sent = await this.api.sendMessage(app.botToken, dest.channelId, { ...message, nonce: discordNonce(d.id), enforce_nonce: true });
      await this.prisma.db.discordDelivery.update({
        where: { id: d.id, workspaceId },
        data: { status: "sent", attempts, messageId: sent.id ?? "", sentAt: new Date(), error: "", errorCode: "", responseStatus: 200, nextAttemptAt: null, message: message as never, channelName: dest.name },
      });
      await this.prisma.db.discordDestination.update({ where: { id: dest.id, workspaceId }, data: { lastDeliveryAt: new Date(), ...(dest.status !== "active" ? { status: "active", lastError: "" } : {}) } });
      if (rule && !d.test) await this.prisma.db.discordRule.update({ where: { id: rule.id, workspaceId }, data: { lastMatchedAt: new Date() } });
      return { status: "sent", retryInMs: null, error: "" };
    } catch (e) {
      if (!(e instanceof DiscordApiError)) throw e;
      const error = explainDiscordError(e);
      const base = { responseStatus: e.status || null, message: message as never, channelName: dest.name };
      if (e.rateLimited) {
        const wait = Math.max(1000, e.retryAfterMs ?? 5000);
        await this.prisma.db.discordDelivery.update({ where: { id: d.id, workspaceId }, data: { ...base, error, errorCode: e.kind, nextAttemptAt: new Date(now.getTime() + wait) } });
        return { status: "pending", retryInMs: wait, error };
      }
      if (e.retryable && attempts < DISCORD_MAX_ATTEMPTS) {
        const wait = DISCORD_RETRY_DELAYS_MS[attempts - 1] ?? DISCORD_RETRY_DELAYS_MS.at(-1)!;
        await this.prisma.db.discordDelivery.update({ where: { id: d.id, workspaceId }, data: { ...base, attempts, error, errorCode: e.kind, nextAttemptAt: new Date(now.getTime() + wait) } });
        return { status: "pending", retryInMs: wait, error };
      }
      await this.prisma.db.discordDelivery.update({ where: { id: d.id, workspaceId }, data: { ...base, attempts } });
      if (e.unknownChannel) await this.markDestination(workspaceId, dest.id, dest.status, "missing", "The channel was deleted in Discord.", dest.name);
      else if (e.unknownGuild) await this.markLost(workspaceId, dest.connection.id, dest.connection.status, dest.connection.guildName);
      else if (e.forbidden) await this.markDestination(workspaceId, dest.id, dest.status, "forbidden", error, dest.name);
      else if (e.badToken) this.log.warn("Discord refused the bot token; check admin → Settings → Discord");
      return this.finish(workspaceId, d.id, "failed", error, e.kind);
    }
  }

  private async markDestination(workspaceId: string, id: string, from: string, to: "missing" | "forbidden", error: string, name: string) {
    await this.prisma.db.discordDestination.update({ where: { id, workspaceId }, data: { status: to, lastError: error } });
    if (from === to) return;
    await this.notifications.notifyRoles(workspaceId, ["owner", "admin"], {
      type: "discord.channel_unavailable",
      title: `Discord #${name} can no longer receive notifications`,
      body: to === "missing" ? "The channel was deleted in Discord. Choose another channel for the rules that used it." : `${error} Fix it in Discord, then refresh the server under Settings → Discord.`,
      link: `/w/${workspaceId}/settings/discord`,
      email: true,
    });
  }

  private async markLost(workspaceId: string, connectionId: string, from: string, guildName: string) {
    await this.prisma.db.discordConnection.update({ where: { id: connectionId, workspaceId }, data: { status: "lost", lastError: "The bot is no longer in this server (removed, or the server was deleted). Connect it again." } });
    if (from === "lost") return;
    await this.notifications.notifyRoles(workspaceId, ["owner", "admin"], {
      type: "discord.server_lost",
      title: `Discord: the bot is no longer in ${guildName}`,
      body: "Notifications to that server stopped. Connect it again under Settings → Discord.",
      link: `/w/${workspaceId}/settings/discord`,
      email: true,
    });
  }

  /** Pending deliveries whose job was lost (crash between commit and enqueue, or a failed job). A re-add is a no-op while the job exists. */
  async requeueStale(now = new Date(), limit = 500) {
    // Unscoped by necessity: a sweep across workspaces; each job carries its delivery's workspaceId.
    const stale = await this.prisma.unscoped.discordDelivery.findMany({
      where: { status: "pending", OR: [{ nextAttemptAt: { lt: new Date(now.getTime() - 60_000) } }, { nextAttemptAt: null, createdAt: { lt: new Date(now.getTime() - 2 * 60_000) } }] },
      select: { id: true, workspaceId: true },
      orderBy: { createdAt: "asc" },
      take: limit,
    });
    for (const d of stale) {
      const job = await this.queues.queue("discord").getJob(`discord-${d.id}`);
      const state = job ? await job.getState() : "missing";
      if (state === "missing" || state === "unknown" || state === "completed" || state === "failed") {
        if (job) await job.remove().catch(() => undefined);
        await this.enqueue(d.workspaceId, d.id);
      }
    }
    return stale.length;
  }

  // ─── The log ──────────────────────────────────────────────────────────────

  async list(ctx: RequestContext, q: z.infer<typeof DiscordDeliveriesQuery>) {
    const w = ws(ctx).id;
    const rows = await this.prisma.db.discordDelivery.findMany({
      where: {
        workspaceId: w,
        ...(q.status ? { status: q.status } : {}),
        ...(q.ruleId ? { ruleId: q.ruleId } : {}),
        ...(q.destinationId ? { destinationId: q.destinationId } : {}),
        ...(q.eventType ? { eventType: q.eventType } : {}),
        ...(q.cursor ? { id: { lt: q.cursor } } : {}),
      },
      include: { rule: { select: { name: true } }, destination: { select: { name: true, connection: { select: { guildName: true } } } } },
      orderBy: { id: "desc" },
      take: q.limit + 1,
    });
    const since = new Date(Date.now() - 24 * 3600_000);
    const counts = await this.prisma.db.discordDelivery.groupBy({ by: ["status"], where: { workspaceId: w, createdAt: { gte: since } }, _count: { _all: true } });
    return {
      items: rows.slice(0, q.limit).map((r) => deliveryDto(r)),
      nextCursor: rows.length > q.limit ? rows[q.limit - 1]!.id : null,
      last24h: Object.fromEntries(counts.map((c) => [c.status, c._count._all])) as Record<string, number>,
    };
  }

  async get(ctx: RequestContext, id: string) {
    const d = await this.prisma.db.discordDelivery.findFirst({
      where: { id, workspaceId: ws(ctx).id },
      include: { rule: { select: { name: true } }, destination: { select: { name: true, connection: { select: { guildName: true } } } } },
    });
    if (!d) throw notFound("That delivery");
    return deliveryDto(d, true);
  }

  /** Tries a failed (or held back) delivery again from the start. Sent ones are never re-sent. */
  async retry(ctx: RequestContext, id: string) {
    const w = ws(ctx).id;
    const d = await this.prisma.db.discordDelivery.findFirst({ where: { id, workspaceId: w } });
    if (!d) throw notFound("That delivery");
    if (!["failed", "skipped", "canceled"].includes(d.status)) throw conflict(d.status === "sent" ? "This was already posted." : "This delivery is still in progress.");
    // A retry is a fresh delivery as far as the give-up clock goes.
    const updated = await this.prisma.db.discordDelivery.update({ where: { id, workspaceId: w }, data: { status: "pending", attempts: 0, error: "", errorCode: "", nextAttemptAt: new Date(), createdAt: new Date() } });
    const job = await this.queues.queue("discord").getJob(`discord-${id}`);
    if (job) await job.remove().catch(() => undefined);
    await this.enqueue(w, id);
    return deliveryDto(updated);
  }

  /** Retries every failed delivery of the last day (after fixing a channel's permissions, say). */
  async retryFailed(ctx: RequestContext) {
    const w = ws(ctx).id;
    const failed = await this.prisma.db.discordDelivery.findMany({ where: { workspaceId: w, status: "failed", createdAt: { gte: new Date(Date.now() - DISCORD_GIVE_UP_AFTER_MS) } }, select: { id: true }, take: 500 });
    for (const f of failed) await this.retry(ctx, f.id);
    return { retried: failed.length };
  }
}
