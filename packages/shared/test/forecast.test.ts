import { describe, expect, it } from "vitest";
import {
  dealInPeriod,
  dealStaleness,
  DealInput,
  ForecastQuery,
  latestOf,
  PipelineInput,
  periodBounds,
  periodLabel,
  periodStartOf,
  presetPeriod,
  rollUpTeam,
  SalesTargetInput,
  shiftPeriod,
  staleNoticeDue,
  summarizeForecast,
  weightedValue,
  type ForecastDealIn,
} from "../src/index.js";

describe("forecast periods", () => {
  it("snaps any day to the start of its month or quarter", () => {
    expect(periodStartOf("month", "2026-10-16")).toBe("2026-10-01");
    expect(periodStartOf("quarter", "2026-10-16")).toBe("2026-10-01");
    expect(periodStartOf("quarter", "2026-12-31")).toBe("2026-10-01");
    expect(periodStartOf("quarter", "2026-03-31")).toBe("2026-01-01");
    expect(periodStartOf("quarter", "2026-05-02")).toBe("2026-04-01");
    expect(periodStartOf("quarter", "2026-09-30")).toBe("2026-07-01");
  });

  it("steps months and quarters across year ends", () => {
    expect(shiftPeriod("month", "2026-12-01", 1)).toBe("2027-01-01");
    expect(shiftPeriod("month", "2026-01-01", -1)).toBe("2025-12-01");
    expect(shiftPeriod("quarter", "2026-10-01", 1)).toBe("2027-01-01");
    expect(shiftPeriod("quarter", "2026-01-01", -1)).toBe("2025-10-01");
    expect(shiftPeriod("quarter", "2026-11-20", 0)).toBe("2026-10-01");
  });

  it("labels periods", () => {
    expect(periodLabel("month", "2026-10-01")).toBe("October 2026");
    expect(periodLabel("quarter", "2026-08-12")).toBe("Q3 2026");
  });

  it("gives last days, including February in a leap year", () => {
    expect(periodBounds("month", "2028-02-10", "UTC").to).toBe("2028-02-29");
    expect(periodBounds("month", "2026-02-10", "UTC").to).toBe("2026-02-28");
    const q4 = periodBounds("quarter", "2026-11-05", "UTC");
    expect([q4.from, q4.to, q4.label]).toEqual(["2026-10-01", "2026-12-31", "Q4 2026"]);
  });

  it("turns the period into instants in the workspace's zone", () => {
    // Dhaka is UTC+6 all year: October begins at 18:00 UTC on September 30.
    const dhaka = periodBounds("month", "2026-10-01", "Asia/Dhaka");
    expect(dhaka.start.toISOString()).toBe("2026-09-30T18:00:00.000Z");
    expect(dhaka.end.toISOString()).toBe("2026-10-31T18:00:00.000Z");
    // New York: Q4 starts in daylight time (UTC-4) and ends in standard time (UTC-5).
    const ny = periodBounds("quarter", "2026-10-01", "America/New_York");
    expect(ny.start.toISOString()).toBe("2026-10-01T04:00:00.000Z");
    expect(ny.end.toISOString()).toBe("2027-01-01T05:00:00.000Z");
    // An unknown zone falls back to UTC rather than throwing.
    expect(periodBounds("month", "2026-10-01", "Mars/Olympus").start.toISOString()).toBe("2026-10-01T00:00:00.000Z");
  });

  it("resolves presets from today's local date", () => {
    expect(presetPeriod("this_month", "2026-10-16")).toEqual({ periodType: "month", periodStart: "2026-10-01" });
    expect(presetPeriod("next_month", "2026-12-16")).toEqual({ periodType: "month", periodStart: "2027-01-01" });
    expect(presetPeriod("last_quarter", "2026-02-01")).toEqual({ periodType: "quarter", periodStart: "2025-10-01" });
    expect(presetPeriod("next_quarter", "2026-10-16")).toEqual({ periodType: "quarter", periodStart: "2027-01-01" });
  });
});

