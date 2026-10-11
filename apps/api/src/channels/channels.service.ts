import { Inject, Injectable, Logger } from "@nestjs/common";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { normalizePhone, type WhatsAppConnectInput, type TelegramConnectInput } from "@growthdesk/shared";
import type { z } from "zod";
import { APP_CONFIG, type AppConfig } from "../config/config.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { EntitlementsService } from "../billing/entitlements.service.js";
import { SuppressionService } from "../crm/suppression.service.js";
import { ActivityService } from "../crm/activity.service.js";
import { AuditService } from "../core/audit.service.js";
import { derivedKey, newToken, openJson, safeEqual, sealJson } from "../common/crypto.js";
import { badRequest, conflict, forbidden, notFound, unauthorized } from "../common/errors.js";
import { actorId, holds, ws, type RequestContext } from "../common/context.js";
import type { ChannelIntegration, Contact, Conversation } from "../generated/prisma/client.js";
import { twilioApi } from "../calls/twilio.js";
import {
  CHANNEL_CAPABILITIES,
  type ChatChannel,
  type ChatReachability,
  type ChatSender,
  type ChatSendInput,
  type ChatSendResult,
} from "./chat-sender.js";
import { ChatInboundService } from "./chat-inbound.service.js";
import {
  CUSTOMER_WINDOW_MS,
  type MetaStatus,
  type MetaWebhook,
  ProviderError,
  type TgUpdate,
  telegramApi,
  telegramBody,
  whatsappApi,
  whatsappBody,
  whatsappSignatureOk,
  windowRefusal,
} from "./providers.js";

/*
 * Chat channels: connecting WhatsApp (Meta Cloud API) and Telegram (Bot API)
 * integrations, receiving their webhooks / polling, and sending — the
 * ChatSender the campaign engine and the inbox use.
 *
 * Secrets (access token, app secret, verify token, bot token, webhook secret)
 * are sealed in ChannelIntegration.secretSealed and never returned, except the
 * WhatsApp verify token, which is shown to integrations.manage holders because
 * they must paste it into Meta's dashboard (it only proves a webhook
 * subscription; it grants no access to anything).
 *
 * Public webhook URLs go through the web app's /api proxy, like tracking links:
 *   ${PUBLIC_APP_URL}/api/webhooks/whatsapp/<webhookKey>  → API /v1/webhooks/whatsapp/<webhookKey>
 *   ${PUBLIC_APP_URL}/api/webhooks/telegram/<webhookKey>  → API /v1/webhooks/telegram/<webhookKey>
 */

type MetaSecrets = { accessToken: string; appSecret: string; verifyToken: string };
type TelegramSecrets = { botToken: string; secretToken: string };
type MetaConfig = { phoneNumberId?: string; businessAccountId?: string; displayPhoneNumber?: string; verifiedName?: string };
type TelegramConfig = { botId?: string; botUsername?: string; botName?: string; mode?: "webhook" | "polling"; lastUpdateId?: number };

const LABEL: Record<ChatChannel, string> = { whatsapp: "WhatsApp", telegram: "Telegram" };
const PROVIDER: Record<ChatChannel, string> = { whatsapp: "meta_cloud", telegram: "telegram_bot" };
const MAX_TEXT = 4096;
const SENT = new Set(["sent", "delivered", "read"]);
const isUnique = (e: unknown) => (e as { code?: string })?.code === "P2002";
const reasonOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

// ─── Telegram /start deep links ──────────────────────────────────────────────
// `https://t.me/<bot>?start=<token>`: the token names a contact (packed uuid)
// and is signed per workspace, so opening the link files the person's chat id
// against that existing contact instead of creating a new one.

const startKey = () => derivedKey("telegram-start/v1");
const startSig = (workspaceId: string, contactId: string) =>
  createHmac("sha256", startKey()).update(`${workspaceId}:${contactId}`).digest().subarray(0, 12).toString("base64url");

export function telegramStartToken(workspaceId: string, contactId: string): string {
  return `c${Buffer.from(contactId.replace(/-/g, ""), "hex").toString("base64url")}${startSig(workspaceId, contactId)}`;
}

