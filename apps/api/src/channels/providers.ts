import { createHmac } from "node:crypto";
import { safeEqual } from "../common/crypto.js";

/*
 * The two chat providers, as plain HTTP over global fetch — no SDKs (as in
 * LinkDesk: two endpoints and an HMAC do not justify a dependency).
 *
 * Base URLs are read from the environment on every call so tests can point
 * them at a local fake server:
 *   WHATSAPP_GRAPH_URL  Meta Graph API base INCLUDING the version
 *                       (default https://graph.facebook.com/v21.0)
 *   TELEGRAM_API_URL    Telegram Bot API base (default https://api.telegram.org);
 *                       methods are called as `${base}/bot<token>/<method>`.
 * Neither should be set in production.
 *
 * Telegram is built on the official Bot API only. LinkDesk automated a
 * personal Telegram account over MTProto; that is against Telegram's terms
 * and is deliberately not ported.
 */

const TIMEOUT_MS = 15_000;

export const graphBase = () => (process.env.WHATSAPP_GRAPH_URL?.trim() || "https://graph.facebook.com/v21.0").replace(/\/+$/, "");
export const telegramBase = () => (process.env.TELEGRAM_API_URL?.trim() || "https://api.telegram.org").replace(/\/+$/, "");

/**
 * A provider call that did not succeed. `delivery` says whether the request
 * could have taken effect anyway: "no" for a refusal or a connection that was
 * never made, "unknown" for a timeout or a dropped connection after the
 * request was written — a send in that state must not be retried blindly.
 */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly delivery: "no" | "unknown",
    readonly code?: number | string,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

const NEVER_SENT = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ECONNRESET_BEFORE_WRITE", "CERT_HAS_EXPIRED", "UND_ERR_CONNECT_TIMEOUT"]);

function networkError(e: unknown, what: string): ProviderError {
  const err = e as { name?: string; message?: string; cause?: { code?: string } };
  const code = err.cause?.code ?? "";
  const timedOut = err.name === "TimeoutError" || err.name === "AbortError";
  const never = NEVER_SENT.has(code);
  const message = timedOut ? `${what} did not answer within ${TIMEOUT_MS / 1000}s` : `${what} could not be reached${code ? ` (${code})` : ""}`;
  return new ProviderError(message, 0, never ? "no" : "unknown", code || undefined);
}

// ─── WhatsApp (Meta Cloud API) ───────────────────────────────────────────────

/** Ported from LinkDesk: kept a minute short of Meta's 24 hours so a reply accepted here is not refused in flight. */
export const CUSTOMER_WINDOW_MS = 24 * 60 * 60_000 - 60_000;

type GraphError = { error?: { message?: string; code?: number; error_subcode?: number; error_data?: { details?: string } } };

