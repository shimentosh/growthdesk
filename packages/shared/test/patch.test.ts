import { describe, expect, it } from "vitest";
import { patchOf, TaskInput, WebhookInput, WorkflowInput } from "../src/index.js";

describe("patchOf", () => {
  it("leaves out every field the client did not send", () => {
    expect(patchOf(WorkflowInput).parse({ enabled: true })).toEqual({ enabled: true });
    expect(patchOf(TaskInput).parse({ status: "done" })).toEqual({ status: "done" });
    expect(patchOf(WebhookInput).parse({ description: "Renamed" })).toEqual({ description: "Renamed" });
  });

  it("still validates the fields that are sent", () => {
    expect(patchOf(WorkflowInput).safeParse({ enabled: "yes" }).success).toBe(false);
  });

  it("is needed: zod's own partial() fills defaults in", () => {
    expect(Object.keys(WorkflowInput.partial().parse({ enabled: true })).sort()).toEqual(["conditions", "enabled", "requiresApproval"]);
  });
});
