import { describe, expect, it } from "vitest";
import {
  QuoteAcceptInput,
  QuoteCreateInput,
  QuoteLineInput,
  ProductInput,
  describeQuoteTotals,
  effectiveQuoteStatus,
  fromUnits,
  lineAmounts,
  normalizeDecimal,
  quoteExpiresAt,
  quoteNumberLabel,
  quoteTotals,
  quoteTotalsTrouble,
  toUnits,
} from "../src/index.js";

describe("decimal text ↔ integer units", () => {
  it("parses strings and numbers without float drift", () => {
    expect(toUnits("12.345")).toBe(1235);
    expect(toUnits("12.344")).toBe(1234);
    expect(toUnits(0.1)).toBe(10);
    expect(toUnits(1.005)).toBe(101);
    expect(toUnits(".5")).toBe(50);
    expect(toUnits("7")).toBe(700);
    expect(toUnits("-2.555")).toBe(-256);
    expect(toUnits("+3.10")).toBe(310);
    expect(toUnits("19.999", 0)).toBe(20);
  });

  it("refuses anything that is not a plain decimal", () => {
    for (const bad of ["", ".", "1e3", "1,000", "abc", "1.2.3", "--1"]) expect(toUnits(bad)).toBeNaN();
    expect(toUnits(Number.NaN)).toBeNaN();
    expect(toUnits(Infinity)).toBeNaN();
    expect(toUnits(null)).toBeNaN();
  });

  it("writes units back as fixed-scale text", () => {
    expect(fromUnits(1235)).toBe("12.35");
    expect(fromUnits(5)).toBe("0.05");
    expect(fromUnits(-256)).toBe("-2.56");
    expect(fromUnits(0)).toBe("0.00");
    expect(fromUnits(42, 0)).toBe("42");
    expect(normalizeDecimal("12.5")).toBe("12.50");
    expect(normalizeDecimal(0.1 + 0.2)).toBe("0.30");
  });
});

describe("quote totals", () => {
  it("computes quantity × price × (1 − discount), then tax, per line", () => {
    expect(lineAmounts({ quantity: "3", unitPrice: "19.99", discountPercent: "10", taxRate: "20" })).toEqual({ gross: 5997, discount: 600, net: 5397, tax: 1079, total: 6476 });
    // Fractional quantities and half-cent rounding (half away from zero).
    expect(lineAmounts({ quantity: "1.5", unitPrice: "0.33" })).toEqual({ gross: 50, discount: 0, net: 50, tax: 0, total: 50 });
    expect(lineAmounts({ quantity: 1, unitPrice: "10.00", taxRate: "7.25" })).toMatchObject({ tax: 73, total: 1073 });
    // A credit line.
    expect(lineAmounts({ quantity: 1, unitPrice: "-50", taxRate: "10" })).toEqual({ gross: -5000, discount: 0, net: -5000, tax: -500, total: -5500 });
  });

  it("adds the lines up and never drifts on the classic 0.1 + 0.2 case", () => {
    const t = quoteTotals([
      { quantity: 1, unitPrice: 0.1 },
      { quantity: 1, unitPrice: 0.2 },
    ]);
    expect(t.total).toBe(30);
    expect(fromUnits(t.total)).toBe("0.30");
  });

  it("keeps recurring lines apart from one-time ones", () => {
    const t = quoteTotals([
      { quantity: 1, unitPrice: "1200", billingPeriod: "one_time" },
      { quantity: 2, unitPrice: "150", billingPeriod: "monthly", discountPercent: "0" },
      { quantity: 1, unitPrice: "1000", billingPeriod: "yearly", discountPercent: "50", taxRate: "10" },
    ]);
    expect(t).toMatchObject({ subtotal: 250000, discountTotal: 50000, taxTotal: 5000, total: 205000, oneTime: 120000, recurring: { monthly: 30000, quarterly: 0, yearly: 55000 } });
    expect(t.lines).toHaveLength(3);
    expect(describeQuoteTotals(t, "USD")).toBe("$1,200 one-time + $300/month + $550/year");
    expect(describeQuoteTotals(quoteTotals([{ quantity: 1, unitPrice: "99.50" }]), "USD")).toBe("$99.50");
    expect(describeQuoteTotals(quoteTotals([{ quantity: 1, unitPrice: "49", billingPeriod: "monthly" }]), "EUR")).toBe("€49/month");
  });

  it("handles large amounts exactly, and flags what the money columns cannot hold", () => {
    const big = quoteTotals([{ quantity: "1000", unitPrice: "999999999.99", discountPercent: "0.01", taxRate: "0" }]);
    expect(big.lines[0]).toMatchObject({ gross: 99_999_999_999_000, discount: 10_000_000_000 });
    expect(quoteTotalsTrouble(big)).toBeNull();
    const huge = quoteTotals([{ quantity: "99999999.99", unitPrice: "999999.99" }]);
    expect(quoteTotalsTrouble(huge)).toMatch(/too large/);
  });

  it("is empty for no lines", () => {
    expect(quoteTotals([])).toMatchObject({ subtotal: 0, total: 0, oneTime: 0 });
  });
});