async function graph<T>(method: "GET" | "POST", path: string, accessToken: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${graphBase()}/${path}`, {
      method,
      headers: { authorization: `Bearer ${accessToken}`, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    throw networkError(e, "WhatsApp (Meta)");
  }
  const payload = (await res.json().catch(() => ({}))) as T & GraphError;
  if (!res.ok || payload.error) {
    const said = payload.error?.error_data?.details || payload.error?.message || `Meta answered HTTP ${res.status}`;
    throw new ProviderError(said, res.status, "no", payload.error?.code);
  }
  return payload;
}

export const whatsappApi = {
  /** Proves the token can see the phone number id. */
  async verify(phoneNumberId: string, accessToken: string): Promise<{ displayPhoneNumber: string; verifiedName: string }> {
    const r = await graph<{ display_phone_number?: string; verified_name?: string }>(
      "GET",
      `${encodeURIComponent(phoneNumberId)}?fields=display_phone_number,verified_name`,
      accessToken,
    );
    return { displayPhoneNumber: r.display_phone_number ?? "", verifiedName: r.verified_name ?? "" };
  },

  async sendText(phoneNumberId: string, accessToken: string, to: string, body: string): Promise<{ wamid: string }> {
    const r = await graph<{ messages?: { id?: string }[] }>("POST", `${encodeURIComponent(phoneNumberId)}/messages`, accessToken, {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "text",
      text: { preview_url: false, body },
    });
    return { wamid: r.messages?.[0]?.id ?? "" };
  },

  async sendTemplate(phoneNumberId: string, accessToken: string, to: string, template: { name: string; language: string; params?: string[] }): Promise<{ wamid: string }> {
    const params = template.params ?? [];
    const r = await graph<{ messages?: { id?: string }[] }>("POST", `${encodeURIComponent(phoneNumberId)}/messages`, accessToken, {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "template",
      template: {
        name: template.name,
        language: { code: template.language },
        ...(params.length ? { components: [{ type: "body", parameters: params.map((text) => ({ type: "text", text })) }] } : {}),
      },
    });
    return { wamid: r.messages?.[0]?.id ?? "" };
  },
};

/**
 * Whether a payload really came from Meta (LinkDesk signatureOk): HMAC-SHA256
 * of the raw request bytes under the app secret, compared in constant time.
 * Raw bytes, because re-serialised JSON is not what Meta signed.
 */
export function whatsappSignatureOk(appSecret: string, raw: Buffer | string, header: string | undefined | null): boolean {
  if (!appSecret || !header || !header.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", appSecret).update(raw).digest("hex");
  return safeEqual(expected, header.slice("sha256=".length));
}

/**
 * Why a free-form WhatsApp message will not go, or "" when it will (LinkDesk
 * windowRefusal). Growthdesk supports approved templates, so the refusal
 * says that a template is the way through.
 */
export function windowRefusal(lastInboundAt: Date | null | undefined, now = Date.now()): string {
  if (!lastInboundAt) {
    return "WhatsApp only allows free-form messages within 24 hours of the contact's last message, and they have not written to this number. Send an approved template instead.";
  }
  const age = now - lastInboundAt.getTime();
  if (age > CUSTOMER_WINDOW_MS) {
    const hours = Math.floor(age / 3_600_000);
    const days = Math.floor(hours / 24);
    const ago = days >= 1 ? `${days} day${days === 1 ? "" : "s"}` : `${hours} hour${hours === 1 ? "" : "s"}`;
    return `WhatsApp only allows free-form messages within 24 hours of the contact's last message, and theirs was ${ago} ago. Send an approved template instead.`;
  }
  return "";
}

/** The comparable form of a chat handle (LinkDesk normaliseHandle): digits for a number, lower-case without "@" for a username. */
export function normaliseHandle(handle: string): string {
  const raw = handle.trim();
  if (!raw) return "";
  const digits = raw.replace(/\D/g, "");
  if (digits && !/[a-z]/i.test(raw)) return digits;
  return raw.replace(/^@/, "").toLowerCase();
}

/** The slice of Meta's webhook shape this reads. */
export type MetaWebhook = {
  object?: string;
  entry?: {
    id?: string;
    changes?: {
      field?: string;
      value?: {
        metadata?: { phone_number_id?: string; display_phone_number?: string };
        contacts?: { wa_id?: string; profile?: { name?: string } }[];
        messages?: MetaMessage[];
        statuses?: MetaStatus[];
      };
    }[];
  }[];
};

export type MetaMessage = {
  id?: string;
  from?: string;
  timestamp?: string;
  type?: string;
  text?: { body?: string };
  image?: { caption?: string };
  video?: { caption?: string };
  document?: { caption?: string; filename?: string };
  audio?: Record<string, unknown>;
  sticker?: Record<string, unknown>;
  location?: { name?: string; address?: string; latitude?: number; longitude?: number };
  button?: { text?: string; payload?: string };
  interactive?: { button_reply?: { title?: string }; list_reply?: { title?: string } };
  reaction?: { emoji?: string };
};

export type MetaStatus = {
  id?: string;
  status?: string;
  timestamp?: string;
  recipient_id?: string;
  errors?: { code?: number; title?: string; message?: string; error_data?: { details?: string } }[];
};