describe("what lands in a period", () => {
  const p = periodBounds("month", "2026-10-01", "Asia/Dhaka");

  it("counts a won deal by when it closed, in the workspace's zone", () => {
    // 19:00 UTC on Sept 30 is already October 1 in Dhaka; 19:00 UTC on Oct 31 is November.
    expect(dealInPeriod({ status: "won", closedAt: "2026-09-30T19:00:00Z", expectedCloseDate: null }, p)).toBe("won");
    expect(dealInPeriod({ status: "won", closedAt: "2026-09-30T17:59:59Z", expectedCloseDate: "2026-10-05" }, p)).toBeNull();
    expect(dealInPeriod({ status: "won", closedAt: "2026-10-31T19:00:00Z", expectedCloseDate: null }, p)).toBeNull();
  });

  it("counts an open deal by its expected close date, a plain calendar date", () => {
    expect(dealInPeriod({ status: "open", closedAt: null, expectedCloseDate: "2026-10-01" }, p)).toBe("open");
    expect(dealInPeriod({ status: "open", closedAt: null, expectedCloseDate: new Date("2026-10-31T00:00:00Z") }, p)).toBe("open");
    expect(dealInPeriod({ status: "open", closedAt: null, expectedCloseDate: "2026-11-01" }, p)).toBeNull();
    expect(dealInPeriod({ status: "open", closedAt: null, expectedCloseDate: null }, p)).toBeNull();
    expect(dealInPeriod({ status: "lost", closedAt: "2026-10-10T00:00:00Z", expectedCloseDate: "2026-10-10" }, p)).toBeNull();
  });
});

describe("summarizeForecast", () => {
  const period = periodBounds("month", "2026-10-01", "UTC");
  let n = 0;
  const deal = (o: Partial<ForecastDealIn>): ForecastDealIn => ({
    id: `d${++n}`,
    ownerId: "ana",
    value: 1000,
    currency: "USD",
    status: "open",
    forecastCategory: "pipeline",
    probability: 50,
    expectedCloseDate: "2026-10-20",
    closedAt: null,
    ...o,
  });
  const deals = [
    deal({ status: "won", value: 5000, closedAt: "2026-10-03T10:00:00Z" }),
    deal({ forecastCategory: "commit", value: 3000, probability: 80 }),
    deal({ forecastCategory: "best_case", value: 2000, probability: 40 }),
    deal({ forecastCategory: "pipeline", value: 1000, probability: 10 }),
    deal({ forecastCategory: "omitted", value: 9000, probability: 90 }),
    // Next month: not in October.
    deal({ forecastCategory: "commit", value: 7777, expectedCloseDate: "2026-11-02" }),
    // Ben's: one won, one commit.
    deal({ ownerId: "ben", status: "won", value: 1500, closedAt: "2026-10-30T23:00:00Z" }),
    deal({ ownerId: "ben", forecastCategory: "commit", value: 500, probability: 60 }),
    // Unowned pipeline.
    deal({ ownerId: null, value: 400, probability: 25 }),
    // Another currency: listed, not summed.
    deal({ status: "won", value: 999, currency: "EUR", closedAt: "2026-10-04T00:00:00Z" }),
    deal({ value: 111, currency: "EUR" }),
  ];
  const targets = [
    { userId: "ana", metric: "revenue_won", target: 10000, currency: "USD" },
    { userId: "ben", metric: "revenue_won", target: 2000, currency: "USD" },
    { userId: "ana", metric: "deals_won", target: 4, currency: "USD" },
    { userId: "ana", metric: "meetings_booked", target: 10, currency: "USD" },
    { userId: "ben", metric: "revenue_won", target: 5000, currency: "GBP" },
  ];
  const meetings = [
    { ownerId: "ana", count: 6 },
    { ownerId: "cleo", count: 2 },
  ];
  const s = summarizeForecast({ currency: "USD", period, deals, targets, meetings, owners: ["dan"] });
  const of = (id: string | null) => s.owners.find((o) => o.ownerId === id)!;

  it("splits an owner's period by category, weights it by stage probability and leaves omitted deals out", () => {
    const ana = of("ana");
    expect(ana.won).toBe(5000);
    expect(ana.commit).toBe(3000);
    expect(ana.bestCase).toBe(2000);
    expect(ana.pipeline).toBe(1000);
    expect(ana.omitted).toBe(9000);
    expect(ana.weighted).toBe(2400 + 800 + 100);
    expect(ana.projected).toBe(8000);
    expect(ana.upside).toBe(10000);
    expect(ana.openDeals).toBe(4); // three in USD and one in EUR
  });

  it("compares against the owner's targets", () => {
    const ana = of("ana");
    expect(ana.target).toBe(10000);
    expect(ana.gap).toBe(5000);
    expect(ana.attainment).toBe(0.5);
    expect(ana.coverage).toBe(6000 / 5000);
    expect([ana.dealsWon, ana.dealsWonTarget]).toEqual([2, 4]); // the EUR win is a deal won, just not money
    expect([ana.meetingsBooked, ana.meetingsBookedTarget]).toEqual([6, 10]);
    const ben = of("ben");
    expect([ben.target, ben.won, ben.gap, ben.attainment, ben.coverage]).toEqual([2000, 1500, 500, 0.75, 1]);
  });

  it("totals the team, unowned deals included; the team target is the owners' sum when none is set", () => {
    expect(s.total.won).toBe(6500);
    expect(s.total.commit).toBe(3500);
    expect(s.total.pipeline).toBe(1400);
    expect(s.total.weighted).toBe(2400 + 800 + 100 + 300 + 100);
    expect(s.total.target).toBe(12000);
    expect(s.total.gap).toBe(5500);
    expect(s.total.dealsWon).toBe(3); // the EUR deal counts as a deal, not as money
    expect(s.total.meetingsBooked).toBe(8);
    expect(of(null).pipeline).toBe(400);
  });

  it("lists other currencies separately and ignores a revenue target in one", () => {
    expect(s.otherCurrencies).toEqual([{ currency: "EUR", won: 999, open: 111, deals: 2 }]);
    expect(s.ignoredTargets).toBe(1);
  });

  it("lists requested owners even with nothing in the period", () => {
    const dan = of("dan");
    expect([dan.won, dan.target, dan.attainment, dan.gap]).toEqual([0, null, null, null]);
    expect(of("cleo").meetingsBooked).toBe(2);
  });

  it("prefers an explicit team target, unless the caller may not see it", () => {
    const team = [...targets, { userId: null, metric: "revenue_won", target: 20000, currency: "USD" }];
    expect(summarizeForecast({ currency: "USD", period, deals, targets: team }).total.target).toBe(20000);
    expect(summarizeForecast({ currency: "USD", period, deals, targets: team }).total.attainment).toBe(6500 / 20000);
    expect(summarizeForecast({ currency: "USD", period, deals, targets: team, teamTargets: false }).total.target).toBe(12000);
  });

  it("reports a beaten target as a negative gap with no coverage", () => {
    const r = summarizeForecast({ currency: "USD", period, deals, targets: [{ userId: "ben", metric: "revenue_won", target: 1000, currency: "USD" }] });
    const ben = r.owners.find((o) => o.ownerId === "ben")!;
    expect([ben.gap, ben.attainment, ben.coverage]).toEqual([-500, 1.5, null]);
  });

  it("weights to the cent and clamps probability", () => {
    expect(weightedValue(333.33, 33)).toBe(110);
    expect(weightedValue(100, 150)).toBe(100);
  });
});

