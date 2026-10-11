import { describe, expect, it } from "vitest";
import {
  ALL_PERMISSIONS,
  DEFAULT_ROLE_PERMISSIONS,
  localDay,
  missingVariables,
  nextOpening,
  normalizeCompanyName,
  normalizeDomain,
  normalizeEmail,
  normalizePhone,
  permissionsFor,
  renderTemplate,
  rolePermissionTrouble,
  splitName,
  unknownVariables,
  variablesFor,
  zonedTime,
} from "../src/index.js";

describe("nextOpening (time-zone aware)", () => {
  const weekdays = { timezone: "Asia/Dhaka", days: [1, 2, 3, 4, 5], from: "09:00", to: "17:00" };

  it("returns the moment itself when it is inside the window", () => {
    // Tuesday 2026-10-06 11:00 in Dhaka (UTC+6) is 05:00Z.
    const at = new Date("2026-10-06T05:00:00Z");
    expect(nextOpening(weekdays, at).toISOString()).toBe(at.toISOString());
  });

  it("moves an early-morning moment to that day's opening in the campaign's zone", () => {
    // 01:00Z Tuesday = 07:00 Dhaka → opens 09:00 Dhaka = 03:00Z.
    expect(nextOpening(weekdays, new Date("2026-10-06T01:00:00Z")).toISOString()).toBe("2026-10-06T03:00:00.000Z");
  });

  it("moves an evening moment to the next working day", () => {
    // Friday 2026-10-09 18:00 Dhaka = 12:00Z → Monday 09:00 Dhaka = 03:00Z on the 12th.
    expect(nextOpening(weekdays, new Date("2026-10-09T12:00:00Z")).toISOString()).toBe("2026-10-12T03:00:00.000Z");
  });

  it("is unaffected by where the server is and honours DST", () => {
    // New York leaves DST on 2026-11-01. Monday 2nd 09:00 EST = 14:00Z.
    const ny = { timezone: "America/New_York", days: [1, 2, 3, 4, 5], from: "09:00", to: "17:00" };
    expect(nextOpening(ny, new Date("2026-10-31T20:00:00Z")).toISOString()).toBe("2026-11-02T14:00:00.000Z");
    // Friday 30 Oct 09:00 EDT = 13:00Z.
    expect(nextOpening(ny, new Date("2026-10-30T05:00:00Z")).toISOString()).toBe("2026-10-30T13:00:00.000Z");
  });

  it("resolves local wall-clock times and calendar days", () => {
    expect(zonedTime(2026, 7, 1, 9, 0, "Europe/London").toISOString()).toBe("2026-07-01T08:00:00.000Z");
    expect(localDay(new Date("2026-10-09T20:00:00Z"), "Asia/Dhaka")).toBe("2026-10-10");
  });
});

describe("personalisation", () => {
  const vars = variablesFor(
    { firstName: "Ada", lastName: "", company: { name: "Analytical Engines", domain: "ae.example" }, customFields: { Plan: "Pro" } },
    { senderName: "Noor" },
  );

  it("fills tokens, honours fallbacks and leaves unresolved tokens visible", () => {
    expect(renderTemplate("Hi {{first_name}} at {{ company }}", vars)).toBe("Hi Ada at Analytical Engines");
    expect(renderTemplate("Hi {{last_name|there}}", vars)).toBe("Hi there");
    expect(renderTemplate("{{job_title}} role", vars)).toBe("{{job_title}} role");
    expect(renderTemplate("On {{custom.plan}}", vars)).toBe("On Pro");
  });

  it("reports missing and unknown variables before a send", () => {
    expect(missingVariables("{{first_name}} {{job_title}} {{last_name|x}}", vars)).toEqual(["job_title"]);
    expect(unknownVariables("{{first_name}} {{favourite_colour}} {{custom.plan}}", ["plan"])).toEqual(["favourite_colour"]);
  });
});

describe("normalisation", () => {
  it("normalises emails and refuses non-addresses", () => {
    expect(normalizeEmail("  Ada@Example.COM ")).toBe("ada@example.com");
    expect(normalizeEmail("mailto:<bob@x.io>")).toBe("bob@x.io");
    expect(normalizeEmail("not an email")).toBeNull();
  });

  it("normalises phones to E.164 with a default country", () => {
    expect(normalizePhone("+1 (415) 555-2671")).toBe("+14155552671");
    expect(normalizePhone("01712-345678", "BD")).toBe("+8801712345678");
    expect(normalizePhone("0044 20 7946 0958")).toBe("+442079460958");
    expect(normalizePhone("12")).toBeNull();
  });

  it("normalises domains and company names", () => {
    expect(normalizeDomain("https://www.Example.com/about?x=1")).toBe("example.com");
    expect(normalizeDomain("someone@acme.io")).toBe("acme.io");
    expect(normalizeDomain("nonsense")).toBeNull();
    expect(normalizeCompanyName("Acme, Inc.")).toBe(normalizeCompanyName("ACME Inc"));
  });

  it("splits names", () => {
    expect(splitName("Ada King Lovelace")).toEqual({ firstName: "Ada", lastName: "King Lovelace" });
  });
});

describe("permissions", () => {
  it("gives the owner everything and keeps billing.manage owner-only", () => {
    expect(permissionsFor("owner")).toEqual([...ALL_PERMISSIONS]);
    expect(permissionsFor("admin")).not.toContain("billing.manage");
    expect(permissionsFor("member", { member: ["contacts.read", "billing.manage"] })).toEqual(["contacts.read"]);
  });

  it("keeps every default role well-formed", () => {
    for (const [role, list] of Object.entries(DEFAULT_ROLE_PERMISSIONS)) {
      if (role === "owner") continue;
      expect(rolePermissionTrouble([...list]), role).toBeNull();
    }
  });

  it("refuses an action without its read and unknown ids", () => {
    expect(rolePermissionTrouble(["contacts.write"])).toMatch(/contacts.read/);
    expect(rolePermissionTrouble(["nope.read"])).toMatch(/Unknown/);
    expect(rolePermissionTrouble(["billing.read", "billing.manage"])).toMatch(/owner/);
  });

  it("gives viewers read-only access", () => {
    expect(DEFAULT_ROLE_PERMISSIONS.viewer.every((p) => p.endsWith(".read") || p === "records.view_all")).toBe(true);
  });

  it("keeps the audit log and billing away from viewers", () => {
    expect(permissionsFor("viewer")).not.toContain("audit.read");
    expect(permissionsFor("viewer")).not.toContain("billing.read");
  });
});
