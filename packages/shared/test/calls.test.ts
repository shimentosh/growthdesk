import { describe, expect, it } from "vitest";
import { CALL_OUTCOMES, CallListQuery, CallQueueAddInput, CallUpdateInput, ClickToCallInput, isFinalCallStatus, statusForOutcome } from "../src/index.js";

describe("calling rules", () => {
  it("records busy and no-answer as line statuses, everything else as completed", () => {
    expect(statusForOutcome("busy")).toBe("busy");
    expect(statusForOutcome("no_answer")).toBe("no_answer");
    for (const o of CALL_OUTCOMES.filter((x) => x !== "busy" && x !== "no_answer")) expect(statusForOutcome(o)).toBe("completed");
  });

  it("knows which statuses are final", () => {
    expect(["completed", "busy", "no_answer", "failed", "canceled"].every(isFinalCallStatus)).toBe(true);
    expect(["queued", "ringing", "in_progress", "nope"].some(isFinalCallStatus)).toBe(false);
  });

  it("parses the history filters, including 'none' for calls without an outcome", () => {
    const q = CallListQuery.parse({ outcome: "none", status: "completed", page: "2" });
    expect(q).toMatchObject({ outcome: "none", status: "completed", page: 2, pageSize: 50 });
    expect(CallListQuery.safeParse({ outcome: "maybe" }).success).toBe(false);
  });

  it("validates click-to-call, updates and queue additions", () => {
    const id = "0199a3c0-0000-7000-8000-000000000001";
    expect(ClickToCallInput.safeParse({ contactId: id, integrationId: id, agentNumber: "+14155550100" }).success).toBe(true);
    expect(ClickToCallInput.safeParse({ contactId: id, integrationId: id, agentNumber: "" }).success).toBe(false);
    expect(CallUpdateInput.parse({ outcome: "connected", callbackAt: null })).toEqual({ outcome: "connected", callbackAt: null });
    expect(CallUpdateInput.safeParse({ durationSec: -1 }).success).toBe(false);
    expect(CallQueueAddInput.safeParse({ contactIds: [] }).success).toBe(false);
    expect(CallQueueAddInput.safeParse({ contactIds: [id], dueAt: "2026-10-11T09:00:00Z" }).success).toBe(true);
  });
});