describe("teams", () => {
  const period = periodBounds("month", "2026-10-01", "UTC");
  const d = (o: Partial<ForecastDealIn>): ForecastDealIn => ({ id: "x", ownerId: "ana", value: 100, currency: "USD", status: "open", forecastCategory: "pipeline", probability: 50, expectedCloseDate: "2026-10-10", closedAt: null, ...o });
  const deals = [
    d({ ownerId: "ana", status: "won", value: 1000, closedAt: "2026-10-02T00:00:00Z" }),
    d({ ownerId: "ana", forecastCategory: "commit", value: 400 }),
    d({ ownerId: "ben", forecastCategory: "commit", value: 300 }),
    d({ ownerId: "gone", status: "won", value: 50, closedAt: "2026-10-03T00:00:00Z" }),
    d({ ownerId: "gone", forecastCategory: "best_case", value: 999 }),
    d({ ownerId: "cleo", forecastCategory: "commit", value: 7000 }),
  ];
  const targets = [
    { userId: "ana", metric: "revenue_won", target: 2000, currency: "USD" },
    { userId: "ben", metric: "revenue_won", target: 1000, currency: "USD" },
    { userId: null, teamId: "t1", metric: "revenue_won", target: 5000, currency: "USD" },
    { userId: null, metric: "revenue_won", target: 50000, currency: "USD" },
  ];

  it("rolls members up against the team's target, leaving a deactivated member's open pipeline out", () => {
    const s = summarizeForecast({ currency: "USD", period, deals, targets });
    // A team target never leaks into the workspace total.
    expect(s.total.target).toBe(50000);
    const team = rollUpTeam({ owners: s.owners, memberIds: ["ana", "ben", "gone"], deactivated: ["gone"], targets: targets.filter((t) => t.teamId === "t1") });
    expect([team.won, team.commit, team.bestCase, team.dealsWon, team.target, team.gap]).toEqual([1050, 700, 0, 2, 5000, 3950]);
  });

  it("falls back to the members' targets without a team target", () => {
    const s = summarizeForecast({ currency: "USD", period, deals, targets });
    expect(rollUpTeam({ owners: s.owners, memberIds: ["ana", "ben"], targets: [] }).target).toBe(3000);
  });

  it("measures a forecast narrowed to a team against that team's target", () => {
    const s = summarizeForecast({ currency: "USD", period, deals: deals.filter((x) => x.ownerId !== "cleo"), targets, totalTeamId: "t1" });
    expect(s.total.target).toBe(5000);
  });

  it("takes a target for a person or a team, not both", () => {
    const base = { periodType: "month", periodStart: "2026-10-01", target: 1 };
    expect(SalesTargetInput.parse({ ...base, teamId: "0190a5b0-0000-7000-8000-000000000001" }).userId).toBeNull();
    expect(SalesTargetInput.safeParse({ ...base, teamId: "0190a5b0-0000-7000-8000-000000000001", userId: "0190a5b0-0000-7000-8000-000000000002" }).success).toBe(false);
  });
});

