import { describe, expect, it } from "vitest";
import {
  BookingPageInput,
  computeSlots,
  groupSlotsByDay,
  hostSlots,
  isSlotAvailable,
  isValidBookingSlug,
  mergeBusy,
  pickHost,
  readAvailability,
  slugifyBooking,
  type SlotRules,
} from "../src/index.js";

const H = 3_600_000;
const iso = (d: Date) => d.toISOString();

/** Mon–Fri 09:00–12:00 UTC, 30-minute meetings every 30 minutes, no notice, a year ahead. */
const rules = (over: Partial<SlotRules> = {}): SlotRules => ({
  availability: { timezone: "UTC", hours: [1, 2, 3, 4, 5].map((day) => ({ day, from: "09:00", to: "12:00" })) },
  durationMinutes: 30,
  bufferBeforeMinutes: 0,
  bufferAfterMinutes: 0,
  minNoticeMinutes: 0,
  maxDaysAhead: 365,
  slotStepMinutes: 30,
  ...over,
});

// Monday 12 October 2026.
const MON = new Date("2026-10-12T00:00:00Z");
const day = (from: Date) => ({ from, to: new Date(from.getTime() + 24 * H) });
const NOW = new Date("2026-10-01T00:00:00Z");

describe("booking slots", () => {
  it("cuts each weekday window into steps that fit the whole meeting", () => {
    const slots = computeSlots(rules(), day(MON), [], NOW).map(iso);
    expect(slots).toEqual(["09:00", "09:30", "10:00", "10:30", "11:00", "11:30"].map((t) => `2026-10-12T${t}:00.000Z`));
    // A 45-minute meeting every 30 minutes: 11:30 would run past noon.
    expect(computeSlots(rules({ durationMinutes: 45 }), day(MON), [], NOW).map(iso).at(-1)).toBe("2026-10-12T11:00:00.000Z");
    // Sunday has no hours.
    expect(computeSlots(rules(), day(new Date("2026-10-11T00:00:00Z")), [], NOW)).toEqual([]);
  });

  it("removes slots that overlap busy times, including the buffers around them", () => {
    const busy = [{ start: Date.parse("2026-10-12T10:00:00Z"), end: Date.parse("2026-10-12T10:30:00Z") }];
    expect(computeSlots(rules(), day(MON), busy, NOW).map(iso)).not.toContain("2026-10-12T10:00:00.000Z");
    expect(computeSlots(rules(), day(MON), busy, NOW).map(iso)).toContain("2026-10-12T09:30:00.000Z");
    // 15 minutes after each meeting: 09:30–10:00 + 15 runs into the busy 10:00.
    const buffered = computeSlots(rules({ bufferAfterMinutes: 15 }), day(MON), busy, NOW).map(iso);
    expect(buffered).not.toContain("2026-10-12T09:30:00.000Z");
    // 15 minutes before: 10:30 starts right as the busy time ends, so its lead-in overlaps.
    expect(computeSlots(rules({ bufferBeforeMinutes: 15 }), day(MON), busy, NOW).map(iso)).not.toContain("2026-10-12T10:30:00.000Z");
    expect(computeSlots(rules(), day(MON), busy, NOW).map(iso)).toContain("2026-10-12T10:30:00.000Z");
  });

  it("honours minimum notice and how far ahead the page books", () => {
    const now = new Date("2026-10-12T09:10:00Z");
    // Four hours of notice from 09:10: nothing before 13:10, so nothing on Monday morning.
    expect(computeSlots(rules({ minNoticeMinutes: 240 }), day(MON), [], now)).toEqual([]);
    expect(computeSlots(rules({ minNoticeMinutes: 60 }), day(MON), [], now).map(iso)[0]).toBe("2026-10-12T10:30:00.000Z");
    // Two days ahead from Monday 09:10: Wednesday 09:00 is still inside, Thursday is not.
    const week = { from: MON, to: new Date(MON.getTime() + 7 * 24 * H) };
    const slots = computeSlots(rules({ maxDaysAhead: 2 }), week, [], now).map(iso);
    expect(slots).toContain("2026-10-14T09:00:00.000Z");
    expect(slots.some((s) => s.startsWith("2026-10-15"))).toBe(false);
  });

  it("reads the hours in the page's time zone, across a DST change", () => {
    // Europe/Berlin leaves summer time on Sunday 25 October 2026.
    const berlin = rules({ availability: { timezone: "Europe/Berlin", hours: [{ day: 5, from: "09:00", to: "10:00" }, { day: 1, from: "09:00", to: "10:00" }] } });
    const fri = computeSlots(berlin, day(new Date("2026-10-23T00:00:00Z")), [], NOW).map(iso);
    const mon = computeSlots(berlin, day(new Date("2026-10-26T00:00:00Z")), [], NOW).map(iso);
    expect(fri).toEqual(["2026-10-23T07:00:00.000Z", "2026-10-23T07:30:00.000Z"]); // UTC+2
    expect(mon).toEqual(["2026-10-26T08:00:00.000Z", "2026-10-26T08:30:00.000Z"]); // UTC+1
  });

  it("finds windows that fall on the visitor's previous local day", () => {
    // Tokyo 09:00 Monday is Monday 00:00 UTC, and Sunday 17:00 in Los Angeles.
    const tokyo = rules({ availability: { timezone: "Asia/Tokyo", hours: [{ day: 1, from: "09:00", to: "10:00" }] } });
    const slots = computeSlots(tokyo, { from: new Date("2026-10-11T20:00:00Z"), to: new Date("2026-10-12T02:00:00Z") }, [], NOW).map(iso);
    expect(slots).toEqual(["2026-10-12T00:00:00.000Z", "2026-10-12T00:30:00.000Z"]);
    expect(groupSlotsByDay(slots.map((s) => new Date(s)), "Asia/Tokyo")).toEqual([{ date: "2026-10-12", slots }]);
    expect(groupSlotsByDay(slots.map((s) => new Date(s)), "America/Los_Angeles")).toEqual([{ date: "2026-10-11", slots }]);
  });

  it("supports a window that runs to midnight", () => {
    const late = rules({ availability: { timezone: "UTC", hours: [{ day: 1, from: "23:00", to: "24:00" }] } });
    expect(computeSlots(late, day(MON), [], NOW).map(iso)).toEqual(["2026-10-12T23:00:00.000Z", "2026-10-12T23:30:00.000Z"]);
  });

  it("re-checks one start for a booking", () => {
    expect(isSlotAvailable(rules(), new Date("2026-10-12T09:30:00Z"), [], NOW)).toBe(true);
    // Not on the step grid, outside the hours, or busy.
    expect(isSlotAvailable(rules(), new Date("2026-10-12T09:10:00Z"), [], NOW)).toBe(false);
    expect(isSlotAvailable(rules(), new Date("2026-10-12T13:00:00Z"), [], NOW)).toBe(false);
    expect(isSlotAvailable(rules(), new Date("2026-10-12T09:30:00Z"), [{ start: Date.parse("2026-10-12T09:45:00Z"), end: Date.parse("2026-10-12T09:50:00Z") }], NOW)).toBe(false);
  });

  it("merges busy intervals", () => {
    expect(mergeBusy([{ start: 5, end: 9 }, { start: 1, end: 3 }, { start: 3, end: 6 }, { start: 20, end: 10 }])).toEqual([{ start: 1, end: 9 }]);
  });
});

