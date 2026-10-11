import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";

// The token key is derived from ENCRYPTION_KEY on first use; a fixed test-only key.
process.env.ENCRYPTION_KEY ??= "dGVzdC1vbmx5LWtleS0zMi1ieXRlcy1sb25nLW9rISE=";

const { listUnsubscribeHeaders, marketingToken, oneClickUrl, preferencesPageUrl, readMarketingToken } = await import("./unsubscribe-token.js");
const { derivedKey } = await import("../common/crypto.js");
const { trackingToken } = await import("../messaging/tracking.js");

const user = "0190a3c4-1b2c-7d3e-8f40-0123456789ab";
const log = "0190a3c4-1b2c-7d3e-8f40-ba9876543210";

describe("platform marketing tokens", () => {
  it("round-trips the user and the email log", () => {
    expect(readMarketingToken(marketingToken({ userId: user, emailLogId: log }))).toEqual({ userId: user, emailLogId: log });
    expect(readMarketingToken(marketingToken({ userId: user, emailLogId: null }))).toEqual({ userId: user, emailLogId: null });
  });

  it("is deterministic, so a retried batch renders the same body", () => {
    expect(marketingToken({ userId: user, emailLogId: log })).toBe(marketingToken({ userId: user, emailLogId: log }));
  });

  it("refuses tampering: another user, another log, a changed signature, junk", () => {
    const token = marketingToken({ userId: user, emailLogId: log });
    const [p, u, l, sig] = token.split(".");
    const other = marketingToken({ userId: log, emailLogId: user }).split(".");
    expect(readMarketingToken([p, other[1], l, sig].join("."))).toBeNull();
    expect(readMarketingToken([p, u, other[2], sig].join("."))).toBeNull();
    expect(readMarketingToken([p, u, "-", sig].join("."))).toBeNull();
    const flipped = Buffer.from(sig!, "base64url");
    flipped[0] = flipped[0]! ^ 1;
    expect(readMarketingToken([p, u, l, flipped.toString("base64url")].join("."))).toBeNull();
    expect(readMarketingToken([p, u, l].join("."))).toBeNull();
    expect(readMarketingToken("")).toBeNull();
    expect(readMarketingToken(undefined)).toBeNull();
    expect(readMarketingToken("p.x.y.z")).toBeNull();
  });

  it("uses its own key: the same body signed with the customer tracking key is refused, and customer tokens do not parse", () => {
    const body = marketingToken({ userId: user, emailLogId: log }).split(".").slice(0, 3).join(".");
    const foreign = createHmac("sha256", derivedKey("tracking/v1")).update(body).digest().subarray(0, 12).toString("base64url");
    expect(readMarketingToken(`${body}.${foreign}`)).toBeNull();
    expect(readMarketingToken(trackingToken({ kind: "unsubscribe", messageId: user }))).toBeNull();
  });

  it("builds the page and one-click URLs and the RFC 8058 headers", () => {
    const token = marketingToken({ userId: user, emailLogId: log });
    expect(preferencesPageUrl("https://app.example.com/", token)).toBe(`https://app.example.com/email-preferences/${token}`);
    expect(oneClickUrl("https://app.example.com", token)).toBe(`https://app.example.com/api/platform-mail/u/${token}`);
    expect(listUnsubscribeHeaders("https://x.test/api/platform-mail/u/t", null)).toEqual({
      "List-Unsubscribe": "<https://x.test/api/platform-mail/u/t>",
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    });
    expect(listUnsubscribeHeaders("https://x.test/u", "Help <help@acme.test>")["List-Unsubscribe"]).toBe("<https://x.test/u>, <mailto:help@acme.test?subject=unsubscribe>");
  });
});
