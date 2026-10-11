import { createHmac, timingSafeEqual } from "node:crypto";
import { derivedKey } from "../common/crypto.js";

/*
 * Stateless, signed links for platform marketing (our own users), the same
 * construction as the customer tracking tokens (messaging/tracking.ts) but
 * with their OWN key, derivedKey("platform-marketing/v1"), so a customer
 * campaign token can never act on a platform user and vice versa.
 *
 * A token names the user and, when it came from a real send, the EmailLog row
 * (so an unsubscribe is attributed to the broadcast or drip step). The HMAC is
 * truncated to 12 bytes. Tokens do not expire: an unsubscribe link must keep
 * working for as long as the email exists.
 *
 *   p.<userId packed>.<logId packed | "-">.<signature>
 */

let cached: Buffer | null = null;
const key = () => (cached ??= derivedKey("platform-marketing/v1"));

const sign = (body: string) => createHmac("sha256", key()).update(body).digest().subarray(0, 12).toString("base64url");

const signedEquals = (a: string, b: string) => {
  const left = Buffer.from(a, "base64url");
  const right = Buffer.from(b, "base64url");
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right);
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const packId = (id: string) => Buffer.from(id.replace(/-/g, ""), "hex").toString("base64url");
const unpackId = (packed: string): string | null => {
  if (!/^[A-Za-z0-9_-]{22}$/.test(packed)) return null;
  const raw = Buffer.from(packed, "base64url").toString("hex");
  if (raw.length !== 32) return null;
  return [raw.slice(0, 8), raw.slice(8, 12), raw.slice(12, 16), raw.slice(16, 20), raw.slice(20)].join("-");
};

export type MarketingToken = { userId: string; emailLogId: string | null };

export function marketingToken(t: MarketingToken): string {
  if (!UUID.test(t.userId) || (t.emailLogId && !UUID.test(t.emailLogId))) throw new Error("marketingToken needs uuids");
  const body = ["p", packId(t.userId), t.emailLogId ? packId(t.emailLogId) : "-"].join(".");
  return `${body}.${sign(body)}`;
}

export function readMarketingToken(token: string | null | undefined): MarketingToken | null {
  const parts = String(token ?? "").split(".");
  if (parts.length !== 4 || parts[0] !== "p") return null;
  const body = parts.slice(0, 3).join(".");
  try {
    if (!signedEquals(parts[3]!, sign(body))) return null;
  } catch {
    return null;
  }
  const userId = unpackId(parts[1]!);
  if (!userId) return null;
  if (parts[2] === "-") return { userId, emailLogId: null };
  const emailLogId = unpackId(parts[2]!);
  return emailLogId ? { userId, emailLogId } : null;
}

const base = (publicAppUrl: string) => publicAppUrl.replace(/\/+$/, "");

/** The page a person opens (footer link, {{unsubscribe_url}}): shows who and what, unsubscribes only on its button. */
export const preferencesPageUrl = (publicAppUrl: string, token: string) => `${base(publicAppUrl)}/email-preferences/${encodeURIComponent(token)}`;

/** RFC 8058 one-click target (through the web app's /api → /v1 proxy). GET only redirects to the page. */
export const oneClickUrl = (publicAppUrl: string, token: string) => `${base(publicAppUrl)}/api/platform-mail/u/${encodeURIComponent(token)}`;

/**
 * List-Unsubscribe (the https one-click URL, plus a mailto when we have a
 * reply-to address) and List-Unsubscribe-Post, on every marketing email.
 */
export function listUnsubscribeHeaders(oneClick: string, replyTo?: string | null): Record<string, string> {
  const mailtoAddress = replyTo ? (replyTo.match(/<\s*([^<>\s]+)\s*>/)?.[1] ?? replyTo).trim() : "";
  const mailto = /^[^\s<>@]+@[^\s<>@]+$/.test(mailtoAddress) ? `, <mailto:${mailtoAddress}?subject=unsubscribe>` : "";
  return {
    "List-Unsubscribe": `<${oneClick}>${mailto}`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  };
}
