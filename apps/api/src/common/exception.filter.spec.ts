import { describe, expect, it, vi } from "vitest";
import { type ArgumentsHost, Logger } from "@nestjs/common";
import { ApiExceptionFilter } from "./exception.filter.js";

function run(thrown: unknown, headers: Record<string, string> = {}) {
  const out: { status?: number; body?: { error: { code: string; message: string } } } = {};
  const response = {
    setHeader: () => response,
    status(code: number) {
      out.status = code;
      return response;
    },
    json(body: never) {
      out.body = body;
      return response;
    },
  };
  const host = { switchToHttp: () => ({ getRequest: () => ({ method: "POST", path: "/v1/x", headers }), getResponse: () => response }) } as unknown as ArgumentsHost;
  new ApiExceptionFilter().catch(thrown, host);
  return out;
}

describe("ApiExceptionFilter", () => {
  it("answers a payment provider's error as 502, whatever status the provider used", () => {
    const stripeAuth = Object.assign(new Error("Invalid API Key provided"), { type: "StripeAuthenticationError", statusCode: 401 });
    expect(run(stripeAuth)).toMatchObject({ status: 502, body: { error: { code: "upstream_error" } } });
    const stripeDown = Object.assign(new Error("connect ETIMEDOUT"), { type: "StripeConnectionError" });
    expect(run(stripeDown).status).toBe(502);
  });

  it("still maps body-parser errors to 4xx", () => {
    expect(run(Object.assign(new Error("bad json"), { type: "entity.parse.failed", status: 400 }))).toMatchObject({ status: 400, body: { error: { message: "The request body is not valid JSON" } } });
    expect(run(Object.assign(new Error("too big"), { type: "entity.too.large", status: 413 })).status).toBe(413);
  });

  it("does not trust a 4xx status on other libraries' errors", () => {
    expect(run(Object.assign(new Error("x"), { type: "SomethingElse", statusCode: 401 })).status).toBe(500);
  });

  it("logs an unhandled error with its stack and the request id; the client gets neither", () => {
    const error = vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    try {
      const out = run(new Error("db exploded"), { "x-request-id": "req-500" });
      expect(out).toMatchObject({ status: 500, body: { error: { code: "server_error", message: "Something went wrong" } } });
      expect(String(error.mock.calls[0]![0])).toBe("unhandled on POST /v1/x [request req-500]");
      expect(String(error.mock.calls[0]![1])).toContain("Error: db exploded");
    } finally {
      error.mockRestore();
    }
  });
});
