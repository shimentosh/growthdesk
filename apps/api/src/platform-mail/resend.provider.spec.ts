import { classifyResendFailure, retryAfterMs } from "./resend.provider.js";

const h = (values: Record<string, string> = {}) => ({ get: (n: string) => values[n.toLowerCase()] ?? null });

describe("classifyResendFailure", () => {
  it("401/403 are credential problems: nothing was sent, SMTP may take over", () => {
    for (const status of [401, 403]) {
      const e = classifyResendFailure(status, { statusCode: status, name: "restricted_api_key", message: "API key is invalid" }, h());
      expect(e.kind).toBe("auth");
      expect(e.allowsFallback).toBe(true);
      expect(e.retryable).toBe(false);
      expect(e.message).toBe(`Resend ${status} restricted_api_key: API key is invalid`);
    }
  });

  it("400/404/422 and a reused idempotency key are refusals of this message: no retry, no fallback", () => {
    for (const [status, name] of [[400, "validation_error"], [404, "not_found"], [422, "missing_required_field"], [409, "invalid_idempotent_request"]] as const) {
      const e = classifyResendFailure(status, { name }, h());
      expect(e.kind).toBe("rejected");
      expect(e.retryable).toBe(false);
      expect(e.allowsFallback).toBe(false);
    }
  });

  it("429 is a rate limit (with retry-after) unless it names a quota", () => {
    const rate = classifyResendFailure(429, { name: "rate_limit_exceeded" }, h({ "retry-after": "2" }));
    expect(rate).toMatchObject({ kind: "rate_limited", retryAfterMs: 2000 });
    expect(rate.retryable).toBe(true);
    expect(classifyResendFailure(429, { name: "rate_limit_exceeded" }, h()).retryAfterMs).toBe(1000);
    expect(classifyResendFailure(429, { name: "daily_quota_exceeded" }, h()).kind).toBe("quota");
    expect(classifyResendFailure(429, { name: "monthly_quota_exceeded" }, h()).allowsFallback).toBe(false);
  });

  it("5xx is an unknown outcome: retried with the same key, never handed to SMTP", () => {
    for (const status of [500, 502, 503]) {
      const e = classifyResendFailure(status, null, h());
      expect(e.kind).toBe("unknown_outcome");
      expect(e.retryable).toBe(true);
      expect(e.allowsFallback).toBe(false);
    }
  });

  it("a concurrent request with the same key is retried", () => {
    expect(classifyResendFailure(409, { name: "concurrent_idempotent_requests" }, h()).kind).toBe("busy");
  });
});

describe("retryAfterMs", () => {
  it("reads seconds, an HTTP date, or ratelimit-reset", () => {
    expect(retryAfterMs(h({ "retry-after": "1.5" }))).toBe(1500);
    expect(retryAfterMs(h({ "retry-after": new Date(10_000).toUTCString() }), 4_000)).toBe(6_000);
    expect(retryAfterMs(h({ "ratelimit-reset": "3" }))).toBe(3000);
    expect(retryAfterMs(h())).toBeNull();
  });
});
