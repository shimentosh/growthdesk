import { Prisma } from "../generated/prisma/client.js";
import { canonicalJson, quoteDocument, quoteDocumentHash, type QuoteDocumentInput } from "./quote-document.js";

const quote = (over: Partial<QuoteDocumentInput> = {}): QuoteDocumentInput => ({
  id: "0199a3c0-0000-7000-8000-000000000001",
  workspaceId: "0199a3c0-0000-7000-8000-000000000002",
  number: 12,
  title: "Website rebuild",
  currency: "USD",
  validUntil: new Date("2026-11-15T00:00:00Z"),
  intro: "Thanks for your time.",
  terms: "Net 30.",
  contactId: null,
  companyId: null,
  dealId: null,
  subtotal: new Prisma.Decimal("1300"),
  discountTotal: new Prisma.Decimal("0"),
  taxTotal: new Prisma.Decimal("0"),
  total: new Prisma.Decimal("1300"),
  lineItems: [
    { position: 1, name: "Hosting", description: "", quantity: new Prisma.Decimal(1), unitPrice: new Prisma.Decimal(100), discountPercent: new Prisma.Decimal(0), taxRate: new Prisma.Decimal(0), billingPeriod: "monthly", total: new Prisma.Decimal(100) },
    { position: 0, name: "Build", description: "", quantity: new Prisma.Decimal(1), unitPrice: new Prisma.Decimal(1200), discountPercent: new Prisma.Decimal(0), taxRate: new Prisma.Decimal(0), billingPeriod: "one_time", total: new Prisma.Decimal(1200) },
  ],
  ...over,
});

describe("quote document hash", () => {
  it("writes canonical JSON with sorted keys at every level", () => {
    expect(canonicalJson({ b: 1, a: { d: [{ z: 1, y: 2 }], c: null }, u: undefined })).toBe('{"a":{"c":null,"d":[{"y":2,"z":1}]},"b":1}');
  });

  it("covers the content in line order, with fixed-scale amounts", () => {
    const doc = quoteDocument(quote());
    expect(doc.number).toBe("Q-0012");
    expect(doc.validUntil).toBe("2026-11-15");
    expect(doc.lineItems.map((l) => l.name)).toEqual(["Build", "Hosting"]);
    expect(doc.lineItems[0]).toMatchObject({ quantity: "1.00", unitPrice: "1200.00", total: "1200.00" });
    expect(doc.totals.total).toBe("1300.00");
  });

  it("is stable for equal content and changes with any of it", () => {
    const h = quoteDocumentHash(quote());
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    // Same values written differently (Decimal vs string vs number) hash the same.
    expect(quoteDocumentHash(quote({ subtotal: "1300.0", total: 1300 }))).toBe(h);
    expect(quoteDocumentHash(quote({ terms: "Net 15." }))).not.toBe(h);
    expect(quoteDocumentHash(quote({ total: "1300.01" }))).not.toBe(h);
    const lines = quote().lineItems.map((l) => (l.name === "Hosting" ? { ...l, quantity: new Prisma.Decimal(2) } : l));
    expect(quoteDocumentHash(quote({ lineItems: lines }))).not.toBe(h);
  });
});