describe("stale deals", () => {
  const now = new Date("2026-10-16T12:00:00Z");

  it("is stale only past the stage's days without progress", () => {
    expect(dealStaleness({ status: "open", rotDays: 14, lastProgress: "2026-09-30T12:00:00Z" }, now)).toEqual({ since: new Date("2026-09-30T12:00:00Z"), days: 16 });
    expect(dealStaleness({ status: "open", rotDays: 14, lastProgress: "2026-10-02T12:00:00Z" }, now)).toBeNull(); // exactly 14 days
    expect(dealStaleness({ status: "open", rotDays: null, lastProgress: "2020-01-01T00:00:00Z" }, now)).toBeNull();
    expect(dealStaleness({ status: "won", rotDays: 1, lastProgress: "2020-01-01T00:00:00Z" }, now)).toBeNull();
  });

  it("takes the latest progress", () => {
    expect(latestOf("2026-10-01T00:00:00Z", null, new Date("2026-10-05T00:00:00Z"), undefined)?.toISOString()).toBe("2026-10-05T00:00:00.000Z");
    expect(latestOf(null, undefined)).toBeNull();
  });

  it("tells the owner once per stale spell", () => {
    expect(staleNoticeDue(null, "2026-10-01T00:00:00Z")).toBe(true);
    expect(staleNoticeDue("2026-10-10T00:00:00Z", "2026-10-01T00:00:00Z")).toBe(false);
    // Progress after the notice ended that spell; the next one is news again.
    expect(staleNoticeDue("2026-10-10T00:00:00Z", "2026-10-12T00:00:00Z")).toBe(true);
  });
});

describe("inputs", () => {
  it("takes a target with a team default and the revenue metric", () => {
    const t = SalesTargetInput.parse({ periodType: "quarter", periodStart: "2026-11-05", target: 50000 });
    expect([t.userId, t.metric]).toEqual([null, "revenue_won"]);
    expect(SalesTargetInput.safeParse({ periodType: "year", periodStart: "2026-01-01", target: 1 }).success).toBe(false);
    expect(SalesTargetInput.safeParse({ periodType: "month", periodStart: "2026-02-30", target: 1 }).success).toBe(false);
    expect(ForecastQuery.parse({}).periodType).toBe("month");
  });

  it("accepts the forecast fields on a deal and stale-after days on a stage", () => {
    expect(DealInput.parse({ name: "X", forecastCategory: "commit", nextStep: "Send proposal", nextStepAt: "2026-10-20T09:00:00Z" }).nextStepAt).toBeInstanceOf(Date);
    expect(DealInput.safeParse({ name: "X", forecastCategory: "maybe" }).success).toBe(false);
    const p = PipelineInput.parse({ name: "P", stages: [{ name: "A", rotDays: 14, guidance: "  Budget confirmed\nDecision maker met " }, { name: "B", kind: "won", rotDays: null }] });
    expect(p.stages?.map((s) => s.rotDays)).toEqual([14, null]);
    expect(p.stages?.[0]?.guidance).toBe("Budget confirmed\nDecision maker met");
  });
});
