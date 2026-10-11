import { describe, expect, it } from "vitest";
import {
  MINUTES_PER_DAY,
  branchPosition,
  evaluate,
  flowTrouble,
  nextPosition,
  threadOf,
  waitBefore,
  type FlowStep,
} from "../src/flow.js";

/*
 * Ported from LinkDesk packages/domain/tests/flow.test.ts. The cases are
 * unchanged except where the rule fields differ (LinkDesk's link-building
 * fields niche/price are replaced by Growthdesk's own facts).
 */

const days = (n: number) => n * MINUTES_PER_DAY;
const email = (mins = 0): FlowStep => ({ kind: "email", delayMinutes: mins, config: {} });
const wait = (mins: number): FlowStep => ({ kind: "wait", delayMinutes: mins, config: {} });
const branch = (then: number, otherwise: number): FlowStep => ({
  kind: "branch",
  delayMinutes: 0,
  config: { thenLength: then, elseLength: otherwise },
});

describe("nextPosition", () => {
  it("walks a plain sequence one step at a time", () => {
    const flow = [email(), wait(days(3)), email()];
    expect(nextPosition(flow, 0)).toBe(1);
    expect(nextPosition(flow, 1)).toBe(2);
  });

  it("ends the run past the last step", () => {
    expect(nextPosition([email(), email()], 1)).toBeNull();
  });

  it("rejoins the trunk at the end of a matched lane, skipping the other one", () => {
    const flow = [email(), branch(1, 1), email(), email(), email()];
    expect(nextPosition(flow, 2)).toBe(4);
  });

  it("falls through to the trunk at the end of the other lane", () => {
    const flow = [email(), branch(1, 1), email(), email(), email()];
    expect(nextPosition(flow, 3)).toBe(4);
  });

  it("walks inside a lane before leaving it", () => {
    const flow = [branch(2, 1), email(), email(), email(), email()];
    expect(nextPosition(flow, 1)).toBe(2);
    expect(nextPosition(flow, 2)).toBe(4);
  });

  it("ends the run where a branch's lanes reach the end of the sequence", () => {
    const flow = [branch(1, 1), email(), email()];
    expect(nextPosition(flow, 1)).toBeNull();
    expect(nextPosition(flow, 2)).toBeNull();
  });
});

describe("branchPosition", () => {
  it("sends a match into the first lane and everybody else into the second", () => {
    const flow = [branch(2, 1), email(), email(), email(), email()];
    expect(branchPosition(flow, 0, true)).toBe(1);
    expect(branchPosition(flow, 0, false)).toBe(3);
  });

  it("sends a match past an empty first lane rather than into the other one", () => {
    const flow = [branch(0, 1), email(), email()];
    expect(branchPosition(flow, 0, true)).toBe(2);
    expect(branchPosition(flow, 0, false)).toBe(1);
  });

  it("sends a non-match to the trunk when there is no second lane", () => {
    const flow = [branch(1, 0), email(), email()];
    expect(branchPosition(flow, 0, false)).toBe(2);
  });

  it("ends the run where the lane it points at is off the end", () => {
    expect(branchPosition([branch(1, 0), email()], 0, false)).toBeNull();
  });
});

describe("evaluate", () => {
  const facts = { opened: "yes", replied: "no", country: "Bangladesh", score: "72", company: "Growth Network", tag: "vip\nsaas" };

  it("passes a step with no rules on it", () => {
    expect(evaluate(undefined, facts)).toBe(true);
    expect(evaluate({ match: "all", rules: [] }, facts)).toBe(true);
  });

  it("compares text without minding case", () => {
    expect(evaluate({ match: "all", rules: [{ field: "country", op: "is", value: "bangladesh" }] }, facts)).toBe(true);
    expect(evaluate({ match: "all", rules: [{ field: "country", op: "is_not", value: "Bangladesh" }] }, facts)).toBe(false);
    expect(evaluate({ match: "all", rules: [{ field: "company", op: "contains", value: "growth" }] }, facts)).toBe(true);
  });

  it("matches one value of a multi-valued fact such as tags", () => {
    expect(evaluate({ match: "all", rules: [{ field: "tag", op: "is", value: "SaaS" }] }, facts)).toBe(true);
    expect(evaluate({ match: "all", rules: [{ field: "tag", op: "is_not", value: "enterprise" }] }, facts)).toBe(true);
  });

  it("fails a numeric comparison against a figure that is not on file", () => {
    expect(evaluate({ match: "all", rules: [{ field: "custom.budget", op: "lt", value: "100" }] }, {})).toBe(false);
    expect(evaluate({ match: "all", rules: [{ field: "custom.budget", op: "gt", value: "100" }] }, {})).toBe(false);
  });

  it("takes all of the rules, or any of them", () => {
    const rules = [
      { field: "opened", op: "is", value: "yes" },
      { field: "replied", op: "is", value: "yes" },
    ] as const;
    expect(evaluate({ match: "all", rules: [...rules] }, facts)).toBe(false);
    expect(evaluate({ match: "any", rules: [...rules] }, facts)).toBe(true);
  });
});

describe("waitBefore", () => {
  it("keeps two messages a day apart even where the sequence says nothing", () => {
    expect(waitBefore([email(), email(0)], 0, 1)).toBe(days(1));
  });

  it("does not add a day on top of a wait that already stands between them", () => {
    const flow = [email(), wait(days(3)), email(0)];
    expect(waitBefore(flow, 0, 1)).toBe(days(3));
    expect(waitBefore(flow, 1, 2)).toBe(0);
  });

  it("honours a wait shorter than a day rather than rounding it up", () => {
    const flow = [email(), wait(30), email(0)];
    expect(waitBefore(flow, 0, 1)).toBe(30);
    expect(waitBefore(flow, 1, 2)).toBe(0);
  });

  it("answers a question the moment it is reached", () => {
    const flow = [email(), branch(1, 1), email(), email(), email()];
    expect(waitBefore(flow, 0, 1)).toBe(0);
  });

  it("keeps a message's own wait where it has one", () => {
    expect(waitBefore([email(), email(days(5))], 0, 1)).toBe(days(5));
  });
});

describe("threadOf", () => {
  const opener = { subject: "Quick question about Acme", messageId: "<abc@mail>" };

  it("starts a thread of its own where the step carries a subject", () => {
    expect(threadOf("A new idea", opener)).toEqual({ subject: "A new idea" });
  });

  it("replies to the opener where the subject is empty", () => {
    expect(threadOf("", opener)).toEqual({ subject: "Re: Quick question about Acme", inReplyTo: "<abc@mail>" });
  });

  it("never stacks Re: prefixes", () => {
    expect(threadOf("  ", { subject: "Re: RE: Hello", messageId: null })).toEqual({ subject: "Re: Hello" });
  });
});

describe("flowTrouble", () => {
  it("refuses an empty sequence and lanes that run off the end", () => {
    expect(flowTrouble([])).toMatch(/at least one/);
    expect(flowTrouble([email(), branch(2, 1), email()])).toMatch(/past the end/);
  });

  it("refuses a branch inside a branch", () => {
    expect(flowTrouble([branch(2, 0), branch(0, 0), email()])).toMatch(/inside a branch/);
  });

  it("accepts a well-formed flow", () => {
    expect(flowTrouble([email(), wait(60), branch(1, 1), email(), email()])).toBeNull();
  });
});
