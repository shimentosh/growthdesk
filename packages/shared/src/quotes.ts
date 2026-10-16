import { z } from "zod";
import { ListQuery, email, optionalUuid, requiredText, text } from "./schemas.js";
import { formatMoney } from "./plans.js";

/*
 * Quotes and the product catalogue: the API inputs and the pure rules both
 * sides read. Money never goes through a float: amounts are parsed from their
 * decimal text into integer units (cents for prices, hundredths for quantities
 * and percentages) and every product is taken in BigInt, so the editor's live
 * totals, the stored totals and the signed document always agree to the cent.
 */

export const QUOTE_STATUSES = ["draft", "sent", "viewed", "accepted", "declined", "expired", "void"] as const;
export type QuoteStatus = (typeof QUOTE_STATUSES)[number];

export const BILLING_PERIODS = ["one_time", "monthly", "quarterly", "yearly"] as const;
export type BillingPeriod = (typeof BILLING_PERIODS)[number];
export type RecurringPeriod = Exclude<BillingPeriod, "one_time">;
export const RECURRING_PERIODS: readonly RecurringPeriod[] = ["monthly", "quarterly", "yearly"];

/** "/month" etc., for "$300/month". */
export const PERIOD_SUFFIX: Record<RecurringPeriod, string> = { monthly: "/month", quarterly: "/quarter", yearly: "/year" };
export const BILLING_PERIOD_LABELS: Record<BillingPeriod, string> = { one_time: "One-time", monthly: "Monthly", quarterly: "Quarterly", yearly: "Yearly" };

/** Statuses the buyer can still accept or decline from. */
export const OPEN_QUOTE_STATUSES: readonly QuoteStatus[] = ["sent", "viewed"];
/** Nothing changes once a quote is accepted (the signature covers it) or withdrawn. */
export const FROZEN_QUOTE_STATUSES: readonly QuoteStatus[] = ["accepted", "void"];

/** Q-0001, Q-0012, Q-12345. */
export const quoteNumberLabel = (n: number) => `Q-${String(n).padStart(4, "0")}`;

// ─── Decimal text ↔ integer units ───────────────────────────────────────────

type Dec = string | number;

const DECIMAL_RE = /^([+-])?(\d*)(?:\.(\d*))?$/;

/** Half away from zero. */
function divRound(a: bigint, b: bigint): bigint {
  const negative = a < 0n !== b < 0n;
  const x = a < 0n ? -a : a;
  const y = b < 0n ? -b : b;
  const q = (x * 2n + y) / (y * 2n);
  return negative ? -q : q;
}

/**
 * A decimal (text or number) as an integer count of 10^-scale units:
 * toUnits("12.345") → 1235, toUnits(0.1) → 10. Rounds half away from zero
 * past the scale. NaN for anything that is not a plain decimal.
 */
export function toUnits(value: Dec | null | undefined, scale = 2): number {
  if (value === null || value === undefined) return NaN;
  // A number is written out with a few spare digits, so 1.005 stays 1.005 rather than 1.00499999…
  const s = typeof value === "number" ? (Number.isFinite(value) && Math.abs(value) < 1e15 ? value.toFixed(scale + 4) : "") : value.trim();
  const m = DECIMAL_RE.exec(s);
  if (!m || (!m[2] && !m[3])) return NaN;
  const frac = (m[3] ?? "").padEnd(scale + 1, "0");
  let units = BigInt((m[2] || "0") + frac.slice(0, scale));
  if (Number(frac[scale]) >= 5) units += 1n;
  if (m[1] === "-") units = -units;
  const n = Number(units);
  return Number.isSafeInteger(n) ? n : NaN;
}

