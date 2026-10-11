import { z } from "zod";
import { localDateParam, localDayDiff } from "./analytics.js";

/*
 * Platform revenue (GET /v1/admin/revenue, platform admin and above).
 *
 * Days are UTC calendar days "YYYY-MM-DD", both ends inclusive. Every figure
 * is per currency — there is no FX conversion. Amounts are in the smallest
 * currency unit (cents).
 */

export const PLATFORM_REVENUE_DEFAULT_DAYS = 30;
/** Longest range one request may cover (two years of daily points). */
export const PLATFORM_REVENUE_MAX_DAYS = 731;

export const PlatformRevenueQuery = z
  .object({ from: localDateParam.optional(), to: localDateParam.optional() })
  .superRefine((v, ctx) => {
    if (!v.from || !v.to) return;
    const span = localDayDiff(v.from, v.to);
    if (span < 0) ctx.addIssue({ code: "custom", path: ["to"], message: "The end date is before the start date" });
    else if (span + 1 > PLATFORM_REVENUE_MAX_DAYS) ctx.addIssue({ code: "custom", path: ["to"], message: `A report can cover at most ${PLATFORM_REVENUE_MAX_DAYS} days` });
  });
export type PlatformRevenueQueryT = z.infer<typeof PlatformRevenueQuery>;

/** MRR movement kinds, classified from the subscription status history. */
export const MRR_MOVEMENT_KINDS = ["new", "expansion", "contraction", "churn", "reactivation"] as const;
export type MrrMovementKind = (typeof MRR_MOVEMENT_KINDS)[number];

/** One currency's MRR headline (also on GET /v1/admin/overview as `revenue.mrr`). */
export type PlatformMrrHeadline = {
  currency: string;
  mrrCents: number;
  /** Accounts in a paying status (active / past_due) with MRR above zero. */
  payingCount: number;
  trialingCount: number;
  /** True when any paying subscription's MRR comes from a plan list price instead of the provider's real price. */
  estimated: boolean;
  /** Paying subscriptions without a real provider price (their MRR is the plan list price). */
  unpricedCount: number;
};

export type PlatformRevenueSource = PlatformMrrHeadline & {
  /** "stripe", "manual" (assigned in admin, invoiced outside the app) or "none" (no payment provider). */
  provider: string;
};

export type PlatformRevenueCurrency = PlatformMrrHeadline & {
  arrCents: number;
  /** MRR ÷ paying accounts, rounded; null with no paying accounts. */
  arpaCents: number | null;
  /** The same figures split by payment provider — Stripe-billed revenue separate from manual and unbilled. */
  sources: PlatformRevenueSource[];
  /** Movement in the range, from the subscription status history. */
  movement: {
    newCents: number;
    expansionCents: number;
    contractionCents: number;
    churnCents: number;
    reactivationCents: number;
    /** new + expansion + reactivation − contraction − churn. */
    netCents: number;
    counts: Record<MrrMovementKind, number>;
    /** Changes whose previous MRR is unknown (the subscription was already paying before tracking began). */
    unclassified: number;
  };
  /** Trials started in the range (since tracking began) and how many of those later became active. */
  trialConversion: { started: number; converted: number; rate: number | null };
  /** Paying accounts lost in the range ÷ paying accounts at its start (since tracking began). */
  logoChurn: { payingAtStart: number; churned: number; rate: number | null };
  /** Paid invoices by UTC month (paid date), the last 12 months including the current one, oldest first. */
  collected: { month: string; amountCents: number; invoices: number }[];
  /** Daily snapshots in the range; days before the first snapshot are absent, not zero. */
  daily: { day: string; mrrCents: number; payingCount: number; trialingCount: number }[];
  plans: { planId: string; key: string; name: string; subscribers: number; trialing: number; mrrCents: number; estimated: boolean }[];
  /** Highest-MRR accounts in this currency, at most 10. */
  topAccounts: {
    billingAccountId: string;
    name: string;
    plan: { key: string; name: string };
    provider: string;
    status: string;
    interval: "month" | "year";
    mrrCents: number;
    estimated: boolean;
  }[];
};

export type PlatformRevenueReport = {
  generatedAt: string;
  range: { from: string; to: string; days: number };
  /** When the subscription status history starts (its first row); null before any change was recorded. */
  trackingSince: string | null;
  /** Movement, trial conversion and churn cover max(range start, trackingSince) → range end. */
  effectiveFrom: string | null;
  /** The first daily MRR snapshot; earlier days have no series data. */
  snapshotsSince: string | null;
  currencies: PlatformRevenueCurrency[];
};
