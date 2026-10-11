import { monthlyAmount, subscriptionMrr } from "./subscription-history.js";
import { normalizeStripeSubscription, stripeItemPrice } from "./providers/stripe.provider.js";

const growth = { monthlyPriceCents: 7900, annualPriceCents: 79000, currency: "USD" };

describe("subscriptionMrr", () => {
  it("uses the provider's real monthly price and is not estimated", () => {
    expect(subscriptionMrr({ status: "active", interval: "month", priceCents: 6500, priceCurrency: "EUR" }, growth)).toEqual({ mrrCents: 6500, currency: "EUR", estimated: false, paying: true });
  });

  it("divides an annual price by 12 and rounds to the nearest cent", () => {
    expect(monthlyAmount(79000, "year")).toBe(6583); // 6583.33
    expect(monthlyAmount(100, "year")).toBe(8); // 8.33
    expect(monthlyAmount(1000, "year")).toBe(83); // 83.33
    expect(monthlyAmount(1002, "year")).toBe(84); // 83.5 → 84
    expect(subscriptionMrr({ status: "active", interval: "year", priceCents: 120000, priceCurrency: "usd" }, growth).mrrCents).toBe(10000);
  });

  it("falls back to the plan list price for the interval, flagged estimated", () => {
    expect(subscriptionMrr({ status: "active", interval: "month", priceCents: null, priceCurrency: null }, growth)).toEqual({ mrrCents: 7900, currency: "USD", estimated: true, paying: true });
    expect(subscriptionMrr({ status: "active", interval: "year", priceCents: null, priceCurrency: null }, growth)).toMatchObject({ mrrCents: 6583, estimated: true });
  });

  it("counts past_due as paying and every other status as zero", () => {
    expect(subscriptionMrr({ status: "past_due", interval: "month", priceCents: 7900, priceCurrency: "USD" }, growth).mrrCents).toBe(7900);
    for (const status of ["trialing", "incomplete", "canceled", "expired"] as const) {
      const m = subscriptionMrr({ status, interval: "month", priceCents: 7900, priceCurrency: "USD" }, growth);
      expect(m).toMatchObject({ mrrCents: 0, estimated: false, paying: false });
    }
  });

  it("keeps the currency of the real price, upper-cased; the plan currency otherwise", () => {
    expect(subscriptionMrr({ status: "active", interval: "month", priceCents: 500, priceCurrency: "gbp" }, growth).currency).toBe("GBP");
    expect(subscriptionMrr({ status: "trialing", interval: "month", priceCents: null, priceCurrency: null }, { ...growth, currency: "eur" }).currency).toBe("EUR");
  });

  it("a free plan in a paying status is zero, not negative", () => {
    expect(subscriptionMrr({ status: "active", interval: "month", priceCents: null, priceCurrency: null }, { monthlyPriceCents: 0, annualPriceCents: 0, currency: "USD" }).mrrCents).toBe(0);
  });
});

describe("Stripe price capture", () => {
  const item = (price: Record<string, unknown>, quantity?: number) => ({ price: { id: "price_1", ...price }, ...(quantity ? { quantity } : {}) }) as never;

  it("reads a flat month/year price (× quantity, per single interval)", () => {
    expect(stripeItemPrice(item({ unit_amount: 7900, currency: "usd", recurring: { interval: "month" } }))).toEqual({ priceCents: 7900, priceCurrency: "USD" });
    expect(stripeItemPrice(item({ unit_amount: 1000, currency: "eur", recurring: { interval: "month", interval_count: 3 } }, 2))).toEqual({ priceCents: 667, priceCurrency: "EUR" });
  });

  it("returns null for tiered/metered or weekly prices instead of guessing", () => {
    expect(stripeItemPrice(item({ unit_amount: null, currency: "usd", recurring: { interval: "month" } }))).toEqual({ priceCents: null, priceCurrency: null });
    expect(stripeItemPrice(item({ unit_amount: 500, currency: "usd", recurring: { interval: "week" } }))).toEqual({ priceCents: null, priceCurrency: null });
    expect(stripeItemPrice(undefined)).toEqual({ priceCents: null, priceCurrency: null });
  });

  it("carries the price through the normalised subscription", () => {
    const n = normalizeStripeSubscription({
      id: "sub_1",
      customer: "cus_1",
      status: "active",
      cancel_at_period_end: false,
      canceled_at: null,
      trial_end: null,
      items: { data: [{ price: { id: "price_1", unit_amount: 79000, currency: "usd", recurring: { interval: "year" } } }] },
    });
    expect(n).toMatchObject({ interval: "year", priceCents: 79000, priceCurrency: "USD" });
  });
});
