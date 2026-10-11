/*
 * Shapes of the mailbox, chat-channel and outgoing-webhook responses. Kept in
 * step with the API services named in each comment. Secrets (passwords, OAuth
 * tokens, bot tokens, webhook signing secrets) are never part of these, except
 * the webhook secret returned once on create / rotate.
 */
import type { MailboxProvider } from "@growthdesk/shared";

// ─── Mailboxes ───────────────────────────────────────────────────────────────

export type MailboxStatus = "connected" | "error" | "disconnected";
export type MailSecurity = "ssl" | "starttls" | "none";

/** GET /mailboxes, GET/PATCH /mailboxes/:id — apps/api/src/mailboxes/mailboxes.service.ts `mailboxDto()` */
export type Mailbox = {
  id: string;
  provider: MailboxProvider;
  email: string;
  displayName: string;
  status: MailboxStatus;
  lastError: string;
  lastCheckedAt: string | null;
  dailyLimit: number;
  sentToday: number;
  minDelaySeconds: number;
  signature: string;
  smtpHost: string;
  smtpPort: number;
  smtpSecurity: MailSecurity;
  smtpUser: string;
  imapEnabled: boolean;
  imapHost: string;
  imapPort: number;
  imapSecurity: MailSecurity;
  imapUser: string;
  lastSyncedAt: string | null;
  syncError: string;
  createdAt: string;
};

export type MailboxCheck = { ok: boolean; error: string };

/** POST /mailboxes/:id/verify — the mailbox plus what each server said. */
export type MailboxVerifyResult = Mailbox & { checks: { smtp: MailboxCheck; imap: MailboxCheck | null } };

/** POST /mailboxes/:id/test — `testSend()` */
export type TestSendResult = { sent: boolean; status: string; to: string; reason: string; messageId: string | null };

/** GET /mailboxes/oauth/:provider/start — the provider's consent screen to send the browser to. */
export type OAuthStart = { url: string };

/** GET /mailboxes/:id/dns — apps/api/src/mailboxes/domain-auth.ts `DomainAuth` */
export type DnsState = "ok" | "warn" | "fail";
export type DomainFix = {
  type: "TXT" | "CNAME" | "MX";
  host: string;
  /** Omitted when only the provider can generate the value (a DKIM key). */
  value?: string;
  note: string;
  href?: string;
  hrefLabel?: string;
};
export type DomainRecord = {
  id: "spf" | "dkim" | "dmarc" | "mx";
  label: string;
  title: string;
  state: DnsState;
  detail: string;
  found?: string;
  fix?: DomainFix;
};
export type DomainAuth = {
  domain: string;
  provider: string;
  shared: boolean;
  state: DnsState;
  detail: string;
  done: number;
  total: number;
  records: DomainRecord[];
};

export const MAILBOX_PROVIDER_LABELS: Record<MailboxProvider, string> = {
  smtp: "SMTP / IMAP",
  gmail: "Google",
  microsoft: "Microsoft 365",
};

// ─── Chat channels ───────────────────────────────────────────────────────────

export type ChannelCapabilities = {
  canInitiate: boolean;
  freeFormWindowHours: number | null;
  requiresTemplateToInitiate: boolean;
  supportsDeliveryReceipts: boolean;
};

/** GET /channels, POST /channels/whatsapp|telegram, POST /channels/:id/verify — apps/api/src/channels/channels.service.ts `dto()` */
export type ChannelIntegration = {
  id: string;
  channel: "whatsapp" | "telegram" | "call" | string;
  provider: "meta_cloud" | "telegram_bot" | "twilio" | string;
  name: string;
  status: "connected" | "error" | "disconnected" | string;
  lastError: string;
  lastEventAt: string | null;
  externalId: string | null;
  details: {
    phoneNumberId?: string;
    businessAccountId?: string;
    displayPhoneNumber?: string;
    verifiedName?: string;
    botId?: string;
    botUsername?: string;
    botName?: string;
    mode?: "webhook" | "polling";
    accountSid?: string;
    callerId?: string;
    friendlyName?: string;
  };
  capabilities: ChannelCapabilities | null;
  webhookUrl: string | null;
  /** WhatsApp only, and only for integrations.manage holders: pasted into Meta's dashboard. */
  verifyToken?: string | null;
  /** Telegram only: how messages arrive (webhook or polling). */
  setup?: string;
  createdAt: string;
  updatedAt: string;
};

/** GET /channels/reachability?channel=&contactId= — `ChatReachability` */
export type ChatReachability = {
  reachable: boolean;
  reason: string;
  capabilities: ChannelCapabilities;
  integrationId?: string | null;
  freeFormAllowed?: boolean;
  freeFormUntil?: string | null;
};

/** GET /channels/:id/start-link?contactId= */
export type TelegramStartLink = { url: string; token: string };

export const CHANNEL_PROVIDER_LABELS: Record<string, string> = {
  meta_cloud: "WhatsApp Cloud API",
  telegram_bot: "Telegram bot",
  twilio: "Twilio",
};

// ─── Outgoing webhooks ───────────────────────────────────────────────────────

/** GET /webhooks — apps/api/src/automation/webhooks.service.ts `endpointDto()` */
export type WebhookEndpoint = {
  id: string;
  url: string;
  description: string;
  events: string[];
  enabled: boolean;
  failureCount: number;
  lastDeliveryAt: string | null;
  lastError: string;
  createdAt: string;
  updatedAt: string;
};

/** POST /webhooks and POST /webhooks/:id/rotate-secret — the only responses that carry the signing secret. */
export type WebhookWithSecret = WebhookEndpoint & { secret: string };

/** POST /webhooks/:id/test */
export type WebhookTestResult = { deliveryId: string; ok: boolean; status: string; responseStatus: number | null; error: string };

export type WebhookDeliveryStatus = "pending" | "succeeded" | "failed";

/** GET /webhooks/:id/deliveries (paged) */
export type WebhookDelivery = {
  id: string;
  eventId: string;
  eventType: string;
  status: WebhookDeliveryStatus;
  attempts: number;
  responseStatus: number | null;
  error: string;
  deliveredAt: string | null;
  createdAt: string;
  updatedAt: string;
};

/** Consecutive failed deliveries after which the API switches an endpoint off (webhook-delivery.service.ts AUTO_DISABLE_AFTER). */
export const WEBHOOK_AUTO_DISABLE_AFTER = 50;

/** "contact.created" → "Contact created", "deal.stage_changed" → "Deal stage changed". */
export function eventLabel(event: string): string {
  const s = event.replace(/[._]/g, " ").trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}