describe("round robin", () => {
  it("takes the next free host in page order and moves the cursor past them", () => {
    expect(pickHost(["a", "b", "c"], 0, ["a", "b", "c"])).toEqual({ hostId: "a", nextCursor: 1 });
    expect(pickHost(["a", "b", "c"], 1, ["a", "c"])).toEqual({ hostId: "c", nextCursor: 0 });
    expect(pickHost(["a", "b", "c"], 2, ["a", "b"])).toEqual({ hostId: "a", nextCursor: 1 });
    expect(pickHost(["a", "b", "c"], 7, ["b"])).toEqual({ hostId: "b", nextCursor: 2 });
    expect(pickHost(["a", "b"], 0, [])).toBeNull();
    expect(pickHost([], 0, ["a"])).toBeNull();
  });

  it("offers a slot when any host is free, naming who", () => {
    const busyA = [{ start: Date.parse("2026-10-12T09:00:00Z"), end: Date.parse("2026-10-12T10:00:00Z") }];
    const slots = hostSlots(rules({ availability: { timezone: "UTC", hours: [{ day: 1, from: "09:00", to: "10:30" }] } }), day(MON), new Map([["a", busyA], ["b", []]]), NOW);
    expect([...slots.entries()].map(([t, hosts]) => [new Date(t).toISOString(), hosts])).toEqual([
      ["2026-10-12T09:00:00.000Z", ["b"]],
      ["2026-10-12T09:30:00.000Z", ["b"]],
      ["2026-10-12T10:00:00.000Z", ["a", "b"]],
    ]);
  });
});

describe("booking page input", () => {
  const base = { title: "Intro call", slug: "intro-call", hostUserIds: ["0190a0b2-0000-7000-8000-000000000001"], availability: { timezone: "Europe/Berlin", hours: [{ day: 1, from: "09:00", to: "17:00" }] } };

  it("validates slugs, hours and questions", () => {
    expect(BookingPageInput.safeParse(base).success).toBe(true);
    for (const slug of ["ab", "Intro Call", "-intro", "intro--call", "manage"]) expect(BookingPageInput.safeParse({ ...base, slug }).success).toBe(false);
    expect(BookingPageInput.safeParse({ ...base, slug: "Intro-Call" }).data?.slug).toBe("intro-call");
    expect(BookingPageInput.safeParse({ ...base, availability: { timezone: "Mars/Olympus", hours: [] } }).success).toBe(false);
    expect(BookingPageInput.safeParse({ ...base, availability: { timezone: "UTC", hours: [{ day: 1, from: "17:00", to: "09:00" }] } }).success).toBe(false);
    const twoConsents = [
      { id: "c1", label: "Call me", type: "consent" },
      { id: "c2", label: "Call me too", type: "consent" },
    ];
    expect(BookingPageInput.safeParse({ ...base, questions: twoConsents }).success).toBe(false);
    expect(isValidBookingSlug("demo-30")).toBe(true);
    expect(slugifyBooking("Démo call — with Ada!")).toBe("demo-call-with-ada");
  });

  it("reads stored availability defensively", () => {
    expect(readAvailability({})).toEqual({ timezone: "UTC", hours: [] });
    expect(readAvailability({ timezone: "Asia/Dhaka", hours: "nope" })).toEqual({ timezone: "Asia/Dhaka", hours: [] });
  });
});
