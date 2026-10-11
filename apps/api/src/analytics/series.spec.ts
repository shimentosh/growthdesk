import {
  ANALYTICS_MAX_DAYS,
  AnalyticsRangeQuery,
  addLocalDays,
  isLocalDateString,
  localDayDiff,
  localDaysBetween,
  matchPreset,
  presetRange,
  resolveRange,
  startOfLocalDay,
} from "@growthdesk/shared";
import { denseSeries, rate, total } from "./series.js";

describe("local-day arithmetic", () => {
  it("validates real calendar dates only", () => {
    expect(isLocalDateString("2026-10-09")).toBe(true);
    expect(isLocalDateString("2028-02-29")).toBe(true);
    expect(isLocalDateString("2026-02-29")).toBe(false);
    expect(isLocalDateString("2026-13-01")).toBe(false);
    expect(isLocalDateString("2026-1-01")).toBe(false);
    expect(isLocalDateString("yesterday")).toBe(false);
  });

  it("adds days across month and year ends and counts the span", () => {
    expect(addLocalDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addLocalDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(localDayDiff("2026-10-01", "2026-10-31")).toBe(30);
    expect(localDaysBetween("2026-10-30", "2026-11-02")).toEqual(["2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02"]);
    expect(localDaysBetween("2026-10-02", "2026-10-01")).toEqual([]);
  });
});

describe("AnalyticsRangeQuery", () => {
  it("accepts an open or closed range and refuses reversed or over-long ones", () => {
    expect(AnalyticsRangeQuery.safeParse({}).success).toBe(true);
    expect(AnalyticsRangeQuery.safeParse({ from: "2026-10-01", to: "2026-10-01" }).success).toBe(true);
    expect(AnalyticsRangeQuery.safeParse({ from: "2026-10-02", to: "2026-10-01" }).success).toBe(false);
    expect(AnalyticsRangeQuery.safeParse({ from: "2025-01-01", to: addLocalDays("2025-01-01", ANALYTICS_MAX_DAYS - 1) }).success).toBe(true);
    expect(AnalyticsRangeQuery.safeParse({ from: "2025-01-01", to: addLocalDays("2025-01-01", ANALYTICS_MAX_DAYS) }).success).toBe(false);
    expect(AnalyticsRangeQuery.safeParse({ from: "2026-02-30" }).success).toBe(false);
  });
});

describe("resolveRange (workspace time zone)", () => {
  // 2026-10-10 02:00Z is still Oct 9 in New York (UTC-4) and already Oct 10 in Dhaka (UTC+6).
  const now = new Date("2026-10-10T02:00:00Z");

  it("defaults to the last 30 local days ending today in the zone", () => {
    const ny = resolveRange({}, "America/New_York", now);
    expect(ny).toMatchObject({ from: "2026-09-10", to: "2026-10-09", days: 30, timeZone: "America/New_York" });
    const dhaka = resolveRange({}, "Asia/Dhaka", now);
    expect(dhaka).toMatchObject({ from: "2026-09-11", to: "2026-10-10", days: 30 });
  });

  it("turns local days into a half-open UTC interval", () => {
    const r = resolveRange({ from: "2026-10-01", to: "2026-10-07" }, "Asia/Dhaka", now);
    expect(r.start.toISOString()).toBe("2026-09-30T18:00:00.000Z");
    expect(r.end.toISOString()).toBe("2026-10-07T18:00:00.000Z");
    expect(r.days).toBe(7);
  });

  it("keeps whole local days across a DST change (a 23-hour and a 25-hour day)", () => {
    // Europe/London leaves summer time on Sunday 2026-10-25.
    const r = resolveRange({ from: "2026-10-25", to: "2026-10-25" }, "Europe/London", now);
    expect(r.start.toISOString()).toBe("2026-10-24T23:00:00.000Z");
    expect(r.end.toISOString()).toBe("2026-10-26T00:00:00.000Z");
    expect((r.end.getTime() - r.start.getTime()) / 3_600_000).toBe(25);
    // ...and enters it on Sunday 2026-03-29.
    expect((startOfLocalDay("2026-03-30", "Europe/London").getTime() - startOfLocalDay("2026-03-29", "Europe/London").getTime()) / 3_600_000).toBe(23);
  });

  it("fills a missing end or start and falls back to UTC for an unknown zone", () => {
    expect(resolveRange({ to: "2026-06-30" }, "UTC", now)).toMatchObject({ from: "2026-06-01", to: "2026-06-30" });
    expect(resolveRange({ from: "2026-10-01" }, "UTC", now)).toMatchObject({ from: "2026-10-01", to: "2026-10-10" });
    // A start in the future ends on itself rather than producing a reversed range.
    expect(resolveRange({ from: "2026-12-01" }, "UTC", now)).toMatchObject({ from: "2026-12-01", to: "2026-12-01", days: 1 });
    expect(resolveRange({}, "Mars/Olympus", now).timeZone).toBe("UTC");
  });

  it("cuts a one-sided range that would exceed the maximum", () => {
    const r = resolveRange({ from: "2020-01-01" }, "UTC", now);
    expect(r.days).toBe(ANALYTICS_MAX_DAYS);
    expect(r.to).toBe("2026-10-10");
  });
});

describe("presets", () => {
  it("computes calendar presets from today's local date", () => {
    expect(presetRange("7d", "2026-10-10")).toEqual({ from: "2026-10-04", to: "2026-10-10" });
    expect(presetRange("mtd", "2026-10-10")).toEqual({ from: "2026-10-01", to: "2026-10-10" });
    expect(presetRange("last_month", "2026-03-15")).toEqual({ from: "2026-02-01", to: "2026-02-28" });
    expect(presetRange("last_month", "2026-01-05")).toEqual({ from: "2025-12-01", to: "2025-12-31" });
    expect(presetRange("qtd", "2026-11-20")).toEqual({ from: "2026-10-01", to: "2026-11-20" });
    expect(presetRange("ytd", "2026-10-10")).toEqual({ from: "2026-01-01", to: "2026-10-10" });
    expect(matchPreset({ from: "2026-09-11", to: "2026-10-10" }, "2026-10-10")).toBe("30d");
    expect(matchPreset({ from: "2026-09-12", to: "2026-10-10" }, "2026-10-10")).toBeNull();
  });
});

describe("denseSeries (daily buckets)", () => {
  it("has every day of the range, zero-fills gaps, adds duplicates and drops strays", () => {
    const series = denseSeries(
      { from: "2026-10-01", to: "2026-10-04" },
      {
        sent: [
          { day: "2026-10-01", n: 3 },
          { day: "2026-10-03", n: 2 },
          { day: "2026-10-03", n: 1 },
          { day: "2026-09-30", n: 99 },
        ],
        replies: [{ day: "2026-10-04", n: 1 }],
      },
    );
    expect(series).toEqual([
      { date: "2026-10-01", sent: 3, replies: 0 },
      { date: "2026-10-02", sent: 0, replies: 0 },
      { date: "2026-10-03", sent: 3, replies: 0 },
      { date: "2026-10-04", sent: 0, replies: 1 },
    ]);
  });

  it("totals and rates", () => {
    expect(total([{ day: "a", n: 2 }, { day: "b", n: 5 }])).toBe(7);
    expect(rate(1, 3)).toBe(0.3333);
    expect(rate(0, 0)).toBeNull();
  });
});
