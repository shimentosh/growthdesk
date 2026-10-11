import { afterEach, describe, expect, it, vi } from "vitest";
import { createLogger, logLevels, requestIdFrom, withRequestId } from "./logger.js";

/** Captures what the logger writes to stdout/stderr. */
function capture() {
  const lines: string[] = [];
  const grab = (chunk: string | Uint8Array) => {
    lines.push(String(chunk));
    return true;
  };
  vi.spyOn(process.stdout, "write").mockImplementation(grab as typeof process.stdout.write);
  vi.spyOn(process.stderr, "write").mockImplementation(grab as typeof process.stderr.write);
  return lines;
}

afterEach(() => vi.restoreAllMocks());

describe("requestIdFrom", () => {
  it("keeps a caller's id that is safe to log and echo", () => {
    expect(requestIdFrom("abc-123_X.y:z@q")).toBe("abc-123_X.y:z@q");
    expect(requestIdFrom(["first", "second"])).toBe("first");
  });

  it("replaces a missing, oversized or unsafe id with a UUID", () => {
    for (const bad of [undefined, "", "a".repeat(129), "has space", "line\nbreak", '{"json":1}']) {
      expect(requestIdFrom(bad)).toMatch(/^[0-9a-f-]{36}$/);
    }
  });
});

describe("AppLogger", () => {
  it("in JSON mode writes one object per line with time, service, level, context, message and the request id", () => {
    const lines = capture();
    const log = createLogger({ LOG_LEVEL: "log", LOG_FORMAT: undefined, NODE_ENV: "production" }, "api");
    withRequestId("req-1", () => log.log("hello", { queue: "mail" }, "jobs"));
    log.warn("outside a request", "jobs");
    const [inside, outside] = lines.map((l) => JSON.parse(l));
    expect(inside).toMatchObject({ service: "api", level: "log", context: "jobs", message: "hello", requestId: "req-1", queue: "mail" });
    expect(new Date(inside.time).toISOString()).toBe(inside.time);
    expect(outside.requestId).toBeUndefined();
    expect(lines.every((l) => l.endsWith("\n") && !l.trimEnd().includes("\n"))).toBe(true);
  });

  it("puts an error's stack in the same JSON line", () => {
    const lines = capture();
    const log = createLogger({ LOG_LEVEL: "error", LOG_FORMAT: "json", NODE_ENV: "development" }, "worker");
    const err = new Error("boom");
    withRequestId("req-2", () => log.error("unhandled on GET /x", err.stack, "api"));
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ service: "worker", level: "error", requestId: "req-2", stack: expect.stringContaining("Error: boom") });
  });

  it("in pretty mode shows the request id after the context", () => {
    const lines = capture();
    const log = createLogger({ LOG_LEVEL: "log", LOG_FORMAT: "pretty", NODE_ENV: "production" }, "api");
    withRequestId("req-3", () => log.log("hello", "http"));
    expect(lines.join("")).toContain("(req-3)");
    expect(() => JSON.parse(lines[0]!)).toThrow();
  });

  it("maps LOG_LEVEL to the levels at and above it", () => {
    expect(logLevels("error")).toEqual(["fatal", "error"]);
    expect(logLevels("log")).toEqual(["fatal", "error", "warn", "log"]);
    expect(logLevels("debug")).toContain("verbose");
  });
});
