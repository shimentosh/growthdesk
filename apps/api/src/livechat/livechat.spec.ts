import { describe, expect, it } from "vitest";
import { WIDGET_DEFAULTS } from "@growthdesk/shared";
import { hostAllowed, siteOf, widgetSettings } from "./livechat.service.js";

describe("hostAllowed", () => {
  it("allows any site when the list is empty", () => {
    expect(hostAllowed([], "anything.test")).toBe(true);
    expect(hostAllowed([], null)).toBe(true);
  });

  it("allows the domain and its subdomains, ignoring the port", () => {
    expect(hostAllowed(["example.com"], "example.com")).toBe(true);
    expect(hostAllowed(["example.com"], "www.example.com:8080")).toBe(true);
    expect(hostAllowed(["example.com"], "EXAMPLE.com")).toBe(true);
  });

  it("refuses look-alikes and a missing host", () => {
    expect(hostAllowed(["example.com"], "badexample.com")).toBe(false);
    expect(hostAllowed(["example.com"], "example.com.evil.test")).toBe(false);
    expect(hostAllowed(["example.com"], "")).toBe(false);
    expect(hostAllowed(["example.com"], undefined)).toBe(false);
  });

  it("matches host and port exactly when the entry has a port", () => {
    expect(hostAllowed(["localhost:3000"], "localhost:3000")).toBe(true);
    expect(hostAllowed(["localhost:3000"], "localhost:4000")).toBe(false);
  });
});

describe("siteOf", () => {
  it("prefers the reported host, without port or www", () => {
    expect(siteOf("www.Shop.example.com:8080", "https://other.test/x")).toBe("shop.example.com");
  });
  it("falls back to the page URL, and to nothing", () => {
    expect(siteOf(null, "https://www.landing.example.org/offer?a=1")).toBe("landing.example.org");
    expect(siteOf("", "not a url")).toBe("");
  });
});

describe("widgetSettings", () => {
  it("fills defaults under stored values", () => {
    const s = widgetSettings({ config: { title: "Hi", preChat: "required" } });
    expect(s.title).toBe("Hi");
    expect(s.preChat).toBe("required");
    expect(s.color).toBe(WIDGET_DEFAULTS.color);
    expect(s.allowedDomains).toEqual([]);
    expect(s.tagIds).toEqual([]);
  });
});
