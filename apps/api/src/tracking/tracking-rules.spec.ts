import { randomUUID } from "node:crypto";
import { clickUrl, openUrl, readTrackingToken, trackingBase, trackingToken, unsubscribeUrl, withTracking } from "../messaging/tracking.js";
import { AUTOMATED_WINDOW_MS, PIXEL_GIF, isAutomatedFetch, redirectTarget, unsubscribeSummary, unsubscribeVia } from "./tracking-rules.js";

// The token key is derived from ENCRYPTION_KEY on first use; a fixed test-only key.
process.env.ENCRYPTION_KEY ??= "dGVzdC1vbmx5LWtleS0zMi1ieXRlcy1sb25nLW9rISE=";

const BROWSER = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15";
const GMAIL_PROXY = "Mozilla/5.0 (Windows NT 5.1; rv:11.0) Gecko Firefox/11.0 (via ggpht.com GoogleImageProxy)";

describe("isAutomatedFetch", () => {
  const sentAt = new Date("2026-10-10T10:00:00Z");
  const later = new Date(sentAt.getTime() + 60_000);

  it("counts a person's browser and Gmail's image proxy", () => {
    expect(isAutomatedFetch({ method: "GET", userAgent: BROWSER, sentAt, now: later })).toBe(false);
    expect(isAutomatedFetch({ method: "GET", userAgent: GMAIL_PROXY, sentAt, now: later })).toBe(false);
  });

  it("ignores HEAD requests, missing user agents, bots, scripts and mail scanners", () => {
    expect(isAutomatedFetch({ method: "HEAD", userAgent: BROWSER, sentAt, now: later })).toBe(true);
    expect(isAutomatedFetch({ method: "GET", userAgent: "", sentAt, now: later })).toBe(true);
    for (const ua of [
      "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
      "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)",
      "curl/8.4.0",
      "python-requests/2.31.0",
      "Go-http-client/1.1",
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/120.0.0.0 Safari/537.36",
      "Barracuda Sentinel (EE)",
      "facebookexternalhit/1.1",
    ]) {
      expect(isAutomatedFetch({ method: "GET", userAgent: ua, sentAt, now: later }), ua).toBe(true);
    }
  });

  it("ignores hits before the send was confirmed or within seconds of it", () => {
    expect(isAutomatedFetch({ method: "GET", userAgent: BROWSER, sentAt: null, now: later })).toBe(true);
    expect(isAutomatedFetch({ method: "GET", userAgent: BROWSER, sentAt, now: new Date(sentAt.getTime() + AUTOMATED_WINDOW_MS - 1) })).toBe(true);
    expect(isAutomatedFetch({ method: "GET", userAgent: BROWSER, sentAt, now: new Date(sentAt.getTime() + AUTOMATED_WINDOW_MS) })).toBe(false);
  });
});

describe("redirectTarget", () => {
  it("passes absolute http(s) URLs through unchanged", () => {
    expect(redirectTarget("https://example.com/pricing?a=1&b=2#top")).toBe("https://example.com/pricing?a=1&b=2#top");
    expect(redirectTarget("http://example.com")).toBe("http://example.com");
  });

  it("refuses other schemes, relative URLs and header-splitting characters", () => {
    expect(redirectTarget("javascript:alert(1)")).toBeNull();
    expect(redirectTarget("//evil.example")).toBeNull();
    expect(redirectTarget("/relative")).toBeNull();
    expect(redirectTarget("https://example.com/\r\nSet-Cookie: x=1")).toBeNull();
    expect(redirectTarget("mailto:someone@example.com")).toBeNull();
  });
});

describe("unsubscribe wording", () => {
  it("tells the page's button apart from a mail app's one-click POST", () => {
    expect(unsubscribeVia({ via: "page" })).toBe("unsubscribe_page");
    expect(unsubscribeVia({})).toBe("one_click");
    expect(unsubscribeVia(undefined)).toBe("one_click");
    expect(unsubscribeSummary("one_click", "a@x.test")).toBe("Unsubscribed with their mail app's unsubscribe button (a@x.test)");
    expect(unsubscribeSummary("unsubscribe_page", "a@x.test")).toBe("Unsubscribed with the link in an email (a@x.test)");
  });
});

describe("the pixel", () => {
  it("is a 1×1 GIF", () => {
    expect(PIXEL_GIF.subarray(0, 6).toString("ascii")).toBe("GIF89a");
    expect(PIXEL_GIF.readUInt16LE(6)).toBe(1);
    expect(PIXEL_GIF.readUInt16LE(8)).toBe(1);
  });
});

describe("tracking tokens (messaging/tracking.ts)", () => {
  const id = randomUUID();
  const base = trackingBase("https://app.example.com/");

  it("round-trips each kind and builds the /api/t URLs the endpoints serve", () => {
    expect(base).toBe("https://app.example.com/api/t");
    expect(readTrackingToken(trackingToken({ kind: "open", messageId: id }))).toEqual({ kind: "open", messageId: id });
    expect(readTrackingToken(`${trackingToken({ kind: "open", messageId: id })}.gif`)).toEqual({ kind: "open", messageId: id });
    expect(readTrackingToken(trackingToken({ kind: "unsubscribe", messageId: id }))).toEqual({ kind: "unsubscribe", messageId: id });
    expect(readTrackingToken(trackingToken({ kind: "click", messageId: id, url: "https://example.com/a?b=c" }))).toEqual({ kind: "click", messageId: id, url: "https://example.com/a?b=c" });
    expect(openUrl(base, id)).toMatch(/^https:\/\/app\.example\.com\/api\/t\/o\/[\w-]+\.[\w-]+\.[\w-]+\.gif$/);
    expect(clickUrl(base, id, "https://example.com")).toMatch(/^https:\/\/app\.example\.com\/api\/t\/c\//);
    expect(unsubscribeUrl(base, id)).toMatch(/^https:\/\/app\.example\.com\/api\/t\/u\//);
  });

  it("rejects a tampered signature, a swapped URL and a token of another kind", () => {
    const click = trackingToken({ kind: "click", messageId: id, url: "https://example.com" });
    const parts = click.split(".");
    parts[2] = Buffer.from("https://evil.example", "utf8").toString("base64url");
    expect(readTrackingToken(parts.join("."))).toBeNull();
    expect(readTrackingToken(`${click.slice(0, -2)}AA`)).toBeNull();
    expect(readTrackingToken("garbage")).toBeNull();
    // An open token reads as an open, never as an unsubscribe.
    expect(readTrackingToken(trackingToken({ kind: "open", messageId: id }))?.kind).toBe("open");
  });

  it("rewrites links and appends the pixel, leaving its own links alone", () => {
    const html = withTracking(`<a href="https://example.com/?a=1&amp;b=2">x</a><a href="${base}/u/abc">u</a>`, id, { open: true, click: true }, base);
    const href = html.match(/href="([^"]+)"/)![1]!.replace(/&amp;/g, "&");
    const token = href.slice(`${base}/c/`.length);
    expect(readTrackingToken(token)).toEqual({ kind: "click", messageId: id, url: "https://example.com/?a=1&b=2" });
    expect(html).toContain(`href="${base}/u/abc"`);
    expect(html).toContain(`src="${openUrl(base, id)}"`);
  });
});
