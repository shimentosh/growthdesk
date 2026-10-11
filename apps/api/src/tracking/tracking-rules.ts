/*
 * The judgement calls behind open and click tracking, kept pure so they are
 * tested on their own.
 *
 * An open is the weakest signal Growthdesk records: image proxies, privacy
 * features (Apple Mail Privacy Protection) and corporate link scanners fetch
 * pixels and follow links with no person involved. What can be recognised is
 * not counted:
 *   - HEAD requests (scanners checking a link without loading it)
 *   - no User-Agent, or one that names a bot, a script or a mail-security product
 *   - a hit before the send was confirmed, or within seconds of it: delivery
 *     takes longer than that, so only the receiving server's scanner is that fast
 * Gmail's image proxy is deliberately NOT on the list — it fetches the pixel
 * when the person opens the email. Apple's prefetch looks like a browser and
 * cannot be told apart, which is why opens stay labelled a weak signal.
 */

/** A transparent 1×1 GIF, the smallest image every mail client renders. */
export const PIXEL_GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");

/** A hit this soon after the send was confirmed came from a machine on the receiving side. */
export const AUTOMATED_WINDOW_MS = 5_000;

/** Repeat pixel loads within this window are one open (clients re-render; proxies refetch). */
export const OPEN_DEDUPE_MS = 60_000;

/** The same link followed again within this window is one click. */
export const CLICK_DEDUPE_MS = 60_000;

const AUTOMATED_AGENTS =
  /bot\b|bot\/|crawler|spider|slurp|curl\/|wget\/|python-|httpclient|go-http-client|java\/|okhttp|axios\/|node-fetch|undici|headless|phantomjs|facebookexternalhit|linkexpanding|barracuda|mimecast|proofpoint|safelinks|symantec|trendmicro|forcepoint|sophos|fortinet|zscaler|cisco|ironport/i;

export type FetchSignal = {
  method: string;
  userAgent: string;
  /** When the message was confirmed sent; null while the send is still in flight. */
  sentAt: Date | null;
  now: Date;
};

/** True when a pixel load or link click was (recognisably) made by software, not a person. */
export function isAutomatedFetch(s: FetchSignal): boolean {
  if (s.method.toUpperCase() === "HEAD") return true;
  const ua = s.userAgent.trim();
  if (!ua || AUTOMATED_AGENTS.test(ua)) return true;
  if (!s.sentAt) return true;
  return s.now.getTime() - s.sentAt.getTime() < AUTOMATED_WINDOW_MS;
}

/**
 * The redirect target of a verified click token, or null. The token's HMAC
 * already covers the URL; this refuses anything but an absolute http(s) URL
 * with a host, and anything that could split a header, as a second guard.
 */
export function redirectTarget(url: string): string | null {
  if (/[\r\n\u0000]/.test(url)) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (!parsed.hostname) return null;
  return url;
}

/** How an unsubscribe arrived, for the event and the contact's timeline. */
export type UnsubscribeVia = "unsubscribe_page" | "one_click";

/**
 * The page's confirm button says `{ via: "page" }`; anything else POSTed to
 * the List-Unsubscribe URL is the recipient's mail app (RFC 8058 one-click).
 */
export const unsubscribeVia = (body: { via?: string } | null | undefined): UnsubscribeVia => (body?.via === "page" ? "unsubscribe_page" : "one_click");

export const unsubscribeSummary = (via: UnsubscribeVia, email: string) =>
  via === "one_click" ? `Unsubscribed with their mail app's unsubscribe button (${email})` : `Unsubscribed with the link in an email (${email})`;