/** A human-readable body for one inbound WhatsApp message; null for kinds that are not a message from the person (reactions, system notices). */
export function whatsappBody(m: MetaMessage): string | null {
  const caption = (c?: string) => (c?.trim() ? `\n${c.trim()}` : "");
  switch (m.type) {
    case "text":
      return m.text?.body ?? "";
    case "image":
      return `[image]${caption(m.image?.caption)}`;
    case "video":
      return `[video]${caption(m.video?.caption)}`;
    case "document":
      return `[document: ${m.document?.filename || "file"}]${caption(m.document?.caption)}`;
    case "audio":
      return "[voice message]";
    case "sticker":
      return "[sticker]";
    case "location":
      return `[location${m.location?.name ? `: ${m.location.name}` : ""}]`;
    case "contacts":
      return "[contact card]";
    case "button":
      return m.button?.text ?? "[button]";
    case "interactive":
      return m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title ?? "[reply]";
    case "reaction":
    case "system":
    case "unsupported":
    case "ephemeral":
      return null;
    default:
      return m.text?.body ?? (m.type ? `[${m.type}]` : null);
  }
}

// ─── Telegram (Bot API) ──────────────────────────────────────────────────────

type TgEnvelope<T> = { ok?: boolean; result?: T; error_code?: number; description?: string };

/** One Bot API method. The token is part of the URL, so errors never echo the URL. */
async function tg<T>(token: string, method: string, body?: Record<string, unknown>): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${telegramBase()}/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    throw networkError(e, "Telegram");
  }
  const payload = (await res.json().catch(() => ({}))) as TgEnvelope<T>;
  if (!res.ok || !payload.ok) {
    throw new ProviderError(payload.description || `Telegram answered HTTP ${res.status}`, res.status, "no", payload.error_code);
  }
  return payload.result as T;
}

export type TgUser = { id: number; is_bot?: boolean; first_name?: string; last_name?: string; username?: string };
export type TgMessage = {
  message_id: number;
  date?: number;
  from?: TgUser;
  chat?: { id: number; type?: string; username?: string; first_name?: string; last_name?: string };
  text?: string;
  caption?: string;
  photo?: unknown[];
  video?: unknown;
  voice?: unknown;
  audio?: unknown;
  sticker?: { emoji?: string };
  document?: { file_name?: string };
  location?: unknown;
  contact?: unknown;
};
export type TgUpdate = { update_id: number; message?: TgMessage };

export const telegramApi = {
  getMe: (token: string) => tg<TgUser>(token, "getMe"),
  setWebhook: (token: string, url: string, secretToken: string) =>
    tg<boolean>(token, "setWebhook", { url, secret_token: secretToken, allowed_updates: ["message"], drop_pending_updates: false }),
  deleteWebhook: (token: string) => tg<boolean>(token, "deleteWebhook", { drop_pending_updates: false }),
  getUpdates: (token: string, offset: number | undefined) =>
    tg<TgUpdate[]>(token, "getUpdates", { ...(offset !== undefined ? { offset } : {}), timeout: 0, limit: 100, allowed_updates: ["message"] }),
  sendMessage: (token: string, chatId: string, text: string) =>
    tg<TgMessage>(token, "sendMessage", { chat_id: chatId, text, link_preview_options: { is_disabled: true } }),
};

/** A human-readable body for one inbound Telegram message. */
export function telegramBody(m: TgMessage): string {
  const caption = m.caption?.trim() ? `\n${m.caption.trim()}` : "";
  if (m.text !== undefined) return m.text;
  if (m.photo) return `[image]${caption}`;
  if (m.document) return `[document: ${m.document.file_name || "file"}]${caption}`;
  if (m.video) return `[video]${caption}`;
  if (m.voice || m.audio) return `[voice message]${caption}`;
  if (m.sticker) return `[sticker${m.sticker.emoji ? ` ${m.sticker.emoji}` : ""}]`;
  if (m.location) return "[location]";
  if (m.contact) return "[contact card]";
  return caption.trim() || "[message]";
}

/** Text that means "stop messaging me", on any chat channel. */
export const OPT_OUT = /^\s*(stop|unsubscribe|opt[- ]?out|cancel)\s*$/i;
