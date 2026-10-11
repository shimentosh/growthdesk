/*
 * Contract between the campaign engine / inbox and the chat channel
 * implementations (WhatsApp Cloud API, Telegram Bot API). Implemented by
 * ChannelsService in channels/; provided under CHAT_SENDER by ChannelsModule.
 */
export const CHAT_SENDER = Symbol("CHAT_SENDER");

export type ChatChannel = "whatsapp" | "telegram";

export type ChatSendInput = {
  workspaceId: string;
  channel: ChatChannel;
  contactId: string;
  /** A specific connected integration; otherwise the workspace's first connected one for the channel. */
  integrationId?: string | null;
  conversationId?: string | null;
  body: string;
  /** WhatsApp: an approved template (required to open a conversation outside the 24-hour window). */
  template?: { name: string; language: string; params?: string[] } | null;
  authorId?: string | null;
  campaignId?: string | null;
  enrollmentId?: string | null;
  /** Write-ahead id, as in OutboundEmailService: a retried id is never sent twice. */
  messageRowId?: string;
  /** Recorded on the Message row (e.g. the WhatsApp template's Template row). Optional. */
  templateId?: string | null;
};

export type ChatSendResult =
  | { status: "sent"; messageRowId: string; conversationId: string }
  | { status: "failed"; reason: string; messageRowId?: string }
  /** The provider may have delivered it (timeout, dropped connection, an earlier unconfirmed attempt): never resend automatically. */
  | { status: "uncertain"; reason: string; messageRowId: string }
  /** The channel cannot reach this contact (no handle, window closed, bot never started, not connected). */
  | { status: "unavailable"; reason: string }
  | { status: "blocked"; reason: string };

export type ChannelCapabilities = {
  /** May start a conversation with a contact who has not written first. */
  canInitiate: boolean;
  /** Free-form text allowed only inside a customer-care window (WhatsApp: 24h). */
  freeFormWindowHours: number | null;
  requiresTemplateToInitiate: boolean;
  supportsDeliveryReceipts: boolean;
};

/**
 * What each chat channel can do, by the provider's own rules:
 *  - WhatsApp (Meta Cloud API): a business may message anyone with an approved
 *    template; free-form text only within 24 hours of the person's last message.
 *    Sent/delivered/read/failed receipts arrive by webhook.
 *  - Telegram (Bot API): a bot can only message a user who has opened a chat
 *    with it (/start) and has not blocked it. No delivery receipts.
 */
export const CHANNEL_CAPABILITIES: Record<ChatChannel, ChannelCapabilities> = {
  whatsapp: { canInitiate: true, requiresTemplateToInitiate: true, freeFormWindowHours: 24, supportsDeliveryReceipts: true },
  telegram: { canInitiate: false, requiresTemplateToInitiate: false, freeFormWindowHours: null, supportsDeliveryReceipts: false },
};

export type ChatReachability = {
  reachable: boolean;
  reason: string;
  capabilities: ChannelCapabilities;
  /** The integration a send would use (when one is connected). */
  integrationId?: string | null;
  /** WhatsApp: whether free-form text is allowed right now (false = template only). */
  freeFormAllowed?: boolean;
  /** WhatsApp: when the current 24-hour window closes, if it is open. */
  freeFormUntil?: Date | null;
};

export interface ChatSender {
  send(input: ChatSendInput): Promise<ChatSendResult>;
  /** Whether a send to this contact on this channel could work right now, and why not. */
  reachability(workspaceId: string, channel: ChatChannel, contactId: string): Promise<{ reachable: boolean; reason: string; capabilities: ChannelCapabilities } & Partial<ChatReachability>>;
}
