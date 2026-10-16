import type { BillingPeriod, QuoteStatus, RecurringPeriod } from "@growthdesk/shared";

/*
 * Products and quotes as the API returns them (apps/api/src/quotes). Amounts
 * are fixed-scale decimal strings ("1200.00"): exact, and what the editor
 * sends back.
 */

export type Product = {
  id: string;
  name: string;
  sku: string;
  description: string;
  category: string;
  groupName: string;
  unit: string;
  unitPrice: string;
  /** Null when unknown, and for people without products.manage. */
  costPrice: string | null;
  currency: string;
  billingPeriod: BillingPeriod;
  taxRate: string;
  /** "" when made here; else the system it is synced from ("clientdesk"). */
  source: string;
  synced: boolean;
  syncedAt: string | null;
  details: { turnaround: string | null; features: string[] };
  archived: boolean;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type QuoteLine = {
  id: string;
  productId: string | null;
  position: number;
  name: string;
  description: string;
  quantity: string;
  unitPrice: string;
  discountPercent: string;
  taxRate: string;
  billingPeriod: BillingPeriod;
  total: string;
};

export type QuoteRow = {
  id: string;
  number: number;
  numberLabel: string;
  title: string;
  /** Effective: a sent or viewed quote past its valid-until date reads "expired". */
  status: QuoteStatus;
  currency: string;
  subtotal: string;
  discountTotal: string;
  taxTotal: string;
  total: string;
  oneTimeTotal: string;
  recurring: Record<RecurringPeriod, string>;
  /** "$1,200 one-time + $300/month". */
  summary: string;
  validUntil: string | null;
  deal: { id: string; name: string } | null;
  contact: { id: string; fullName: string; email: string | null } | null;
  company: { id: string; name: string } | null;
  owner: { id: string; name: string } | null;
  lineCount: number;
  sentAt: string | null;
  firstViewedAt: string | null;
  lastViewedAt: string | null;
  viewCount: number;
  acceptedAt: string | null;
  declinedAt: string | null;
  signerName: string;
  createdAt: string;
  updatedAt: string;
};

export type QuoteDetail = QuoteRow & {
  storedStatus: QuoteStatus;
  intro: string;
  terms: string;
  publicUrl: string;
  lineItems: QuoteLine[];
  createdBy: { id: string; name: string; email: string } | null;
  declineReason: string;
  acceptance: {
    signerName: string;
    signerEmail: string;
    signerTitle: string;
    signatureType: "typed" | "drawn";
    signature: string;
    signerIp: string;
    signerUserAgent: string;
    documentHash: string;
    /** The stored content still hashes to documentHash. */
    hashMatches: boolean;
  } | null;
};

export type QuoteSendOptions = {
  mailboxes: { id: string; email: string; displayName: string }[];
  defaultMailboxId: string | null;
  to: string;
  toName: string;
  subject: string;
  message: string;
  publicUrl: string;
};
