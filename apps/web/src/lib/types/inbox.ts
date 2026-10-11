/*
 * Response shapes for the unified inbox. Each type names the API function it
 * mirrors (apps/api/src/inbox/inbox.service.ts); keep them in step. Dates
 * arrive as ISO strings.
 */
import type { Channel, ContactStatus, ConversationStatus, MessageDirection, MessageStatus } from "@growthdesk/shared";

/** The channels a conversation list can be filtered by (calls are logged, not replied to). */
export type InboxChannel = "email" | "whatsapp" | "telegram";

/** `conversationRow()` — one row of GET /inbox/conversations. */
export type ConversationRow = {
  id: string;
  channel: Channel;
  subject: string;
  status: ConversationStatus;
  unread: boolean;
  displayName: string;
  handle: string;
  contact: {
    id: string;
    fullName: string | null;
    email: string | null;
    phone: string | null;
    status: ContactStatus;
    company: { id: string; name: string } | null;
  } | null;
  assignee: { id: string; name: string; email: string } | null;
  mailboxId: string | null;
  integrationId: string | null;
  campaignId: string | null;
  dealId: string | null;
  aiCategory: string;
  aiSentiment: string;
  lastMessageAt: string | null;
  lastInboundAt: string | null;
  lastOutboundAt: string | null;
  snoozedUntil: string | null;
  preview: { direction: MessageDirection; status: MessageStatus; text: string; at: string } | null;
  createdAt: string;
};

/** `messageDto()` — bodyHtml is sanitised by the API (no scripts, styles, handlers; links open in a new tab). */
export type InboxMessage = {
  id: string;
  conversationId: string;
  channel: Channel;
  direction: MessageDirection;
  status: MessageStatus;
  fromAddress: string;
  toAddress: string;
  cc: string;
  subject: string;
  bodyText: string;
  bodyHtml: string | null;
  providerMessageId: string | null;
  inReplyTo: string | null;
  references: string | null;
  isAutoReply: boolean;
  author: { id: string; name: string } | null;
  campaignId: string | null;
  enrollmentId: string | null;
  mailboxId: string | null;
  integrationId: string | null;
  error: string;
  sentAt: string | null;
  receivedAt: string | null;
  deliveredAt: string | null;
  readAt: string | null;
  openedAt: string | null;
  openCount: number;
  clickedAt: string | null;
  clickCount: number;
  bouncedAt: string | null;
  createdAt: string;
};

export type ConversationNote = { id: string; body: string; author: { id: string; name: string } | null; createdAt: string };

/** `detail()` — GET /inbox/conversations/:id. */
export type ConversationDetail = Omit<ConversationRow, "contact"> & {
  peer: string;
  contact: {
    id: string;
    fullName: string | null;
    email: string | null;
    phone: string | null;
    jobTitle: string | null;
    status: ContactStatus;
    ownerId: string | null;
    doNotContact: boolean;
    unsubscribedAt: string | null;
    lastContactedAt: string | null;
    lastRepliedAt: string | null;
    company: { id: string; name: string; domain: string | null } | null;
  } | null;
  mailbox: { id: string; email: string; displayName: string; status: string; lastError: string } | null;
  integration: { id: string; name: string; channel: string; provider: string; status: string; lastError: string } | null;
  messages: InboxMessage[];
  notes: ConversationNote[];
  deals: { id: string; name: string; value: number; currency: string; status: string; stage: { id: string; name: string } }[];
  tasks: { id: string; type: string; title: string; dueAt: string | null; priority: string; assigneeId: string | null; conversationId: string | null }[];
  campaign: { id: string; name: string; status: string } | null;
  /** WhatsApp / Telegram with a contact: whether a send could work now, in the channel's own words. */
  reachability: {
    reachable: boolean;
    reason: string;
    integrationId?: string | null;
    freeFormAllowed?: boolean;
    freeFormUntil?: string | null;
  } | null;
};

/** `unreadCount()` — GET /inbox/unread-count. Open, unread and not snoozed. */
export type InboxUnreadCount = { total: number; byChannel: Record<InboxChannel, number> };
