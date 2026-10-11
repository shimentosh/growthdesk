import { trialEmailKey } from "./trial-guard.js";
import { meterPeriod } from "./entitlements.service.js";
import { normalizeStripeCharge } from "./providers/stripe.provider.js";

describe("trialEmailKey", () => {
  it("lower-cases and drops a +tag for any provider", () => {
    expect(trialEmailKey("  Jane.Doe+Trial2@Example.COM ")).toBe("jane.doe@example.com");
  });

  it("removes Gmail dots and treats googlemail.com as gmail.com", () => {
    expect(trialEmailKey("j.a.n.e+x@gmail.com")).toBe("jane@gmail.com");
    expect(trialEmailKey("Jane@GoogleMail.com")).toBe("jane@gmail.com");
  });

  it("keeps dots for other providers, where they can matter", () => {
    expect(trialEmailKey("j.ane@outlook.com")).toBe("j.ane@outlook.com");
  });
});

describe("meterPeriod", () => {
  const at = (s: string) => new Date(`${s}T12:00:00Z`);

  it("renews on the subscription's billing day, not the 1st", () => {
    expect(meterPeriod(at("2026-08-15"), at("2026-10-20"))).toEqual({ key: "2026-10-15", resetsAt: new Date("2026-11-15T00:00:00Z") });
    expect(meterPeriod(at("2026-08-15"), at("2026-10-14")).key).toBe("2026-09-15");
  });

  it("falls on the last day of a short month, and crosses the year", () => {
    expect(meterPeriod(at("2026-01-31"), at("2027-02-28")).key).toBe("2027-02-28");
    expect(meterPeriod(at("2026-01-31"), at("2027-02-27")).key).toBe("2027-01-31");
    expect(meterPeriod(at("2026-03-20"), at("2027-01-05"))).toEqual({ key: "2026-12-20", resetsAt: new Date("2027-01-20T00:00:00Z") });
  });

  it("uses the calendar month without an anchor", () => {
    expect(meterPeriod(null, at("2026-10-11"))).toEqual({ key: "2026-10-01", resetsAt: new Date("2026-11-01T00:00:00Z") });
  });
});

describe("normalizeStripeCharge", () => {
  it("reads a refund and a dispute", () => {
    expect(normalizeStripeCharge("charge.refunded", { id: "ch_1", customer: "cus_1", amount_refunded: 2500, currency: "usd", refunded: false })).toMatchObject({
      kind: "refund",
      providerChargeId: "ch_1",
      providerCustomerId: "cus_1",
      amountCents: 2500,
      currency: "USD",
      fullRefund: false,
    });
    expect(normalizeStripeCharge("charge.dispute.created", { id: "dp_1", charge: "ch_1", amount: 7900, currency: "eur", reason: "fraudulent" })).toMatchObject({
      kind: "dispute",
      providerChargeId: "ch_1",
      providerCustomerId: null,
      amountCents: 7900,
      currency: "EUR",
      reason: "fraudulent",
    });
  });
});
