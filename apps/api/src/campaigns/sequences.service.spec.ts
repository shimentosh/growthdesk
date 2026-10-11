import { describe, expect, it } from "vitest";
import { structureChange } from "./sequences.service.js";

const email = (subject: string) => ({ type: "email", config: { subject, body: "Hi" } });
const wait = (days: number) => ({ type: "wait", config: { delayMinutes: days * 1440 } });
const branch = (thenLength: number, elseLength: number) => ({ type: "branch", config: { thenLength, elseLength, logic: { match: "all", rules: [] } } });

describe("structureChange (steps of a campaign with enrollments)", () => {
  const current = [email("One"), wait(2), email("Two")];

  it("allows editing content and timing in place", () => {
    expect(structureChange(current, [email("One, reworded"), wait(5), email("Two")])).toBeNull();
  });

  it("allows adding steps at the end", () => {
    expect(structureChange(current, [...current, wait(3), email("Three")])).toBeNull();
  });

  it("refuses removing a step", () => {
    expect(structureChange(current, [email("One"), email("Two")])).toBe("This removes a step");
  });

  it("refuses inserting or reordering, which shifts what each number means", () => {
    // Inserting a wait before step 2 moves the second email from position 2 to 3.
    expect(structureChange(current, [email("One"), wait(1), wait(2), email("Two")])).toBe("Step 3 changes from email to wait");
    expect(structureChange(current, [wait(2), email("One"), email("Two")])).toBe("Step 1 changes from email to wait");
  });

  it("refuses resizing a branch's lanes, which renumbers the steps they hold", () => {
    const withBranch = [email("One"), branch(1, 1), email("Yes"), email("No")];
    expect(structureChange(withBranch, [email("One"), branch(1, 1), email("Yes!"), email("No")])).toBeNull();
    expect(structureChange(withBranch, [email("One"), branch(2, 0), email("Yes"), email("No")])).toBe("Step 2 changes how many steps its branches hold");
  });
});