describe("quote status and numbering", () => {
  it("numbers quotes Q-0001 onwards", () => {
    expect(quoteNumberLabel(1)).toBe("Q-0001");
    expect(quoteNumberLabel(12)).toBe("Q-0012");
    expect(quoteNumberLabel(12345)).toBe("Q-12345");
  });

  it("expires a sent or viewed quote at the end of its valid-until day (UTC)", () => {
    expect(quoteExpiresAt("2026-10-16")?.toISOString()).toBe("2026-10-17T00:00:00.000Z");
    expect(quoteExpiresAt(new Date("2026-10-16T00:00:00Z"))?.toISOString()).toBe("2026-10-17T00:00:00.000Z");
    expect(quoteExpiresAt(null)).toBeNull();
    const before = new Date("2026-10-16T23:59:59Z");
    const after = new Date("2026-10-17T00:00:00Z");
    expect(effectiveQuoteStatus({ status: "sent", validUntil: "2026-10-16" }, before)).toBe("sent");
    expect(effectiveQuoteStatus({ status: "viewed", validUntil: "2026-10-16" }, after)).toBe("expired");
    expect(effectiveQuoteStatus({ status: "sent", validUntil: null }, after)).toBe("sent");
    // Only open quotes expire: an accepted or draft quote keeps its status.
    expect(effectiveQuoteStatus({ status: "accepted", validUntil: "2020-01-01" }, after)).toBe("accepted");
    expect(effectiveQuoteStatus({ status: "draft", validUntil: "2020-01-01" }, after)).toBe("draft");
    expect(effectiveQuoteStatus({ status: "bogus", validUntil: null })).toBe("draft");
  });
});

describe("quote inputs", () => {
  it("normalises decimals to fixed-scale strings and applies defaults", () => {
    expect(QuoteLineInput.parse({ name: "Setup", unitPrice: 1200, quantity: "2" })).toEqual({
      name: "Setup",
      description: "",
      quantity: "2.00",
      unitPrice: "1200.00",
      discountPercent: "0.00",
      taxRate: "0.00",
      billingPeriod: "one_time",
    });
    expect(ProductInput.parse({ name: "Seat", unitPrice: "49.5", currency: "eur", billingPeriod: "monthly" })).toMatchObject({ unitPrice: "49.50", currency: "EUR", taxRate: "0.00", costPrice: null });
    // A hand-made product cannot claim to be synced.
    const p = ProductInput.parse({ name: "Seat", costPrice: 20, source: "clientdesk", externalId: "x", metadata: { a: 1 }, syncedAt: "2026-10-16" });
    expect(p.costPrice).toBe("20.00");
    expect(p).not.toHaveProperty("source");
    expect(p).not.toHaveProperty("externalId");
    expect(p).not.toHaveProperty("metadata");
  });

  it("refuses out-of-range and malformed values", () => {
    expect(QuoteLineInput.safeParse({ name: "X", quantity: 0 }).success).toBe(false);
    expect(QuoteLineInput.safeParse({ name: "X", discountPercent: 101 }).success).toBe(false);
    expect(QuoteLineInput.safeParse({ name: "X", taxRate: "-1" }).success).toBe(false);
    expect(QuoteLineInput.safeParse({ name: "X", unitPrice: "1e3" }).success).toBe(false);
    expect(QuoteLineInput.safeParse({ name: "" }).success).toBe(false);
    expect(QuoteCreateInput.safeParse({ validUntil: "16/10/2026" }).success).toBe(false);
    expect(QuoteCreateInput.parse({ validUntil: "2026-11-15", currency: "gbp" })).toMatchObject({ validUntil: "2026-11-15", currency: "GBP" });
  });

  it("needs agreement and a typed or drawn signature to accept", () => {
    const base = { signerName: "Dana Buyer", signerEmail: "Dana@Buyer.test", agree: true };
    expect(QuoteAcceptInput.parse({ ...base, signature: { type: "typed", data: "Dana Buyer" } })).toMatchObject({ signerEmail: "dana@buyer.test" });
    expect(QuoteAcceptInput.safeParse({ ...base, signature: { type: "drawn", data: "data:image/png;base64,iVBORw0KGgo=" } }).success).toBe(true);
    expect(QuoteAcceptInput.safeParse({ ...base, signature: { type: "drawn", data: "javascript:alert(1)" } }).success).toBe(false);
    expect(QuoteAcceptInput.safeParse({ ...base, signature: { type: "drawn", data: "data:image/svg+xml;base64,PHN2Zz4=" } }).success).toBe(false);
    expect(QuoteAcceptInput.safeParse({ ...base, agree: false, signature: { type: "typed", data: "Dana" } }).success).toBe(false);
    expect(QuoteAcceptInput.safeParse({ ...base, signature: { type: "typed", data: " " } }).success).toBe(false);
  });
});
