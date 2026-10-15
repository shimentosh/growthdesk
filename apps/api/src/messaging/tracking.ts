import { createHmac, timingSafeEqual } from "node:crypto";
import { derivedKey } from "../common/crypto.js";

/*
 * Signed, stateless tracking and unsubscribe tokens. Ported from LinkDesk
 * packages/domain/src/services/tracking.ts: the message id is packed into
 * the token and an HMAC (truncated to 12 bytes) covers it; a click token
 * signs its target URL too, so the redirect endpoint cannot be used as an
 * open redirect. The key is derived from ENCRYPTION_KEY per purpose.
 *
 * Opens are recorded but treated everywhere as a weak signal: image
 * proxies and privacy features fire pixels without a person reading.
 *
 * URLs go through the web app's /api proxy, so one public origin serves the
 * app, tracking and unsubscribe links: `${PUBLIC_APP_URL}/api/t/...`.
 */

let cached: Buffer | null = null;
const key = () => (cached ??= derivedKey("tracking/v1"));

const sign = (body: string) => createHmac("sha256", key()).update(body).digest().subarray(0, 12).toString("base64url");

const signedEquals = (a: string, b: string) => {
  const left = Buffer.from(a, "base64url");
  const right = Buffer.from(b, "base64url");
  return left.length === right.length && timingSafeEqual(left, right);
};

const packId = (id: string) => Buffer.from(id.replace(/-/g, ""), "hex").toString("base64url");
const unpackId = (packed: string): string | null => {
  const raw = Buffer.from(packed, "base64url").toString("hex");
  if (raw.length !== 32) return null;
  return [raw.slice(0, 8), raw.slice(8, 12), raw.slice(12, 16), raw.slice(16, 20), raw.slice(20)].join("-");
};

export type Tracked =
  | { kind: "open"; messageId: string }
  | { kind: "click"; messageId: string; url: string }
  /** Unsubscribe: names the message, from which workspace and recipient are read. */
  | { kind: "unsubscribe"; messageId: string };

export function trackingToken(t: Tracked): string {
  const parts =
    t.kind === "open" ? ["o", packId(t.messageId)] : t.kind === "unsubscribe" ? ["u", packId(t.messageId)] : ["c", packId(t.messageId), Buffer.from(t.url, "utf8").toString("base64url")];
  const body = parts.join(".");
  return `${body}.${sign(body)}`;
}

export function readTrackingToken(token: string): Tracked | null {
  const parts = (token ?? "").replace(/\.gif$/, "").split(".");
  if (parts.length < 3) return null;
  const signature = parts[parts.length - 1]!;
  const body = parts.slice(0, -1).join(".");
  try {
    if (!signedEquals(signature, sign(body))) return null;
  } catch {
    return null;
  }
  const [kind, packed, encoded] = parts;
  const messageId = unpackId(packed ?? "");
  if (!messageId) return null;
  if (kind === "o" && parts.length === 3) return { kind: "open", messageId };
  if (kind === "u" && parts.length === 3) return { kind: "unsubscribe", messageId };
  if (kind === "c" && parts.length === 4) {
    const url = Buffer.from(encoded ?? "", "base64url").toString("utf8");
    if (!/^https?:\/\//i.test(url)) return null;
    return { kind: "click", messageId, url };
  }
  return null;
}

export const trackingBase = (publicAppUrl: string) => `${publicAppUrl.replace(/\/+$/, "")}/api/t`;

export const openUrl = (base: string, messageId: string) => `${base}/o/${trackingToken({ kind: "open", messageId })}.gif`;
export const clickUrl = (base: string, messageId: string, url: string) => `${base}/c/${trackingToken({ kind: "click", messageId, url })}`;
/** One-click (RFC 8058) POST target and the link a person clicks. */
export const unsubscribeUrl = (base: string, messageId: string) => `${base}/u/${trackingToken({ kind: "unsubscribe", messageId })}`;
/**
 * The unsubscribe link of a test send: the web page itself, with "test" in place of a token. No token
 * means nothing to opt out — the page says it is a test, and the API refuses "test" as a broken link.
 */
export const testUnsubscribeUrl = (publicAppUrl: string) => `${publicAppUrl.replace(/\/+$/, "")}/unsubscribe/test`;

const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'" };
const unescapeHtml = (s: string) => s.replace(/&(?:amp|lt|gt|quot|#39);/g, (m) => ENTITIES[m] ?? m);
const escapeAttr = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Rewrites http(s) links through the click tracker and appends the open pixel, as chosen. */
export function withTracking(html: string, messageId: string, choice: { open: boolean; click: boolean }, base: string): string {
  let out = html;
  if (choice.click) {
    out = out.replace(/href="(https?:\/\/[^"]*)"/gi, (whole, captured: string) => {
      const target = unescapeHtml(captured);
      if (target.startsWith(`${base}/`)) return whole;
      return `href="${escapeAttr(clickUrl(base, messageId, target))}"`;
    });
  }
  if (choice.open) out += `<img src="${escapeAttr(openUrl(base, messageId))}" width="1" height="1" alt="" border="0" style="display:block">`;
  return out;
}
