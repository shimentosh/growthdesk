import { describe, expect, it } from "vitest";
import { PlatformAudienceFilter } from "@growthdesk/shared";
import { audienceFromWhere, filterConditions, marketingRule, userIdIn } from "./audience-sql.js";

const squash = (s: string) => s.replace(/\s+/g, " ").trim();

describe("audience SQL", () => {
  it("an empty filter is exactly the marketing rule", () => {
    const sql = audienceFromWhere(PlatformAudienceFilter.parse({}));
    expect(squash(sql.text)).toBe(
      'FROM "User" u JOIN "PlatformUserProfile" p ON p."userId" = u.id WHERE p."marketingConsent" IS TRUE AND p."unsubscribedAt" IS NULL AND p."suppressedAt" IS NULL AND p."anonymisedAt" IS NULL AND u."suspendedAt" IS NULL AND u."emailVerifiedAt" IS NOT NULL',
    );
    expect(sql.values).toEqual([]);
    expect(audienceFromWhere(null).sql).toBe(sql.sql);
  });

  it("the rule cannot be removed by any filter", () => {
    const f = PlatformAudienceFilter.parse({
      plans: ["pro"],
      subscriptionStatuses: ["trialing"],
      signedUpAfter: "2026-01-01T00:00:00Z",
      signedUpBefore: "2026-02-01T00:00:00Z",
      lastLoginAfter: "2026-03-01T00:00:00Z",
      lastLoginBefore: "2026-04-01T00:00:00Z",
      workspacesMin: 1,
      workspacesMax: 3,
      tagsAny: ["VIP", "beta"],
      signupSources: ["google"],
    });
    const sql = audienceFromWhere(f);
    expect(sql.sql).toContain(marketingRule().sql);
    expect(squash(sql.text)).toContain("pl.key IN ($1) AND s.status::text IN ($2)");
    expect(sql.values).toEqual([
      "pro",
      "trialing",
      "2026-01-01T00:00:00.000Z",
      "2026-02-01T00:00:00.000Z",
      "2026-03-01T00:00:00.000Z",
      "2026-04-01T00:00:00.000Z",
      1,
      3,
      "vip",
      "beta",
      "google",
    ]);
    expect(squash(sql.text)).toContain(`u."createdAt" >= ($3::timestamptz AT TIME ZONE 'UTC')`);
    expect(squash(sql.text)).toContain(`u."lastLoginAt" <= ($6::timestamptz AT TIME ZONE 'UTC')`);
    expect(squash(sql.text)).toContain(`p.tags && ARRAY[$9,$10]::text[]`);
    expect(squash(sql.text)).toContain(`p."signupSource" IN ($11)`);
  });

  it("plans and statuses alone each make one EXISTS; values are parameters, never inlined", () => {
    const plans = filterConditions({ plans: ["x'); DROP TABLE \"User\"; --"] });
    expect(plans).toHaveLength(1);
    expect(plans[0]!.sql).not.toContain("DROP");
    expect(plans[0]!.values).toEqual(["x'); DROP TABLE \"User\"; --"]);
    const statuses = filterConditions({ subscriptionStatuses: ["active", "past_due"] });
    expect(squash(statuses[0]!.text)).toContain("s.status::text IN ($1,$2)");
    expect(squash(statuses[0]!.text)).not.toContain("pl.key");
  });

  it("zero is a real workspace bound; null means no bound", () => {
    expect(filterConditions({ workspacesMin: 0 })).toHaveLength(1);
    expect(filterConditions({ workspacesMin: null, workspacesMax: null })).toHaveLength(0);
  });

  it("extra conditions (an id list) are AND-ed after the rule", () => {
    const sql = audienceFromWhere(null, [userIdIn(["0190a3c4-1b2c-7d3e-8f40-0123456789ab"])]);
    expect(squash(sql.text)).toMatch(/IS NOT NULL AND u\.id IN \(\$1::uuid\)$/);
  });

  it("the shared filter schema refuses min > max and normalises tags", () => {
    expect(PlatformAudienceFilter.safeParse({ workspacesMin: 3, workspacesMax: 1 }).success).toBe(false);
    expect(PlatformAudienceFilter.parse({ tagsAny: [" Early Adopter "] }).tagsAny).toEqual(["early-adopter"]);
    expect(PlatformAudienceFilter.safeParse({ signedUpAfter: "not a date" }).success).toBe(false);
  });
});
