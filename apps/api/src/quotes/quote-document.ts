import { createHash } from "node:crypto";
import { normalizeDecimal, quoteNumberLabel } from "@growthdesk/shared";

/*
 * What a signature on a quote covers. The document is the quote's content —
 * who it is from and for, every line in order, the totals, the dates and the
 * text around them — written as canonical JSON (keys sorted, amounts as
 * fixed-scale decimal strings, dates as YYYY-MM-DD) and hashed with sha256.
 * The hash is stored on the quote when it is accepted, next to the signer's
 * name, email, signature, IP address and browser; recomputing it from the
 * stored rows later shows whether anything changed since.
 */

type Amount = { toFixed: (digits: number) => string } | string | number;

export type QuoteDocumentInput = {
  id: string;
  workspaceId: string;
  number: number;
  title: string;
  currency: string;
  validUntil: Date | null;
  intro: string;
  terms: string;
  contactId: string | null;
  companyId: string | null;
  dealId: string | null;
  subtotal: Amount;
  discountTotal: Amount;
  taxTotal: Amount;
  total: Amount;
  lineItems: {
    position: number;
    name: string;
    description: string;
    quantity: Amount;
    unitPrice: Amount;
    discountPercent: Amount;
    taxRate: Amount;
    billingPeriod: string;
    total: Amount;
  }[];
};

const fixed = (v: Amount) => (typeof v === "string" || typeof v === "number" ? normalizeDecimal(v) : v.toFixed(2));
const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

/** JSON with every object's keys in sorted order, so equal content always serialises to equal text. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

/** The signed content of a quote. Version 1; a change to the shape must bump `v`. */
export function quoteDocument(q: QuoteDocumentInput) {
  return {
    v: 1,
    workspaceId: q.workspaceId,
    quoteId: q.id,
    number: quoteNumberLabel(q.number),
    title: q.title,
    currency: q.currency,
    validUntil: day(q.validUntil),
    intro: q.intro,
    terms: q.terms,
    contactId: q.contactId,
    companyId: q.companyId,
    dealId: q.dealId,
    lineItems: [...q.lineItems]
      .sort((a, b) => a.position - b.position)
      .map((l) => ({
        name: l.name,
        description: l.description,
        quantity: fixed(l.quantity),
        unitPrice: fixed(l.unitPrice),
        discountPercent: fixed(l.discountPercent),
        taxRate: fixed(l.taxRate),
        billingPeriod: l.billingPeriod,
        total: fixed(l.total),
      })),
    totals: { subtotal: fixed(q.subtotal), discountTotal: fixed(q.discountTotal), taxTotal: fixed(q.taxTotal), total: fixed(q.total) },
  };
}

/** sha256 (hex) of the quote's canonical document. */
export const quoteDocumentHash = (q: QuoteDocumentInput) => createHash("sha256").update(canonicalJson(quoteDocument(q)), "utf8").digest("hex");
