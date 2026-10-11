import { describe, expect, it } from "vitest";
import { advance, ENROLL_WINDOW_MS, enrollFloor, firstRunAt, HOUR_MS, nextRunAfter, stepAt, trialTriggerAt, triggerEnrolls } from "./drip-schedule.js";

const at = (iso: string) => new Date(iso);
const steps = [
  { id: "c", position: 3, delayHours: 72 },
  { id: "a", position: 1, delayHours: 0 },
  { id: "b", position: 2, delayHours: 24 },
];

describe("drip timing", () => {
  it("step 1 counts from the trigger, later steps from the previous send", () => {
    expect(firstRunAt(at("2026-10-01T10:00:00Z"), 0)).toEqual(at("2026-10-01T10:00:00Z"));
    expect(firstRunAt(at("2026-10-01T10:00:00Z"), 2)).toEqual(at("2026-10-01T12:00:00Z"));
    expect(nextRunAfter(at("2026-10-03T08:30:00Z"), 24)).toEqual(at("2026-10-04T08:30:00Z"));
    expect(nextRunAfter(at("2026-10-03T08:30:00Z"), -5)).toEqual(at("2026-10-03T08:30:00Z"));
  });

  it("only enrolls triggers after activation, not in the future and within the window", () => {
    const activated = at("2026-10-01T00:00:00Z");
    const now = at("2026-10-05T00:00:00Z");
    expect(triggerEnrolls(at("2026-09-30T23:59:59Z"), activated, now)).toBe(false);
    expect(triggerEnrolls(activated, activated, now)).toBe(false);
    expect(triggerEnrolls(at("2026-10-01T00:00:01Z"), activated, now)).toBe(true);
    expect(triggerEnrolls(at("2026-10-05T00:00:01Z"), activated, now)).toBe(false);
    const later = new Date(activated.getTime() + 30 * 24 * HOUR_MS);
    expect(triggerEnrolls(at("2026-10-02T00:00:00Z"), activated, later)).toBe(false);
    expect(enrollFloor(activated, now)).toEqual(activated);
    expect(enrollFloor(activated, later)).toEqual(new Date(later.getTime() - ENROLL_WINDOW_MS));
  });

  it("trial_ending fires 3 days before the end; trial_ended an hour after", () => {
    const ends = at("2026-10-20T12:00:00Z");
    expect(trialTriggerAt("trial_ending", ends)).toEqual(at("2026-10-17T12:00:00Z"));
    expect(trialTriggerAt("trial_ended", ends)).toEqual(at("2026-10-20T13:00:00Z"));
  });

  it("finds the step at or after a position, whatever the order", () => {
    expect(stepAt(steps, 1)).toMatchObject({ step: { id: "a" }, next: { id: "b" } });
    expect(stepAt(steps, 3)).toMatchObject({ step: { id: "c" }, next: null });
    expect(stepAt([steps[0]!], 2)).toMatchObject({ step: { id: "c" } });
    expect(stepAt(steps, 4)).toEqual({ step: null, next: null });
  });

  it("advances to the next step's delay, then completes", () => {
    const sent = at("2026-10-02T09:00:00Z");
    expect(advance(steps, steps[1]!, sent)).toEqual({ nextStepPosition: 2, nextRunAt: at("2026-10-03T09:00:00Z"), status: "active" });
    expect(advance(steps, steps[2]!, sent)).toEqual({ nextStepPosition: 3, nextRunAt: at("2026-10-05T09:00:00Z"), status: "active" });
    expect(advance(steps, steps[0]!, sent)).toEqual({ nextStepPosition: 4, nextRunAt: null, status: "completed" });
  });
});