/** The inverse of toUnits: fromUnits(1235) → "12.35". */
export function fromUnits(units: number, scale = 2): string {
  const negative = units < 0;
  const digits = String(Math.abs(Math.trunc(units))).padStart(scale + 1, "0");
  const out = scale ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}` : digits;
  return negative ? `-${out}` : out;
}

/** "12.5" → "12.50"; whatever toUnits accepts, normalised to a fixed scale. */
export const normalizeDecimal = (value: Dec, scale = 2) => fromUnits(toUnits(value, scale), scale);

/**
 * A decimal field: a JSON number or a decimal string, within [min, max],
 * normalised to a fixed-scale string ("12.50") for Prisma's Decimal columns.
 */
export const decimal = (opts: { min: number; max: number; scale?: number; label?: string }) => {
  const scale = opts.scale ?? 2;
  return z
    .union([z.number(), z.string().trim()])
    .refine((v) => Number.isFinite(toUnits(v, scale)), { message: "Enter a number" })
    .refine(
      (v) => {
        const u = toUnits(v, scale);
        return u >= toUnits(opts.min, scale) && u <= toUnits(opts.max, scale);
      },
      { message: `Must be between ${opts.min} and ${opts.max}` },
    )
    .transform((v) => normalizeDecimal(v, scale));
};

const money = decimal({ min: -1_000_000_000, max: 1_000_000_000 });
const percent = decimal({ min: 0, max: 100 });
const quantity = decimal({ min: 0.01, max: 100_000_000 });
const currency = z.string().trim().length(3, "Use a three-letter currency code").toUpperCase();

// ─── Totals ──────────────────────────────────────────────────────────────────

export type QuoteLineMath = { quantity: Dec; unitPrice: Dec; discountPercent?: Dec | null; taxRate?: Dec | null; billingPeriod?: string | null };

/** One line's amounts, in cents. `net` is what QuoteLineItem.total stores. */
export type LineAmounts = { gross: number; discount: number; net: number; tax: number; total: number };

export type QuoteTotals = {
  lines: LineAmounts[];
  /** Σ quantity × price, before discounts. */
  subtotal: number;
  discountTotal: number;
  taxTotal: number;
  /** subtotal − discounts + tax: everything on the quote, recurring lines counted once. */
  total: number;
  /** One-time lines, tax included. */
  oneTime: number;
  /** Recurring lines per period, tax included. */
  recurring: Record<RecurringPeriod, number>;
};

const units = (v: Dec | null | undefined, scale = 2) => {
  const u = toUnits(v ?? 0, scale);
  return BigInt(Number.isFinite(u) ? u : 0);
};

/**
 * quantity × unit price × (1 − discount%), then tax% on that. Each step is
 * rounded to the cent (half away from zero), so a line's figures add up the
 * way a printed quote reads.
 */
export function lineAmounts(line: QuoteLineMath): LineAmounts {
  const gross = divRound(units(line.quantity) * units(line.unitPrice), 100n);
  const discount = divRound(gross * units(line.discountPercent), 10_000n);
  const net = gross - discount;
  const tax = divRound(net * units(line.taxRate), 10_000n);
  return { gross: Number(gross), discount: Number(discount), net: Number(net), tax: Number(tax), total: Number(net + tax) };
}

export function quoteTotals(lines: readonly QuoteLineMath[]): QuoteTotals {
  const out: QuoteTotals = { lines: [], subtotal: 0, discountTotal: 0, taxTotal: 0, total: 0, oneTime: 0, recurring: { monthly: 0, quarterly: 0, yearly: 0 } };
  for (const line of lines) {
    const a = lineAmounts(line);
    out.lines.push(a);
    out.subtotal += a.gross;
    out.discountTotal += a.discount;
    out.taxTotal += a.tax;
    out.total += a.total;
    const period = line.billingPeriod as RecurringPeriod;
    if ((RECURRING_PERIODS as readonly string[]).includes(period)) out.recurring[period] += a.total;
    else out.oneTime += a.total;
  }
  return out;
}

/** The largest amount a Decimal(14,2) column holds, in cents. */
export const MAX_QUOTE_AMOUNT = 99_999_999_999_999;

/** Why these totals cannot be stored, or null. Every line and sum must fit the money columns. */
export function quoteTotalsTrouble(t: QuoteTotals): string | null {
  const all = [t.subtotal, t.discountTotal, t.taxTotal, t.total, ...t.lines.flatMap((l) => [l.gross, l.net, l.total])];
  return all.some((c) => !Number.isSafeInteger(c) || Math.abs(c) > MAX_QUOTE_AMOUNT) ? "The quote's amounts are too large" : null;
}

/** True when any line repeats. */
export const hasRecurring = (t: Pick<QuoteTotals, "recurring">) => RECURRING_PERIODS.some((p) => t.recurring[p] !== 0);

/**
 * The headline a buyer reads: "$1,200 one-time + $300/month". A quote with
 * only one-time lines reads as its total; amounts are in cents.
 */
export function describeQuoteTotals(t: Pick<QuoteTotals, "oneTime" | "recurring" | "total">, code = "USD", format: (cents: number, code: string) => string = formatMoney): string {
  if (!hasRecurring(t)) return format(t.total, code);
  const parts = t.oneTime ? [`${format(t.oneTime, code)} one-time`] : [];
  for (const p of RECURRING_PERIODS) if (t.recurring[p]) parts.push(`${format(t.recurring[p], code)}${PERIOD_SUFFIX[p]}`);
  return parts.join(" + ");
}

// ─── Status ──────────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;

/** The first instant a quote valid until `validUntil` (a date, read in UTC) no longer is: the start of the next UTC day. */
export function quoteExpiresAt(validUntil: Date | string | null | undefined): Date | null {
  if (!validUntil) return null;
  const d = typeof validUntil === "string" ? new Date(`${validUntil.slice(0, 10)}T00:00:00Z`) : validUntil;
  if (Number.isNaN(d.getTime())) return null;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) + DAY_MS);
}

/**
 * The status to show and act on. Expiry is computed, not stored: a sent or
 * viewed quote past its valid-until date reads as expired and cannot be
 * accepted, without a sweep having to run first.
 */
export function effectiveQuoteStatus(q: { status: string; validUntil: Date | string | null | undefined }, now = new Date()): QuoteStatus {
  const status = (QUOTE_STATUSES as readonly string[]).includes(q.status) ? (q.status as QuoteStatus) : "draft";
  if (!OPEN_QUOTE_STATUSES.includes(status)) return status;
  const expires = quoteExpiresAt(q.validUntil);
  return expires && now >= expires ? "expired" : status;
}

// ─── Inputs ──────────────────────────────────────────────────────────────────

/**
 * POST /products — a product made by hand. Synced products (Product.source,
 * packages/shared/src/catalog-sync.ts) come in through the catalog sync and
 * are never created or edited through these inputs.
 */
export const ProductInput = z.object({
  name: requiredText(200),
  sku: text(64).default(""),
  description: text(2000).default(""),
  category: text(120).default(""),
  /** Products sold as packages of one offering share it ("Guest Posts"). */
  groupName: text(300).default(""),
  /** What one unit is: "hour", "guest post". */
  unit: text(60).default(""),
  unitPrice: money.default("0.00"),
  /** What one unit costs to deliver, for margin. */
  costPrice: decimal({ min: 0, max: 1_000_000_000 }).nullable().default(null),
  currency: currency.optional(),
  billingPeriod: z.enum(BILLING_PERIODS).default("one_time"),
  taxRate: percent.default("0.00"),
});
export const ProductUpdate = z.object({
  name: requiredText(200).optional(),
  sku: text(64).optional(),
  description: text(2000).optional(),
  category: text(120).optional(),
  groupName: text(300).optional(),
  unit: text(60).optional(),
  unitPrice: money.optional(),
  costPrice: decimal({ min: 0, max: 1_000_000_000 }).nullable().optional(),
  currency: currency.optional(),
  billingPeriod: z.enum(BILLING_PERIODS).optional(),
  taxRate: percent.optional(),
  /** true archives (hidden from the quote editor's picker), false restores. */
  archived: z.boolean().optional(),
});
export const ProductListQuery = ListQuery.extend({
  q: text(200).optional(),
  /** "active" (default), "archived" or "all". */
  state: z.enum(["active", "archived", "all"]).default("active"),
});

export const QuoteLineInput = z.object({
  /** The catalogue product it came from; the line keeps its own copy of the name and price. */
  productId: optionalUuid,
  name: requiredText(200),
  description: text(2000).default(""),
  quantity: quantity.default("1.00"),
  unitPrice: money.default("0.00"),
  discountPercent: percent.default("0.00"),
  taxRate: percent.default("0.00"),
  billingPeriod: z.enum(BILLING_PERIODS).default("one_time"),
});

const quoteHeader = {
  dealId: optionalUuid,
  contactId: optionalUuid,
  companyId: optionalUuid,
  ownerId: optionalUuid,
  currency: currency.optional(),
  validUntil: z.union([z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD"), z.null()]).optional(),
  intro: text(10_000).optional(),
  terms: text(20_000).optional(),
};

/** POST /quotes. With a dealId, the deal's contact, company, owner, currency and name fill whatever is left out. */
export const QuoteCreateInput = z.object({
  ...quoteHeader,
  title: text(200).optional(),
  lineItems: z.array(QuoteLineInput).max(200).optional(),
});

/** PATCH /quotes/:id. `lineItems`, when given, replaces every line (in order). */
export const QuoteUpdateInput = z.object({
  ...quoteHeader,
  title: requiredText(200).optional(),
  lineItems: z.array(QuoteLineInput).max(200).optional(),
});

export const QuoteListQuery = ListQuery.extend({
  status: z.enum(QUOTE_STATUSES).optional(),
  dealId: z.string().uuid().optional(),
  contactId: z.string().uuid().optional(),
  /** "me" or a member's user id. */
  ownerId: z.string().max(40).optional(),
  q: text(200).optional(),
});

/** POST /quotes/:id/send — email the buyer a link to the quote from one of the workspace's mailboxes. */
export const QuoteSendInput = z.object({
  /** Default: a connected mailbox of the quote's owner, else the one with the most room today. */
  mailboxId: optionalUuid,
  /** Default: the contact's email address. */
  to: email.optional(),
  subject: text(300).optional(),
  /** Plain text above the link. */
  message: text(5000).optional(),
});

/** A drawn signature: a PNG data URL from the signing canvas, at most ~200 KB. */
const DRAWN_SIGNATURE = /^data:image\/png;base64,[A-Za-z0-9+/]+=*$/;

export const QuoteSignature = z.discriminatedUnion("type", [
  z.object({ type: z.literal("typed"), data: requiredText(120) }),
  z.object({ type: z.literal("drawn"), data: z.string().max(280_000, "That signature is too large").regex(DRAWN_SIGNATURE, "Draw your signature again") }),
]);

/** POST /public/quotes/:token/accept */
export const QuoteAcceptInput = z.object({
  signerName: requiredText(120),
  signerEmail: email,
  signerTitle: text(120).optional(),
  signature: QuoteSignature,
  agree: z.literal(true, { error: "Tick the box to agree to the quote and its terms" }),
});

/** POST /public/quotes/:token/decline */
export const QuoteDeclineInput = z.object({ reason: text(1000).default("") });

export type ProductInputT = z.infer<typeof ProductInput>;
export type ProductUpdateT = z.infer<typeof ProductUpdate>;
export type QuoteLineInputT = z.input<typeof QuoteLineInput>;
export type QuoteCreateInputT = z.infer<typeof QuoteCreateInput>;
export type QuoteUpdateInputT = z.infer<typeof QuoteUpdateInput>;
export type QuoteListQueryT = z.infer<typeof QuoteListQuery>;
export type QuoteSendInputT = z.infer<typeof QuoteSendInput>;
export type QuoteAcceptInputT = z.infer<typeof QuoteAcceptInput>;
export type QuoteDeclineInputT = z.infer<typeof QuoteDeclineInput>;

// ─── The public page ─────────────────────────────────────────────────────────

/** GET /public/quotes/:token — what the buyer's page shows. Amounts are fixed-scale decimal strings. */
export type QuotePublicView = {
  number: string;
  title: string;
  /** The effective status (expiry computed). Draft: being revised, content withheld; void: withdrawn. */
  status: QuoteStatus;
  currency: string;
  validUntil: string | null;
  sentAt: string | null;
  intro: string;
  terms: string;
  from: { workspaceName: string; legalName: string; postalAddress: string; senderName: string; senderEmail: string };
  to: { name: string; email: string; company: string };
  lineItems: { name: string; description: string; quantity: string; unitPrice: string; discountPercent: string; taxRate: string; billingPeriod: BillingPeriod; total: string }[];
  totals: { subtotal: string; discountTotal: string; taxTotal: string; total: string; oneTime: string; recurring: Record<RecurringPeriod, string>; summary: string };
  acceptance: { signerName: string; signerTitle: string; signerEmail: string; acceptedAt: string; signatureType: "typed" | "drawn"; signature: string; documentHash: string } | null;
  declinedAt: string | null;
  /** The product's name, for the "Sent with …" line. */
  productName: string;
};