export function readTelegramStartToken(workspaceId: string, token: string | undefined): string | null {
  if (!token || token.length !== 39 || !token.startsWith("c")) return null;
  const hex = Buffer.from(token.slice(1, 23), "base64url").toString("hex");
  if (hex.length !== 32) return null;
  const contactId = [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join("-");
  const given = Buffer.from(token.slice(23), "base64url");
  const expected = Buffer.from(startSig(workspaceId, contactId), "base64url");
  return given.length === expected.length && timingSafeEqual(given, expected) ? contactId : null;
}

@Injectable()
export class ChannelsService implements ChatSender {
  private readonly log = new Logger("channels");

  constructor(
    private readonly prisma: PrismaService,
    private readonly entitlements: EntitlementsService,
    private readonly suppression: SuppressionService,
    private readonly activity: ActivityService,
    private readonly audit: AuditService,
    private readonly inbound: ChatInboundService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  private publicUrl(path: string) {
    return `${this.config.PUBLIC_APP_URL.replace(/\/+$/, "")}/api/${path}`;
  }

  webhookUrl(i: Pick<ChannelIntegration, "provider" | "webhookKey">): string | null {
    if (i.provider === "meta_cloud") return this.publicUrl(`webhooks/whatsapp/${i.webhookKey}`);
    if (i.provider === "telegram_bot") return this.publicUrl(`webhooks/telegram/${i.webhookKey}`);
    return null;
  }

  // ─── Integrations ──────────────────────────────────────────────────────────

  dto(i: ChannelIntegration, canManage: boolean) {
    const config = (i.config ?? {}) as Record<string, unknown>;
    const details: Record<string, unknown> = {};
    for (const key of ["phoneNumberId", "businessAccountId", "displayPhoneNumber", "verifiedName", "botId", "botUsername", "botName", "mode", "accountSid", "callerId", "friendlyName"]) {
      if (config[key] !== undefined) details[key] = config[key];
    }
    const out: Record<string, unknown> = {
      id: i.id,
      channel: i.channel,
      provider: i.provider,
      name: i.name,
      status: i.status,
      lastError: i.lastError,
      lastEventAt: i.lastEventAt,
      externalId: i.externalId,
      details,
      capabilities: i.channel === "whatsapp" || i.channel === "telegram" ? CHANNEL_CAPABILITIES[i.channel] : null,
      webhookUrl: this.webhookUrl(i),
      createdAt: i.createdAt,
      updatedAt: i.updatedAt,
    };
    if (i.provider === "meta_cloud" && canManage) {
      out.verifyToken = openJson<MetaSecrets>(i.secretSealed)?.verifyToken ?? null;
    }
    if (i.provider === "telegram_bot") {
      out.setup =
        config.mode === "webhook"
          ? "Telegram delivers messages to the webhook URL; it was registered automatically."
          : "Polling mode: PUBLIC_APP_URL is not https, so the worker fetches new messages every 10 seconds.";
    }
    return out;
  }

  async list(ctx: RequestContext) {
    const w = ws(ctx);
    const rows = await this.prisma.db.channelIntegration.findMany({ where: { workspaceId: w.id, deletedAt: null }, orderBy: { createdAt: "asc" } });
    const canManage = holds(ctx, "integrations.manage");
    return rows.map((r) => this.dto(r, canManage));
  }

  async get(ctx: RequestContext, id: string) {
    const w = ws(ctx);
    const row = await this.prisma.db.channelIntegration.findFirst({ where: { id, workspaceId: w.id, deletedAt: null } });
    if (!row) throw notFound("That integration");
    return row;
  }

  /** Whoever already holds (provider, externalId) — a number or bot belongs to one workspace. */
  private async holder(provider: string, externalId: string) {
    // Unscoped by necessity: (provider, externalId) is unique across all workspaces, so the check must see every tenant.
    return this.prisma.unscoped.channelIntegration.findUnique({ where: { provider_externalId: { provider, externalId } } });
  }

  async connectWhatsApp(ctx: RequestContext, input: z.infer<typeof WhatsAppConnectInput>) {
    const w = ws(ctx);
    await this.entitlements.assertFeature(w.billingAccountId, "whatsapp");
    await this.entitlements.assertFullAccess(w.billingAccountId, "Connecting WhatsApp");
    let info: { displayPhoneNumber: string; verifiedName: string };
    try {
      info = await whatsappApi.verify(input.phoneNumberId, input.accessToken);
    } catch (e) {
      throw badRequest(`Meta did not accept those details: ${reasonOf(e)}`);
    }
    const held = await this.holder("meta_cloud", input.phoneNumberId);
    if (held && held.workspaceId !== w.id) throw conflict("This WhatsApp number is already connected to another workspace. Disconnect it there first.");
    const config: MetaConfig = {
      phoneNumberId: input.phoneNumberId,
      businessAccountId: input.businessAccountId ?? "",
      displayPhoneNumber: info.displayPhoneNumber,
      verifiedName: info.verifiedName,
    };
    const name = input.name || info.verifiedName || info.displayPhoneNumber || "WhatsApp";
    let row: ChannelIntegration;
    if (held) {
      // Reconnecting the same number: rotate the credentials, keep the webhook URL and verify token Meta already has.
      const verifyToken = openJson<MetaSecrets>(held.secretSealed)?.verifyToken ?? newToken(24);
      row = await this.prisma.db.channelIntegration.update({
        where: { id: held.id, workspaceId: w.id },
        data: { name, status: "connected", lastError: "", config, secretSealed: sealJson({ accessToken: input.accessToken, appSecret: input.appSecret, verifyToken } satisfies MetaSecrets) },
      });
    } else {
      await this.entitlements.assertCapacity(w.billingAccountId, "channelIntegrations");
      try {
        row = await this.prisma.db.channelIntegration.create({
          data: {
            workspaceId: w.id,
            channel: "whatsapp",
            provider: "meta_cloud",
            name,
            status: "connected",
            config,
            externalId: input.phoneNumberId,
            webhookKey: newToken(24),
            secretSealed: sealJson({ accessToken: input.accessToken, appSecret: input.appSecret, verifyToken: newToken(24) } satisfies MetaSecrets),
            createdById: actorId(ctx),
          },
        });
      } catch (e) {
        if (isUnique(e)) throw conflict("This WhatsApp number is already connected to a workspace.");
        throw e;
      }
    }
    await this.audit.record(ctx, { action: "integration.connected", targetType: "channel_integration", targetId: row.id, metadata: { provider: "meta_cloud", phoneNumberId: input.phoneNumberId } });
    return this.dto(row, true);
  }

  async connectTelegram(ctx: RequestContext, input: z.infer<typeof TelegramConnectInput>) {
    const w = ws(ctx);
    await this.entitlements.assertFeature(w.billingAccountId, "telegram");
    await this.entitlements.assertFullAccess(w.billingAccountId, "Connecting Telegram");
    let me;
    try {
      me = await telegramApi.getMe(input.botToken);
    } catch (e) {
      throw badRequest(`Telegram did not accept that bot token: ${reasonOf(e)}`);
    }
    const externalId = String(me.id);
    const held = await this.holder("telegram_bot", externalId);
    if (held && held.workspaceId !== w.id) throw conflict("This Telegram bot is already connected to another workspace. Disconnect it there first.");
    if (!held) await this.entitlements.assertCapacity(w.billingAccountId, "channelIntegrations");

    const webhookKey = held?.webhookKey ?? newToken(24);
    const secrets: TelegramSecrets = { botToken: input.botToken, secretToken: newToken(32) };
    const mode = await this.registerTelegramDelivery(input.botToken, webhookKey, secrets.secretToken);
    const previous = (held?.config ?? {}) as TelegramConfig;
    const config: TelegramConfig = {
      botId: externalId,
      botUsername: me.username ?? "",
      botName: me.first_name ?? "",
      mode,
      ...(previous.lastUpdateId !== undefined ? { lastUpdateId: previous.lastUpdateId } : {}),
    };
    const name = input.name || (me.username ? `@${me.username}` : "Telegram bot");
    let row: ChannelIntegration;
    if (held) {
      row = await this.prisma.db.channelIntegration.update({
        where: { id: held.id, workspaceId: w.id },
        data: { name, status: "connected", lastError: "", config, secretSealed: sealJson(secrets) },
      });
    } else {
      try {
        row = await this.prisma.db.channelIntegration.create({
          data: {
            workspaceId: w.id,
            channel: "telegram",
            provider: "telegram_bot",
            name,
            status: "connected",
            config,
            externalId,
            webhookKey,
            secretSealed: sealJson(secrets),
            createdById: actorId(ctx),
          },
        });
      } catch (e) {
        if (isUnique(e)) throw conflict("This Telegram bot is already connected to a workspace.");
        throw e;
      }
    }
    await this.audit.record(ctx, { action: "integration.connected", targetType: "channel_integration", targetId: row.id, metadata: { provider: "telegram_bot", botId: externalId, mode } });
    return this.dto(row, true);
  }

  /**
   * Webhook when the app is publicly reachable over https (Telegram requires
   * it), otherwise polling (local development): the webhook is removed so
   * getUpdates is allowed.
   */
  private async registerTelegramDelivery(botToken: string, webhookKey: string, secretToken: string): Promise<"webhook" | "polling"> {
    const https = this.config.PUBLIC_APP_URL.startsWith("https://");
    try {
      if (https) {
        await telegramApi.setWebhook(botToken, this.publicUrl(`webhooks/telegram/${webhookKey}`), secretToken);
        return "webhook";
      }
      await telegramApi.deleteWebhook(botToken);
      return "polling";
    } catch (e) {
      throw badRequest(`Telegram refused the ${https ? "webhook" : "polling"} setup: ${reasonOf(e)}`);
    }
  }

  /** Re-checks an integration's credentials with its provider and records the result. */
  async verify(ctx: RequestContext, id: string) {
    const w = ws(ctx);
    const row = await this.get(ctx, id);
    let lastError = "";
    const config = { ...((row.config ?? {}) as Record<string, unknown>) };
    let secretSealed = row.secretSealed;
    try {
      if (row.provider === "meta_cloud") {
        const s = openJson<MetaSecrets>(row.secretSealed);
        if (!s) throw new Error("The stored credentials could not be read — connect the number again.");
        const info = await whatsappApi.verify(String(config.phoneNumberId ?? row.externalId), s.accessToken);
        config.displayPhoneNumber = info.displayPhoneNumber;
        config.verifiedName = info.verifiedName;
      } else if (row.provider === "telegram_bot") {
        const s = openJson<TelegramSecrets>(row.secretSealed);
        if (!s) throw new Error("The stored bot token could not be read — connect the bot again.");
        const me = await telegramApi.getMe(s.botToken);
        config.botUsername = me.username ?? config.botUsername;
        const secretToken = newToken(32);
        config.mode = await this.registerTelegramDelivery(s.botToken, row.webhookKey, secretToken);
        secretSealed = sealJson({ botToken: s.botToken, secretToken } satisfies TelegramSecrets);
      } else if (row.provider === "twilio") {
        const s = openJson<{ authToken: string }>(row.secretSealed);
        if (!s) throw new Error("The stored auth token could not be read — connect Twilio again.");
        const acct = await twilioApi.account(String(config.accountSid ?? row.externalId), s.authToken);
        if (acct.status && acct.status !== "active") throw new Error(`The Twilio account is ${acct.status}`);
        config.friendlyName = acct.friendlyName;
      }
    } catch (e) {
      lastError = reasonOf(e);
    }
    const updated = await this.prisma.db.channelIntegration.update({
      where: { id: row.id, workspaceId: w.id },
      data: { status: lastError ? "error" : "connected", lastError: lastError.slice(0, 500), config: config as never, secretSealed },
    });
    return this.dto(updated, holds(ctx, "integrations.manage"));
  }

  /** Soft delete. The provider id is released (so it can be connected again) and the credentials are dropped. */
  async remove(ctx: RequestContext, id: string) {
    const w = ws(ctx);
    const row = await this.get(ctx, id);
    if (row.provider === "telegram_bot") {
      const s = openJson<TelegramSecrets>(row.secretSealed);
      if (s) await telegramApi.deleteWebhook(s.botToken).catch((e) => this.log.warn(`deleteWebhook failed: ${reasonOf(e)}`));
    }
    await this.prisma.db.channelIntegration.update({
      where: { id: row.id, workspaceId: w.id },
      data: {
        deletedAt: new Date(),
        status: "disconnected",
        externalId: null,
        secretSealed: null,
        config: { ...((row.config ?? {}) as object), formerExternalId: row.externalId } as never,
      },
    });
    await this.audit.record(ctx, { action: "integration.disconnected", targetType: "channel_integration", targetId: row.id, metadata: { provider: row.provider } });
    return { ok: true };
  }

  /** A t.me deep link that, when the contact opens it and presses Start, links their Telegram chat to this contact. */
  async telegramStartLink(ctx: RequestContext, integrationId: string, contactId: string) {
    const w = ws(ctx);
    const row = await this.get(ctx, integrationId);
    if (row.provider !== "telegram_bot") throw badRequest("Start links are for Telegram bots");
    const contact = await this.prisma.db.contact.findFirst({ where: { id: contactId, workspaceId: w.id, deletedAt: null }, select: { id: true } });
    if (!contact) throw notFound("That contact");
    const username = ((row.config ?? {}) as TelegramConfig).botUsername;
    if (!username) throw conflict("The bot's username is unknown — verify the integration first.");
    const token = telegramStartToken(w.id, contact.id);
    return { url: `https://t.me/${username}?start=${token}`, token };
  }

  // ─── Sending (ChatSender) ──────────────────────────────────────────────────

  private async integrationFor(workspaceId: string, channel: ChatChannel, preferredId?: string | null) {
    if (preferredId) {
      return this.prisma.db.channelIntegration.findFirst({ where: { id: preferredId, workspaceId, channel, deletedAt: null } });
    }
    return this.prisma.db.channelIntegration.findFirst({
      where: { workspaceId, channel, deletedAt: null, status: "connected" },
      orderBy: { createdAt: "asc" },
    });
  }

  /** WhatsApp: the contact's number as a wa_id (digits only) — the WhatsApp identifier first, else the phone. */
  private async whatsappPeer(workspaceId: string, contact: Pick<Contact, "id" | "phone">): Promise<string | null> {
    const ident = await this.prisma.db.contactIdentifier.findFirst({
      where: { workspaceId, contactId: contact.id, kind: "whatsapp" },
      orderBy: [{ isPrimary: "desc" }, { createdAt: "desc" }],
    });
    const phone = ident?.value ?? contact.phone ?? null;
    const e164 = normalizePhone(phone);
    return e164 ? e164.replace(/\D/g, "") : null;
  }

  private async telegramPeer(workspaceId: string, contactId: string): Promise<string | null> {
    const ident = await this.prisma.db.contactIdentifier.findFirst({
      where: { workspaceId, contactId, kind: "telegram" },
      orderBy: [{ isPrimary: "desc" }, { createdAt: "desc" }],
    });
    return ident?.value ?? null;
  }

  /**
   * Where a send would go: the integration, the provider address and the
   * existing conversation (for the WhatsApp window), or why it cannot go.
   */
  private async target(
    workspaceId: string,
    channel: ChatChannel,
    contact: Pick<Contact, "id" | "phone" | "fullName"> | null,
    given: Conversation | null,
    integrationId: string | null | undefined,
  ): Promise<{ integration: ChannelIntegration; peer: string; conversation: Conversation | null } | { reason: string }> {
    const db = this.prisma.db;
    let peer = given?.peer || null;
    let conversation = given;
    if (!peer && contact) peer = channel === "whatsapp" ? await this.whatsappPeer(workspaceId, contact) : await this.telegramPeer(workspaceId, contact.id);
    if (!peer) {
      const who = contact?.fullName || "This contact";
      return {
        reason:
          channel === "whatsapp"
            ? `${who} has no phone number to reach on WhatsApp.`
            : `${who} has not started a chat with your Telegram bot. Telegram bots can only message people who opened the bot and pressed Start — send them the bot's start link.`,
      };
    }
    // The conversation already held with this person decides the integration (Telegram: the bot they actually started).
    if (!conversation) {
      conversation = await db.conversation.findFirst({
        where: { workspaceId, channel, peer, ...(integrationId ? { channelIntegrationId: integrationId } : {}), integration: { deletedAt: null } },
        orderBy: { lastInboundAt: { sort: "desc", nulls: "last" } },
      });
    }
    const integration = await this.integrationFor(workspaceId, channel, conversation?.channelIntegrationId ?? integrationId);
    if (!integration) return { reason: `${LABEL[channel]} is not connected in this workspace.` };
    if (integration.status !== "connected") {
      return { reason: `The ${LABEL[channel]} integration "${integration.name}" is not connected${integration.lastError ? `: ${integration.lastError}` : ""}.` };
    }
    if (conversation && conversation.channelIntegrationId !== integration.id) conversation = null;
    if (!conversation) {
      conversation = await db.conversation.findUnique({ where: { workspaceId_externalKey: { workspaceId, externalKey: `${integration.id}:${peer}` } } });
    }
    return { integration, peer, conversation };
  }

  async reachability(workspaceId: string, channel: ChatChannel, contactId: string): Promise<ChatReachability> {
    const capabilities = CHANNEL_CAPABILITIES[channel];
    const no = (reason: string, extra: Partial<ChatReachability> = {}): ChatReachability => ({ reachable: false, reason, capabilities, ...extra });
    const contact = await this.prisma.db.contact.findFirst({ where: { id: contactId, workspaceId } });
    if (!contact || contact.deletedAt) return no("The contact no longer exists.");
    if (contact.doNotContact || contact.unsubscribedAt) return no("The contact has opted out.");
    const suppressed = await this.suppression.check(workspaceId, { email: contact.email, phone: contact.phone });
    if (suppressed) return no(suppressed);
    const t = await this.target(workspaceId, channel, contact, null, null);
    if ("reason" in t) return no(t.reason);
    if (channel === "telegram") {
      const bot = ((t.integration.config ?? {}) as TelegramConfig).botUsername;
      return { reachable: true, reason: `They have started a chat with ${bot ? `@${bot}` : "your bot"}.`, capabilities, integrationId: t.integration.id };
    }
    if (await this.suppression.check(workspaceId, { phone: `+${t.peer}` })) return no(`+${t.peer} is on the do-not-contact list.`);
    const last = t.conversation?.lastInboundAt ?? null;
    const refusal = windowRefusal(last);
    return {
      reachable: true,
      reason: refusal || "Inside the 24-hour window: free-form messages are allowed.",
      capabilities,
      integrationId: t.integration.id,
      freeFormAllowed: !refusal,
      freeFormUntil: refusal || !last ? null : new Date(last.getTime() + CUSTOMER_WINDOW_MS),
    };
  }

  async send(input: ChatSendInput): Promise<ChatSendResult> {
    return this.deliver(input);
  }

  /**
   * The one chat send path. `contactId` may be null when replying in a
   * conversation that has no contact (filed while the contact limit was full).
   */
  async deliver(input: Omit<ChatSendInput, "contactId"> & { contactId: string | null }): Promise<ChatSendResult> {
    const { workspaceId, channel } = input;
    const db = this.prisma.db;
    const body = (input.body ?? "").trim();

    // Idempotency, as in OutboundEmailService: a retried write-ahead id never sends twice.
    if (input.messageRowId) {
      const prior = await db.message.findFirst({ where: { id: input.messageRowId, workspaceId } });
      if (prior) {
        if (SENT.has(prior.status)) return { status: "sent", messageRowId: prior.id, conversationId: prior.conversationId };
        if (prior.status === "failed") return { status: "failed", reason: prior.error || "This message failed earlier.", messageRowId: prior.id };
        await db.message.update({
          where: { id: prior.id, workspaceId },
          data: { status: "uncertain", error: prior.error || "An earlier attempt was not confirmed. It may have been delivered, so it was not sent again." },
        });
        return { status: "uncertain", reason: "An earlier attempt may have been delivered, so it was not sent again.", messageRowId: prior.id };
      }
    }

    const workspace = await db.workspace.findUnique({ where: { id: workspaceId }, select: { status: true, billingAccountId: true } });
    if (!workspace || workspace.status !== "active") return { status: "blocked", reason: "The workspace is suspended." };
    // The channel must be in the plan for every send, including replies from the inbox. (Campaign steps also
    // wait on the kill switch and on restricted accounts before they get here: EngineService.chatStep.)
    const ent = await this.entitlements.forAccount(workspace.billingAccountId);
    if (!ent.features[channel]) return { status: "unavailable", reason: `${LABEL[channel]} is not included in the ${ent.effectivePlan.name} plan.` };
    if (!body && !input.template) return { status: "failed", reason: "The message is empty." };
    if (body.length > MAX_TEXT) return { status: "failed", reason: `${LABEL[channel]} messages are limited to ${MAX_TEXT} characters.` };

    const given = input.conversationId ? await db.conversation.findFirst({ where: { id: input.conversationId, workspaceId, channel } }) : null;
    if (input.conversationId && !given) return { status: "unavailable", reason: `That conversation is not a ${LABEL[channel]} conversation in this workspace.` };
    const contactId = input.contactId ?? given?.contactId ?? null;
    let contact: Contact | null = null;
    if (contactId) {
      contact = await db.contact.findFirst({ where: { id: contactId, workspaceId } });
      if (!contact || contact.deletedAt) return { status: "blocked", reason: "The contact no longer exists." };
      if (contact.doNotContact || contact.unsubscribedAt) return { status: "blocked", reason: "The contact has opted out." };
    } else if (!given) {
      return { status: "unavailable", reason: "There is no contact or conversation to send to." };
    }

    const t = await this.target(workspaceId, channel, contact, given, input.integrationId);
    if ("reason" in t) return { status: "unavailable", reason: t.reason };
    const { integration, peer } = t;

    // The do-not-contact list, re-checked at the moment of sending.
    const blocked = await this.suppression.check(workspaceId, { email: contact?.email, phone: channel === "whatsapp" ? `+${peer}` : contact?.phone });
    if (blocked) return { status: "blocked", reason: blocked };
    if (channel === "whatsapp" && contact?.phone) {
      const alsoBlocked = await this.suppression.check(workspaceId, { phone: contact.phone });
      if (alsoBlocked) return { status: "blocked", reason: alsoBlocked };
    }

    const template = channel === "whatsapp" ? (input.template ?? null) : null;
    if (channel === "whatsapp" && !template) {
      const refusal = windowRefusal(t.conversation?.lastInboundAt ?? null);
      if (refusal) return { status: "unavailable", reason: refusal };
    }

    const config = (integration.config ?? {}) as MetaConfig & TelegramConfig;
    const ours = channel === "whatsapp" ? (config.displayPhoneNumber ?? "") : config.botUsername ? `@${config.botUsername}` : "";
    const handle = channel === "whatsapp" ? `+${peer}` : (t.conversation?.handle ?? contact?.fullName ?? peer);
    const text = body || `[template: ${template?.name}]`;
    const now = new Date();
    const messageRowId = input.messageRowId ?? randomUUID();
    const externalKey = `${integration.id}:${peer}`;

    // Write-ahead: the row exists before the provider is called.
    let conversationId: string;
    try {
      conversationId = await db.$transaction(async (tx) => {
        const convo = await tx.conversation.upsert({
          where: { workspaceId_externalKey: { workspaceId, externalKey } },
          create: {
            workspaceId,
            channel,
            contactId,
            channelIntegrationId: integration.id,
            externalKey,
            peer,
            handle,
            displayName: contact?.fullName || handle,
            campaignId: input.campaignId ?? null,
            assigneeId: input.authorId ?? null,
          },
          update: {},
        });
        await tx.message.create({
          data: {
            id: messageRowId,
            workspaceId,
            conversationId: convo.id,
            channel,
            direction: "outbound",
            status: "sending",
            fromAddress: ours,
            toAddress: handle,
            bodyText: text,
            authorId: input.authorId ?? null,
            enrollmentId: input.enrollmentId ?? null,
            campaignId: input.campaignId ?? null,
            channelIntegrationId: integration.id,
            templateId: input.templateId ?? null,
            attempts: 1,
          },
        });
        return convo.id;
      });
    } catch (e) {
      // Another attempt under the same id is in flight: its outcome is not ours to know, so never send it again from here.
      if (isUnique(e) && input.messageRowId) return { status: "uncertain", reason: "This message is already being sent.", messageRowId };
      throw e;
    }

    let providerMessageId: string;
    try {
      if (channel === "whatsapp") {
        const s = openJson<MetaSecrets>(integration.secretSealed);
        if (!s) throw new ProviderError("The stored WhatsApp credentials could not be read — connect the number again.", 401, "no");
        const phoneNumberId = config.phoneNumberId ?? integration.externalId ?? "";
        const r = template ? await whatsappApi.sendTemplate(phoneNumberId, s.accessToken, peer, template) : await whatsappApi.sendText(phoneNumberId, s.accessToken, peer, body);
        providerMessageId = `wa:${r.wamid || messageRowId}`;
      } else {
        const s = openJson<TelegramSecrets>(integration.secretSealed);
        if (!s) throw new ProviderError("The stored bot token could not be read — connect the bot again.", 401, "no");
        const r = await telegramApi.sendMessage(s.botToken, peer, body);
        providerMessageId = `tg:${integration.externalId}:${peer}:${r.message_id}`;
      }
    } catch (e) {
      const err = e instanceof ProviderError ? e : new ProviderError(reasonOf(e), 0, "unknown");
      if (err.delivery === "unknown") {
        await db.message.update({ where: { id: messageRowId, workspaceId }, data: { status: "uncertain", error: `Unconfirmed: ${err.message}`.slice(0, 1000) } });
        return { status: "uncertain", reason: `${err.message}. It may have been delivered, so it will not be sent again automatically.`, messageRowId };
      }
      await db.message.update({ where: { id: messageRowId, workspaceId }, data: { status: "failed", error: err.message.slice(0, 1000) } });
      await db.messageEvent.create({ data: { workspaceId, messageId: messageRowId, type: "failed", data: { error: err.message.slice(0, 500) } } });
      // Credentials the provider no longer accepts put the integration in error; a refusal about one recipient does not.
      const credentialsBad = err.status === 401 || err.code === 190 || (channel === "telegram" && err.status === 404);
      await db.channelIntegration.updateMany({
        where: { id: integration.id, workspaceId },
        data: credentialsBad ? { status: "error", lastError: err.message.slice(0, 500) } : { lastError: err.message.slice(0, 500) },
      });
      return { status: "failed", reason: err.message, messageRowId };
    }

    await db.$transaction(async (tx) => {
      await tx.message.update({ where: { id: messageRowId, workspaceId }, data: { status: "sent", sentAt: now, providerMessageId, error: "" } });
      await tx.messageEvent.create({ data: { workspaceId, messageId: messageRowId, type: "sent", occurredAt: now } });
      await tx.conversation.update({ where: { id: conversationId, workspaceId }, data: { lastMessageAt: now, lastOutboundAt: now } });
      if (contactId) {
        await tx.contact.updateMany({ where: { id: contactId, workspaceId }, data: { lastContactedAt: now } });
        await tx.contact.updateMany({ where: { id: contactId, workspaceId, status: "new" }, data: { status: "contacted" } });
      }
      if (integration.lastError) await tx.channelIntegration.updateMany({ where: { id: integration.id, workspaceId }, data: { lastError: "" } });
    });
    if (contactId) {
      await this.activity.log({
        workspaceId,
        contactId,
        actorId: input.authorId,
        type: `${channel}.sent`,
        summary: template ? `${LABEL[channel]} template sent: ${template.name}` : `${LABEL[channel]} message sent: ${body.slice(0, 120)}`,
        data: { messageId: messageRowId, conversationId, campaignId: input.campaignId ?? null },
      });
    }
    return { status: "sent", messageRowId, conversationId };
  }

  // ─── Webhooks ──────────────────────────────────────────────────────────────

  private async byWebhookKey(webhookKey: string, provider: string) {
    if (!webhookKey || webhookKey.length > 100) return null;
    // Unscoped by necessity: a webhook carries no session; the unguessable key in its URL is what names the integration (and so the workspace).
    const row = await this.prisma.unscoped.channelIntegration.findUnique({ where: { webhookKey } });
    return row && !row.deletedAt && row.provider === provider ? row : null;
  }

  /** Meta's subscription handshake: echo hub.challenge when the verify token matches. */
  async whatsappHandshake(webhookKey: string, mode: unknown, token: unknown, challenge: unknown): Promise<string> {
    const row = await this.byWebhookKey(webhookKey, "meta_cloud");
    if (!row) throw notFound("That webhook");
    const held = openJson<MetaSecrets>(row.secretSealed)?.verifyToken;
    if (mode !== "subscribe" || typeof token !== "string" || !held || !safeEqual(token, held)) throw forbidden("The verify token does not match.");
    if (typeof challenge !== "string" || !/^[\w.-]{1,256}$/.test(challenge)) throw badRequest("Missing hub.challenge");
    return challenge;
  }

  async whatsappWebhook(webhookKey: string, raw: Buffer | undefined, signature: string | undefined) {
    const row = await this.byWebhookKey(webhookKey, "meta_cloud");
    if (!row) throw notFound("That webhook");
    const secrets = openJson<MetaSecrets>(row.secretSealed);
    if (!raw || !secrets?.appSecret || !whatsappSignatureOk(secrets.appSecret, raw, signature)) {
      this.log.warn(`${row.workspaceId}: a WhatsApp webhook failed its signature`);
      throw unauthorized("Invalid signature");
    }
    let payload: MetaWebhook;
    try {
      payload = JSON.parse(raw.toString("utf8")) as MetaWebhook;
    } catch {
      return { received: 0, statuses: 0 };
    }
    const config = (row.config ?? {}) as MetaConfig;
    let received = 0;
    let statuses = 0;
    for (const entry of payload.entry ?? []) {
      for (const change of entry.changes ?? []) {
        if (change.field && change.field !== "messages") continue;
        const value = change.value;
        // A delivery for another number on the same Meta app is not ours to file.
        if (!value || value.metadata?.phone_number_id !== row.externalId) continue;
        const names = new Map((value.contacts ?? []).map((c) => [c.wa_id ?? "", c.profile?.name ?? ""]));
        for (const m of value.messages ?? []) {
          const from = (m.from ?? "").replace(/\D/g, "");
          const body = whatsappBody(m);
          if (!from || !m.id || body === null) continue;
          const phone = normalizePhone(`+${from}`);
          const res = await this.inbound.file({
            workspaceId: row.workspaceId,
            integrationId: row.id,
            channel: "whatsapp",
            peer: from,
            handle: `+${from}`,
            displayName: names.get(m.from ?? "") || names.get(from) || "",
            body,
            providerMessageId: `wa:${m.id}`,
            sentAt: m.timestamp ? new Date(Number(m.timestamp) * 1000) : new Date(),
            identifier: { kind: "whatsapp", value: phone ?? `+${from}` },
            phone,
            toAddress: value.metadata?.display_phone_number ?? config.displayPhoneNumber ?? "",
          });
          if (res.outcome === "filed") received += 1;
        }
        for (const s of value.statuses ?? []) {
          if (await this.applyWhatsAppStatus(row.workspaceId, s)) statuses += 1;
        }
      }
    }
    await this.prisma.db.channelIntegration.updateMany({ where: { id: row.id, workspaceId: row.workspaceId }, data: { lastEventAt: new Date() } });
    return { received, statuses };
  }

  /** sent / delivered / read / failed receipts. Idempotent per (message, status); never moves a message backwards. */
  private async applyWhatsAppStatus(workspaceId: string, s: MetaStatus): Promise<boolean> {
    const db = this.prisma.db;
    const type = s.status ?? "";
    if (!s.id || !["sent", "delivered", "read", "failed"].includes(type)) return false;
    const message = await db.message.findFirst({ where: { workspaceId, channel: "whatsapp", providerMessageId: `wa:${s.id}` } });
    if (!message) return false;
    const at = s.timestamp ? new Date(Number(s.timestamp) * 1000) : new Date();
    const error = s.errors?.[0] ? [s.errors[0].title, s.errors[0].error_data?.details ?? s.errors[0].message].filter(Boolean).join(": ") : "";
    try {
      await db.messageEvent.create({
        data: { workspaceId, messageId: message.id, type, providerEventId: `wa:${s.id}:${type}`, occurredAt: at, data: (s.errors ? { errors: s.errors } : {}) as never },
      });
    } catch (e) {
      if (isUnique(e)) return false;
      throw e;
    }
    const rank: Record<string, number> = { queued: 0, sending: 0, uncertain: 0, failed: 0, sent: 1, delivered: 2, read: 3 };
    const current = rank[message.status] ?? 0;
    const data: Record<string, unknown> = {};
    if (type === "sent") {
      if (!message.sentAt) data.sentAt = at;
      if (current < 1 && message.status !== "failed") data.status = "sent";
    } else if (type === "delivered") {
      if (!message.deliveredAt) data.deliveredAt = at;
      if (current < 2) data.status = "delivered";
    } else if (type === "read") {
      if (!message.deliveredAt) data.deliveredAt = at;
      if (!message.readAt) data.readAt = at;
      if (current < 3) data.status = "read";
    } else if (type === "failed") {
      if (current < 2) {
        data.status = "failed";
        data.error = (error || "WhatsApp could not deliver this message").slice(0, 1000);
      }
    }
    if (Object.keys(data).length) await db.message.update({ where: { id: message.id, workspaceId }, data });
    return true;
  }

  async telegramWebhook(webhookKey: string, secretHeader: string | undefined, update: unknown) {
    const row = await this.byWebhookKey(webhookKey, "telegram_bot");
    if (!row) throw notFound("That webhook");
    const secrets = openJson<TelegramSecrets>(row.secretSealed);
    if (!secrets?.secretToken || !secretHeader || !safeEqual(secretHeader, secrets.secretToken)) {
      this.log.warn(`${row.workspaceId}: a Telegram webhook carried the wrong secret token`);
      throw unauthorized("Invalid secret token");
    }
    const filed = await this.handleTelegramUpdate(row, update as TgUpdate);
    return { received: filed ? 1 : 0 };
  }

  /** One Bot API update: only messages from people in private chats. */
  async handleTelegramUpdate(row: ChannelIntegration, update: TgUpdate | null | undefined): Promise<boolean> {
    const m = update?.message;
    if (!m || !m.chat || m.chat.type !== "private" || !m.from || m.from.is_bot) return false;
    const chatId = String(m.chat.id);
    const text = telegramBody(m);
    const startMatch = /^\/start(?:@\w+)?(?:\s+(\S+))?\s*$/.exec(m.text ?? "");
    const name = [m.from.first_name, m.from.last_name].filter(Boolean).join(" ").trim();
    const username = m.from.username ?? m.chat.username;
    const config = (row.config ?? {}) as TelegramConfig;
    const res = await this.inbound.file({
      workspaceId: row.workspaceId,
      integrationId: row.id,
      channel: "telegram",
      peer: chatId,
      handle: username ? `@${username}` : name || `tg:${chatId}`,
      displayName: name || (username ? `@${username}` : ""),
      body: startMatch ? "/start" : text,
      providerMessageId: `tg:${row.externalId}:${chatId}:${m.message_id}`,
      sentAt: m.date ? new Date(m.date * 1000) : new Date(),
      identifier: { kind: "telegram", value: chatId },
      toAddress: config.botUsername ? `@${config.botUsername}` : "",
      start: startMatch ? { contactId: readTelegramStartToken(row.workspaceId, startMatch[1]) } : null,
    });
    return res.outcome === "filed";
  }

  /**
   * Polling mode (no public https URL): fetch each polling bot's new updates.
   * Run by the worker every 10 seconds; the offset is persisted after every
   * update, and message dedupe makes a replayed update harmless.
   */
  async pollTelegram(): Promise<{ bots: number; updates: number }> {
    // Unscoped by necessity: the scheduler discovers polling-mode bots across all workspaces; each update is then filed within its own workspace.
    const bots = await this.prisma.unscoped.channelIntegration.findMany({ where: { provider: "telegram_bot", deletedAt: null, status: "connected" } });
    let updates = 0;
    let polled = 0;
    for (const bot of bots) {
      const config = (bot.config ?? {}) as TelegramConfig;
      if (config.mode !== "polling") continue;
      polled += 1;
      updates += await this.pollOne(bot).catch((e) => {
        this.log.warn(`${bot.workspaceId}: Telegram poll failed: ${reasonOf(e)}`);
        return 0;
      });
    }
    return { bots: polled, updates };
  }

  async pollOne(bot: ChannelIntegration): Promise<number> {
    const secrets = openJson<TelegramSecrets>(bot.secretSealed);
    if (!secrets) return 0;
    const config = (bot.config ?? {}) as TelegramConfig;
    let batch: TgUpdate[];
    try {
      batch = await telegramApi.getUpdates(secrets.botToken, config.lastUpdateId !== undefined ? config.lastUpdateId + 1 : undefined);
    } catch (e) {
      const err = e instanceof ProviderError ? e : null;
      await this.prisma.db.channelIntegration.updateMany({
        where: { id: bot.id, workspaceId: bot.workspaceId },
        data: { lastError: `Polling failed: ${reasonOf(e)}`.slice(0, 500), ...(err?.status === 401 || err?.status === 404 ? { status: "error" } : {}) },
      });
      return 0;
    }
    let count = 0;
    let lastUpdateId = config.lastUpdateId;
    for (const update of [...batch].sort((a, b) => a.update_id - b.update_id)) {
      if (await this.handleTelegramUpdate(bot, update)) count += 1;
      lastUpdateId = update.update_id;
      await this.prisma.db.channelIntegration.updateMany({
        where: { id: bot.id, workspaceId: bot.workspaceId },
        data: { config: { ...config, lastUpdateId } as never, ...(bot.lastError ? { lastError: "" } : {}) },
      });
    }
    return count;
  }
}
