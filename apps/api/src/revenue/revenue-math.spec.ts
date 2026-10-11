import { classifyChange, classifyMovements, payingAtStart, ratio, sumMovements, trialConversion, type HistoryRow } from "./revenue-math.js";
import { aggregateLive } from "./revenue.service.js";
import { subscriptionMrr } from "../billing/subscription-history.js";

const t = (day: number) => new Date(Date.UTC(2026, 9, day));
const row = (billingAccountId: string, day: number, fromStatus: HistoryRow["fromStatus"], toStatus: HistoryRow["toStatus"], mrrCents: number, currency = "USD"): HistoryRow => ({
  billingAccountId,
  at: t(day),
  fromStatus,
  toStatus,
  mrrCents,
  currency,
});

describe("classifyChange", () => {
  const usd = (mrrCents: number) => ({ mrrCents, currency: "USD" });
  it("classifies new, reactivation, churn, expansion, contraction and no-op", () => {
    expect(classifyChange(usd(0), usd(2900), false)).toEqual([{ kind: "new", currency: "USD", amountCents: 2900 }]);
    expect(classifyChange(usd(0), usd(2900), true)).toEqual([{ kind: "reactivation", currency: "USD", amountCents: 2900 }]);
    expect(classifyChange(usd(2900), usd(0), true)).toEqual([{ kind: "churn", currency: "USD", amountCents: 2900 }]);
    expect(classifyChange(usd(2900), usd(7900), true)).toEqual([{ kind: "expansion", currency: "USD", amountCents: 5000 }]);
    expect(classifyChange(usd(7900), usd(6583), true)).toEqual([{ kind: "contraction", currency: "USD", amountCents: 1317 }]);
    expect(classifyChange(usd(7900), usd(7900), true)).toEqual([]);
    expect(classifyChange(usd(0), usd(0), true)).toEqual([]);
  });

  it("moves revenue between currencies without counting a won or lost customer", () => {
    expect(classifyChange({ mrrCents: 2900, currency: "USD" }, { mrrCents: 2500, currency: "EUR" }, true)).toEqual([
      { kind: "contraction", currency: "USD", amountCents: 2900 },
      { kind: "expansion", currency: "EUR", amountCents: 2500 },
    ]);
  });
});

describe("classifyMovements", () => {
  it("follows one account through trial → active → upgrade → cancel → come back", () => {
    const { movements, unclassified } = classifyMovements([
      row("a", 5, "active", "canceled", 0),
      row("a", 1, null, "trialing", 0),
      row("a", 2, "trialing", "active", 2900),
      row("a", 3, "active", "active", 7900),
      row("a", 6, "canceled", "active", 7900),
    ]);
    expect(unclassified).toEqual([]);
    expect(movements.map((m) => [m.kind, m.amountCents])).toEqual([
      ["new", 2900],
      ["expansion", 5000],
      ["churn", 7900],
      ["reactivation", 7900],
    ]);
  });

  it("treats a first row from a non-paying status as starting at zero", () => {
    const { movements } = classifyMovements([row("b", 2, "trialing", "active", 7900)]);
    expect(movements).toMatchObject([{ kind: "new", amountCents: 7900 }]);
  });

  it("does not guess the previous MRR of a subscription that was already paying before tracking began", () => {
    const { movements, unclassified } = classifyMovements([row("c", 2, "active", "past_due", 7900), row("c", 3, "past_due", "canceled", 0)]);
    expect(unclassified).toHaveLength(1);
    expect(movements).toMatchObject([{ kind: "churn", amountCents: 7900 }]);
  });

  it("past_due keeps the MRR (no movement), and a later recovery after expiry is a reactivation", () => {
    const { movements } = classifyMovements([
      row("d", 1, null, "active", 2900),
      row("d", 2, "active", "past_due", 2900),
      row("d", 3, "past_due", "canceled", 0),
      row("d", 4, "canceled", "active", 2900),
    ]);
    expect(movements.map((m) => m.kind)).toEqual(["new", "churn", "reactivation"]);
  });

  it("keeps currencies apart and sums per kind", () => {
    const { movements } = classifyMovements([row("e", 1, null, "active", 2900, "USD"), row("f", 1, null, "active", 2500, "EUR"), row("f", 2, "active", "canceled", 0, "EUR")]);
    const usd = sumMovements(movements.filter((m) => m.currency === "USD"));
    const eur = sumMovements(movements.filter((m) => m.currency === "EUR"));
    expect(usd).toMatchObject({ newCents: 2900, churnCents: 0, netCents: 2900, counts: { new: 1, churn: 0 } });
    expect(eur).toMatchObject({ newCents: 2500, churnCents: 2500, netCents: 0, counts: { new: 1, churn: 1 } });
  });
});

