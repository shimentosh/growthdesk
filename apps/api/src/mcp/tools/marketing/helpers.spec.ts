import type { EmailBlock } from "@growthdesk/shared";
import { ADD_TO_LIST_MAX, addSizeTrouble, allowanceLine, applyBlockOps, inZone, normalizeBlocks, outline, scheduleStillValid, scheduleTrouble } from "./helpers.js";

const counter = () => {
  let n = 0;
  return () => `n${++n}`;
};

const BLOCKS: EmailBlock[] = [
  { type: "heading", id: "h", text: "Hello", level: 1, align: "left" },
  { type: "text", id: "t", text: "Body", align: "left" },
  { type: "button", id: "b", label: "Go", url: "https://example.com", align: "center" },
];

describe("marketing MCP helpers", () => {
  describe("add sizing", () => {
    it("lets add_to_list take up to 200 and sends bigger batches to bulk_add_to_list", () => {
      expect(addSizeTrouble(1, "add_to_list")).toBeNull();
      expect(addSizeTrouble(ADD_TO_LIST_MAX, "add_to_list")).toBeNull();
      expect(addSizeTrouble(ADD_TO_LIST_MAX + 1, "add_to_list")).toMatch(/bulk_add_to_list/);
      expect(addSizeTrouble(ADD_TO_LIST_MAX + 1, "bulk_add_to_list")).toBeNull();
      expect(addSizeTrouble(5000, "bulk_add_to_list")).toBeNull();
    });

    it("refuses nobody and more than one call takes", () => {
      expect(addSizeTrouble(0, "bulk_add_to_list")).toMatch(/No contacts matched/);
      expect(addSizeTrouble(5001, "bulk_add_to_list")).toMatch(/at most 5000/);
    });
  });

  describe("scheduling", () => {
    const now = new Date("2026-10-16T12:00:00Z");
    it("needs a valid time at least two minutes ahead and within a year", () => {
      expect(scheduleTrouble(new Date("nope"), now)).toMatch(/not a valid/);
      expect(scheduleTrouble(new Date("2026-10-16T12:01:00Z"), now)).toMatch(/at least 2 minutes/);
      expect(scheduleTrouble(new Date("2026-10-16T12:02:00Z"), now)).toBeNull();
      expect(scheduleTrouble(new Date("2028-01-01T00:00:00Z"), now)).toMatch(/within the next year/);
    });

    it("refuses at confirmation a time that has come too close (the service would send at once)", () => {
      expect(scheduleStillValid(new Date("2026-10-16T12:05:00Z"), now)).toBe(true);
      expect(scheduleStillValid(new Date("2026-10-16T12:01:00Z"), now)).toBe(false);
      expect(scheduleStillValid(new Date("2026-10-16T11:59:00Z"), now)).toBe(false);
    });

    it("formats a time in the workspace zone", () => {
      expect(inZone(new Date("2026-10-20T13:00:00Z"), "America/New_York")).toBe("Tuesday, October 20, 2026 at 9:00 AM (America/New_York)");
      expect(inZone(new Date("2026-10-20T13:00:00Z"), "Not/AZone")).toBe("2026-10-20T13:00:00.000Z (UTC)");
      expect(inZone(null, "UTC")).toBeNull();
    });
  });

  describe("blocks", () => {
    it("gives new blocks ids and validates them with the shared schema", () => {
      const out = normalizeBlocks([{ type: "text", text: "Hi" }, { type: "divider", id: "d" }], counter());
      expect(out).toEqual([
        { type: "text", id: "n1", text: "Hi", align: "left" },
        { type: "divider", id: "d" },
      ]);
      expect(() => normalizeBlocks([{ type: "button", url: "ftp://x" }], counter())).toThrow(/blocks\.0\.url/);
      expect(() => normalizeBlocks([{ type: "text", id: "a" }, { type: "divider", id: "a" }], counter())).toThrow(/share the id "a"/);
    });

    it("applies update, replace, insert, remove and move in order", () => {
      const out = applyBlockOps(
        BLOCKS,
        [
          { op: "update", id: "t", fields: { text: "New body", type: "image", id: "zzz" } },
          { op: "insert", block: { type: "divider" }, afterId: "h" },
          { op: "insert", block: { type: "spacer", height: 10 }, position: "start" },
          { op: "replace", id: "b", block: { type: "button", label: "Buy", url: "https://shop.example.com" } },
          { op: "remove", id: "h" },
          { op: "move", id: "b", beforeId: "n1" },
        ],
        counter(),
      );
      expect(out.map((b) => [b.type, b.id])).toEqual([
        ["spacer", "n2"],
        ["button", "b"],
        ["divider", "n1"],
        ["text", "t"],
      ]);
      // An update cannot change a block's type or id.
      expect(out.find((b) => b.id === "t")).toMatchObject({ type: "text", text: "New body" });
      expect(out.find((b) => b.id === "b")).toMatchObject({ label: "Buy", url: "https://shop.example.com", align: "center" });
      expect(BLOCKS[1]).toMatchObject({ text: "Body" });
    });

    it("names the operation that points at a missing block, and validates the result", () => {
      expect(() => applyBlockOps(BLOCKS, [{ op: "remove", id: "nope" }])).toThrow(/Operation 1 \(remove\): there is no block "nope"/);
      expect(() => applyBlockOps(BLOCKS, [{ op: "insert", block: { type: "text" }, afterId: "nope" }])).toThrow(/Operation 1: there is no block "nope"/);
      expect(() => applyBlockOps(BLOCKS, [{ op: "update", id: "b", fields: { url: "javascript:alert(1)" } }])).toThrow(/blocks\.2\.url/);
    });

    it("outlines blocks in one line each", () => {
      expect(outline(BLOCKS)).toEqual([
        { id: "h", type: "heading", gist: "Hello" },
        { id: "t", type: "text", gist: "Body" },
        { id: "b", type: "button", gist: "Go → https://example.com" },
      ]);
    });
  });

  describe("allowance line", () => {
    it("says what a send uses, and warns when it does not fit", () => {
      expect(allowanceLine({ left: null, limit: null }, 10)).toMatch(/no monthly limit/);
      expect(allowanceLine({ left: 500, limit: 1000 }, 10)).toBe("Uses 10 of the 500 marketing emails left this month (plan: 1,000/month).");
      expect(allowanceLine({ left: 5, limit: 1000 }, 10)).toMatch(/^WARNING: only 5 of 1,000/);
    });
  });
});
