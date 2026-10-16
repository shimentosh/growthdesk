import { describe, expect, it } from "vitest";
import { LeadRoutingInput, leastLoaded, nextInTurn, routeFor, ruleMatches } from "../src/lead-routing.js";

const u = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;
const facts = { leadSource: "Clientdesk · Website", lists: ["Website · Contact"], tags: ["SEO", "brand"], country: "BD" };

describe("lead routing", () => {
  it("matches every non-empty group, any value within one, ignoring case", () => {
    const when = (w: Record<string, string[]>) => LeadRoutingInput.parse({ enabled: true, rules: [{ id: "r1xx", name: "x", when: w, assign: { userIds: [u(1)] } }] }).rules[0]!.when;
    expect(ruleMatches(when({ leadSources: ["clientdesk"] }), facts)).toBe(true);
    expect(ruleMatches(when({ leadSources: ["clientdesk"], countries: ["US"] }), facts)).toBe(false);
    expect(ruleMatches(when({ lists: ["website · contact", "Other"], tags: ["seo"] }), facts)).toBe(true);
    expect(ruleMatches(when({}), facts)).toBe(true);
  });

  it("takes the first enabled matching rule, else the fallback", () => {
    const cfg = LeadRoutingInput.parse({
      enabled: true,
      rules: [
        { id: "off1", name: "Off", enabled: false, when: { tags: ["SEO"] }, assign: { userIds: [u(1)] } },
        { id: "bd01", name: "Bangladesh", when: { countries: ["bd"] }, assign: { mode: "balanced", userIds: [u(2), u(3)] } },
      ],
      fallback: { mode: "user", userIds: [u(4)] },
    });
    expect(routeFor(cfg, facts)?.rule?.name).toBe("Bangladesh");
    expect(routeFor(cfg, { ...facts, country: "US" })).toMatchObject({ rule: null, assign: { userIds: [u(4)] } });
    expect(routeFor({ ...cfg, fallback: null }, { ...facts, country: "US" })).toBeNull();
  });

  it("refuses several people for a single-person assignment", () => {
    expect(() => LeadRoutingInput.parse({ enabled: true, rules: [{ id: "r1xx", name: "x", when: {}, assign: { mode: "user", userIds: [u(1), u(2)] } }] })).toThrow();
  });

  it("takes turns and balances load", () => {
    expect(nextInTurn([u(1), u(2), u(3)], null)).toBe(u(1));
    expect(nextInTurn([u(1), u(2), u(3)], u(3))).toBe(u(1));
    expect(nextInTurn([u(1), u(2)], u(9))).toBe(u(1));
    expect(leastLoaded([u(1), u(2), u(3)], new Map([[u(1), 4], [u(2), 1], [u(3), 1]]))).toBe(u(2));
  });
});