describe("trialConversion / logo churn", () => {
  const rows = [
    row("a", 2, null, "trialing", 0),
    row("a", 20, "trialing", "active", 2900), // converts after the range ends: still counted
    row("b", 3, null, "trialing", 0),
    row("b", 17, "trialing", "expired", 0),
    row("c", 1, null, "trialing", 0), // before the range
    row("c", 4, "trialing", "active", 2900),
  ];

  it("counts trials started in the range and those that became active", () => {
    const trials = trialConversion(rows, t(2), t(10));
    expect(trials.map((x) => [x.billingAccountId, x.converted])).toEqual([
      ["a", true],
      ["b", false],
    ]);
  });

  it("works the paying count at the start back from today's", () => {
    const { movements } = classifyMovements([...rows, row("d", 1, "trialing", "active", 7900), row("d", 12, "active", "canceled", 0)]);
    // Today: a and c pay (2). Since day 2: a new, c new, d churned → at start: 2 − 2 + 1 = 1 (d).
    expect(payingAtStart(2, movements.filter((m) => m.at >= t(2)))).toBe(1);
    expect(ratio(1, 1)).toBe(1);
    expect(ratio(1, 3)).toBe(0.3333);
    expect(ratio(1, 0)).toBeNull();
  });
});

describe("aggregateLive", () => {
  const plan = (id: string) => ({ id, key: id, name: id.toUpperCase() });
  const live = (id: string, provider: string, status: "active" | "trialing" | "past_due" | "canceled", interval: "month" | "year", priceCents: number | null, priceCurrency: string | null, planCurrency = "USD") => ({
    billingAccountId: id,
    accountName: id,
    status,
    interval,
    provider,
    plan: plan(interval === "year" ? "growth" : "starter"),
    mrr: subscriptionMrr({ status, interval, priceCents, priceCurrency }, { monthlyPriceCents: 2900, annualPriceCents: 29000, currency: planCurrency }),
  });

  it("totals per currency with paying/trialing counts, sources and the estimated flag", () => {
    const agg = aggregateLive([
      live("s1", "stripe", "active", "month", 3000, "USD"),
      live("s2", "stripe", "past_due", "year", 36000, "USD"),
      live("m1", "manual", "active", "month", null, null),
      live("n1", "none", "trialing", "month", null, null),
      live("x1", "stripe", "canceled", "month", 3000, "USD"),
      live("e1", "stripe", "active", "month", 2500, "EUR"),
    ]);
    const usd = agg.get("USD")!;
    expect(usd.total).toEqual({ mrrCents: 3000 + 3000 + 2900, payingCount: 3, trialingCount: 1, unpricedCount: 1 });
    expect(usd.sources.get("stripe")).toEqual({ mrrCents: 6000, payingCount: 2, trialingCount: 0, unpricedCount: 0 });
    expect(usd.sources.get("manual")).toEqual({ mrrCents: 2900, payingCount: 1, trialingCount: 0, unpricedCount: 1 });
    expect(usd.sources.get("none")).toEqual({ mrrCents: 0, payingCount: 0, trialingCount: 1, unpricedCount: 0 });
    expect(agg.get("EUR")!.total).toEqual({ mrrCents: 2500, payingCount: 1, trialingCount: 0, unpricedCount: 0 });
  });
});
