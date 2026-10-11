import { describe, expect, it } from "vitest";
import { type DayLoad, isOpenNow, localDay, nextOpening, planStarts } from "../src/index.js";

describe("overnight send windows", () => {
  // 22:00–06:00 UTC, opening Monday to Friday evenings.
  const night = { timezone: "UTC", days: [1, 2, 3, 4, 5], from: "22:00", to: "06:00" };

  it("is closed in the middle of the day instead of always open", () => {
    const tueNoon = new Date("2026-10-06T12:00:00Z");
    expect(isOpenNow(night, tueNoon)).toBe(false);
    expect(nextOpening(night, tueNoon).toISOString()).toBe("2026-10-06T22:00:00.000Z");
  });

  it("is open from the evening through the early morning of the next day", () => {
    expect(isOpenNow(night, new Date("2026-10-06T23:30:00Z"))).toBe(true);
    // Wednesday 03:00 is the tail of Tuesday's window.
    expect(isOpenNow(night, new Date("2026-10-07T03:00:00Z"))).toBe(true);
    expect(isOpenNow(night, new Date("2026-10-07T06:00:00Z"))).toBe(false);
  });

  it("names the day a window opens on: Saturday morning is Friday's tail, Monday morning is not", () => {
    expect(isOpenNow(night, new Date("2026-10-10T02:00:00Z"))).toBe(true);
    // Sunday evening has no window, so Monday 02:00 is closed until Monday 22:00.
    const monEarly = new Date("2026-10-12T02:00:00Z");
    expect(isOpenNow(night, monEarly)).toBe(false);
    expect(nextOpening(night, monEarly).toISOString()).toBe("2026-10-12T22:00:00.000Z");
    // Saturday 08:00 waits for Monday evening.
    expect(nextOpening(night, new Date("2026-10-10T08:00:00Z")).toISOString()).toBe("2026-10-12T22:00:00.000Z");
  });

  it("honours the campaign's time zone", () => {
    const dhaka = { ...night, timezone: "Asia/Dhaka" };
    // Tuesday 23:00 Dhaka = 17:00Z (open); Tuesday 12:00 Dhaka = 06:00Z (closed, opens 16:00Z).
    expect(isOpenNow(dhaka, new Date("2026-10-06T17:00:00Z"))).toBe(true);
    expect(nextOpening(dhaka, new Date("2026-10-06T06:00:00Z")).toISOString()).toBe("2026-10-06T16:00:00.000Z");
  });

  it("treats equal open and close as 24 hours on the chosen days", () => {
    const allDay = { timezone: "UTC", days: [1], from: "00:00", to: "00:00" };
    expect(isOpenNow(allDay, new Date("2026-10-05T15:00:00Z"))).toBe(true);
    expect(nextOpening(allDay, new Date("2026-10-06T15:00:00Z")).toISOString()).toBe("2026-10-12T00:00:00.000Z");
  });
});

describe("planStarts (daily new-contact limit)", () => {
  const weekdays = { timezone: "UTC", days: [1, 2, 3, 4, 5], from: "09:00", to: "17:00" };
  const days = (dates: Date[]) => dates.map((d) => localDay(d, "UTC"));
  const count = (dates: Date[]) => days(dates).reduce<Record<string, number>>((m, d) => ({ ...m, [d]: (m[d] ?? 0) + 1 }), {});

  it("does not fold a weekend onto Monday", () => {
    // Enrolled Friday 2026-10-09 10:00 with a limit of 2: Fri 2, Mon 2, Tue 2.
    const floor = new Date("2026-10-09T10:00:00Z");
    const starts = planStarts(weekdays, Array(6).fill(floor), { limit: 2, gapMs: 60_000 });
    expect(count(starts)).toEqual({ "2026-10-09": 2, "2026-10-12": 2, "2026-10-13": 2 });
    expect(starts[0]!.toISOString()).toBe("2026-10-09T10:00:00.000Z");
    expect(starts[1]!.toISOString()).toBe("2026-10-09T10:01:00.000Z");
    expect(starts[2]!.toISOString()).toBe("2026-10-12T09:00:00.000Z");
  });

  it("queues a later batch behind the starts already booked on each day", () => {
    const taken = new Map<string, DayLoad>([
      ["2026-10-09", { count: 1, last: Date.parse("2026-10-09T10:00:00Z") }],
      ["2026-10-12", { count: 2, last: Date.parse("2026-10-12T09:02:00Z") }],
    ]);
    const starts = planStarts(weekdays, Array(3).fill(new Date("2026-10-09T09:00:00Z")), { limit: 2, gapMs: 120_000, taken });
    // One slot left Friday (after the booked one, a gap later); Monday is full; then Tuesday.
    expect(starts.map((d) => d.toISOString())).toEqual(["2026-10-09T10:02:00.000Z", "2026-10-13T09:00:00.000Z", "2026-10-13T09:02:00.000Z"]);
    // The caller's map is left as it was.
    expect(taken.get("2026-10-09")!.count).toBe(1);
  });

  it("moves to the next day when the gap runs past the close", () => {
    const short = { ...weekdays, from: "09:00", to: "09:05" };
    const starts = planStarts(short, Array(4).fill(new Date("2026-10-06T08:00:00Z")), { limit: 10, gapMs: 120_000 });
    expect(starts.map((d) => d.toISOString())).toEqual([
      "2026-10-06T09:00:00.000Z",
      "2026-10-06T09:02:00.000Z",
      "2026-10-06T09:04:00.000Z",
      "2026-10-07T09:00:00.000Z",
    ]);
  });

  it("keeps each item at or after its own floor", () => {
    const starts = planStarts(weekdays, [new Date("2026-10-06T09:00:00Z"), new Date("2026-10-08T12:00:00Z")], { limit: 5, gapMs: 0 });
    expect(starts.map((d) => d.toISOString())).toEqual(["2026-10-06T09:00:00.000Z", "2026-10-08T12:00:00.000Z"]);
  });

  it("plans a long queue in one pass over the days", () => {
    const t0 = Date.now();
    const starts = planStarts(weekdays, Array(5000).fill(new Date("2026-10-05T09:00:00Z")), { limit: 5, gapMs: 60_000 });
    expect(Date.now() - t0).toBeLessThan(5000);
    // 1000 working days, five a day, never more.
    expect(Math.max(...Object.values(count(starts)))).toBe(5);
    expect(new Set(days(starts)).size).toBe(1000);
    expect(starts.every((d) => isOpenNow(weekdays, d))).toBe(true);
  });
});
