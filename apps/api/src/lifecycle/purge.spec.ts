import { PURGE_ORDER, purgeOrderGaps } from "./purge.js";

describe("workspace purge order", () => {
  it("covers every tenant table, and nothing else", () => {
    expect(purgeOrderGaps()).toEqual({ missing: [], extra: [] });
    expect(new Set(PURGE_ORDER).size).toBe(PURGE_ORDER.length);
  });

  it("deletes children before the parents that restrict their deletion", () => {
    const at = (m: string) => PURGE_ORDER.indexOf(m as never);
    expect(at("Deal")).toBeLessThan(at("Pipeline"));
    expect(at("Deal")).toBeLessThan(at("PipelineStage"));
    expect(at("Campaign")).toBeLessThan(at("Sequence"));
    expect(at("Message")).toBeLessThan(at("Conversation"));
  });
});
