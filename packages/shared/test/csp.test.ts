import { describe, expect, it } from "vitest";
import { ANALYTICS_CONNECT_HOSTS, contentSecurityPolicy } from "../src/index.js";

const directive = (policy: string, name: string) =>
  policy
    .split("; ")
    .find((d) => d.startsWith(`${name} `))
    ?.split(" ")
    .slice(1) ?? [];

describe("contentSecurityPolicy", () => {
  const prod = contentSecurityPolicy({ nonce: "abc123", connect: ANALYTICS_CONNECT_HOSTS });

  it("runs scripts only with the nonce: no inline script, no eval", () => {
    const scripts = directive(prod, "script-src");
    expect(scripts).toContain("'nonce-abc123'");
    expect(scripts).toContain("'strict-dynamic'");
    expect(scripts).not.toContain("'unsafe-inline'");
    expect(scripts).not.toContain("'unsafe-eval'");
  });

  it("forbids framing, plugins, base rewrites and foreign form targets", () => {
    expect(directive(prod, "frame-ancestors")).toEqual(["'none'"]);
    expect(directive(prod, "object-src")).toEqual(["'none'"]);
    expect(directive(prod, "base-uri")).toEqual(["'self'"]);
    expect(directive(prod, "form-action")).toEqual(["'self'"]);
  });

  it("lets the analytics hosts be reached only when asked", () => {
    expect(directive(prod, "connect-src")).toContain("https://plausible.io");
    expect(directive(contentSecurityPolicy({ nonce: "n" }), "connect-src")).toEqual(["'self'"]);
  });

  it("allows eval and the hot-reload socket in development only", () => {
    const dev = contentSecurityPolicy({ nonce: "n", dev: true });
    expect(directive(dev, "script-src")).toContain("'unsafe-eval'");
    expect(directive(dev, "connect-src")).toContain("ws:");
    expect(directive(prod, "connect-src")).not.toContain("ws:");
  });
});
