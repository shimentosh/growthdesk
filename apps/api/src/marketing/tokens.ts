import { createHmac, timingSafeEqual } from "node:crypto";
import { derivedKey } from "../common/crypto.js";

/*
 * Signed tokens for links inside marketing emails, keyed separately from the
 * outreach tracker (messaging/tracking.ts) so neither engine's links can be
 * replayed against the other. Each names a MarketingSend; a click token also
 * signs its target, so /m/c cannot be used as an open redirect.
 *
 *   o  open pixel          c  click (with URL)
 *   p  preference page     u  one-click unsubscribe (RFC 8058 POST target)
 *   s  double opt-in confirmation — names a pending ListMembership, not a send
 *
 * Public URLs: ${PUBLIC_APP_URL}/api/m/... through the web app's proxy.
 */

let cached: Buffer | null = null;
const key = () => (cached ??= derivedKey("marketing-tracking/v1"));
const sign = (body: string) => createHmac("sha256", key()).update(body).digest().subarray(0, 12).toString("base64url");

const packId = (id: string) => Buffer.from(id.replace(/-/g, ""), "hex").toString("base64url");
const unpackId = (packed: string): string | null => {
  const raw = Buffer.from(packed, "base64url").toString("hex");
  if (!/^[0-9a-f]{32}$/.test(raw)) return null;
  return [raw.slice(0, 8), raw.slice(8, 12), raw.slice(12, 16), raw.slice(16, 20), raw.slice(20)].join("-");
};

export type MarketingToken =
  | { kind: "open"; sendId: string }
  | { kind: "click"; sendId: string; url: string }
  | { kind: "preferences"; sendId: string }
  | { kind: "unsubscribe"; sendId: string };

const LETTER = { open: "o", click: "c", preferences: "p", unsubscribe: "u" } as const;

export function marketingToken(t: MarketingToken): string {
  const parts: string[] = [LETTER[t.kind], packId(t.sendId)];
  if (t.kind === "click") parts.push(Buffer.from(t.url, "utf8").toString("base64url"));
  const body = parts.join(".");
  return `${body}.${sign(body)}`;
}

export function readMarketingToken(token: string, expect?: MarketingToken["kind"]): MarketingToken | null {
  const parts = (token ?? "").replace(/\.gif$/, "").split(".");
  if (parts.length < 3) return null;
  const signature = parts.at(-1)!;
  const body = parts.slice(0, -1).join(".");
  // Compare the text exactly: base64url decoding ignores trailing junk, so decoded bytes alone would accept "<sig>x".
  const want = Buffer.from(sign(body), "utf8");
  const got = Buffer.from(signature, "utf8");
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  const sendId = unpackId(parts[1] ?? "");
  if (!sendId) return null;
  let out: MarketingToken | null = null;
  if (parts[0] === "o" && parts.length === 3) out = { kind: "open", sendId };
  else if (parts[0] === "p" && parts.length === 3) out = { kind: "preferences", sendId };
  else if (parts[0] === "u" && parts.length === 3) out = { kind: "unsubscribe", sendId };
  else if (parts[0] === "c" && parts.length === 4) {
    const url = Buffer.from(parts[2] ?? "", "base64url").toString("utf8");
    if (/^https?:\/\//i.test(url)) out = { kind: "click", sendId, url };
  }
  return out && (!expect || out.kind === expect) ? out : null;
}

/** The link in a double opt-in email. It names the membership, so removing someone from the list voids it. */
export function confirmToken(membershipId: string): string {
  const body = `s.${packId(membershipId)}`;
  return `${body}.${sign(body)}`;
}

export function readConfirmToken(token: string): string | null {
  const parts = (token ?? "").split(".");
  if (parts.length !== 3 || parts[0] !== "s") return null;
  const body = `${parts[0]}.${parts[1]}`;
  const want = Buffer.from(sign(body), "utf8");
  const got = Buffer.from(parts[2]!, "utf8");
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  return unpackId(parts[1] ?? "");
}

/** The page a double opt-in email links to: it shows the list and confirms only on a button press. */
export const confirmUrl = (publicAppUrl: string, membershipId: string) => `${publicAppUrl.replace(/\/+$/, "")}/confirm/${confirmToken(membershipId)}`;

export const marketingBase = (publicAppUrl: string) => `${publicAppUrl.replace(/\/+$/, "")}/api/m`;

export const marketingLinks = (base: string, publicAppUrl: string, sendId: string) => ({
  open: `${base}/o/${marketingToken({ kind: "open", sendId })}.gif`,
  click: (url: string) => `${base}/c/${marketingToken({ kind: "click", sendId, url })}`,
  /** The page a person opens from the footer link. */
  preferences: `${publicAppUrl.replace(/\/+$/, "")}/preferences/${marketingToken({ kind: "preferences", sendId })}`,
  /** List-Unsubscribe target: one-click POST unsubscribes, GET redirects to the page. */
  unsubscribe: `${base}/u/${marketingToken({ kind: "unsubscribe", sendId })}`,
});

const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'" };
const unescapeHtml = (s: string) => s.replace(/&(?:amp|lt|gt|quot|#39);/g, (m) => ENTITIES[m] ?? m);
const escapeAttr = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Rewrites http(s) links through the click tracker (skipping our own) and adds the open pixel before </body>. */
export function withMarketingTracking(html: string, links: ReturnType<typeof marketingLinks>, base: string, publicAppUrl: string, choice: { open: boolean; click: boolean }): string {
  let out = html;
  const own = publicAppUrl.replace(/\/+$/, "");
  if (choice.click) {
    out = out.replace(/href="(https?:\/\/[^"]*)"/gi, (whole, captured: string) => {
      const target = unescapeHtml(captured);
      if (target.startsWith(`${base}/`) || target.startsWith(`${own}/preferences/`)) return whole;
      return `href="${escapeAttr(links.click(target))}"`;
    });
  }
  if (choice.open) {
    const pixel = `<img src="${escapeAttr(links.open)}" width="1" height="1" alt="" border="0" style="display:block;height:1px;width:1px">`;
    out = out.includes("</body>") ? out.replace("</body>", `${pixel}</body>`) : out + pixel;
  }
  return out;
}
