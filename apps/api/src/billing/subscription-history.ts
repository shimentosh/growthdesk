import type { BillingInterval, SubscriptionStatus } from "@growthdesk/shared";
import type { Db, Tx } from "../prisma/prisma.service.js";

/*
 * Subscription history and the MRR maths behind platform revenue reporting.
 *
 * recordSubscriptionChange() is called wherever a Subscription row is created
 * or its status, plan or interval changes (billing webhooks and
 * reconciliation, sign-up, trial expiry, self-service cancel, payment failure,
 * admin plan assignment), inside the same transaction as the write where the
 * caller has one. It writes one SubscriptionStatusChange only when something
 * revenue-relevant actually changed, so re-applying the same state is a no-op.
 *
 * MRR rules (docs/BILLING.md, platform revenue):
 * - Only paying statuses carry revenue: `active` and `past_due` (still owed,
 *   still a customer). `trialing`, `incomplete`, `canceled`, `expired` are 0.
 * - The amount is what the provider charges (Subscription.priceCents) when
 *   known; otherwise the plan's list price for the interval, and the result is
 *   flagged `estimated` (manual / provider "none" subscriptions, and provider
 *   subscriptions whose price has not been read yet).
 * - Annual amounts are divided by 12 and rounded to the nearest cent.
 * - No currency conversion anywhere: every figure carries its own currency.
 */

export const PAYING_STATUSES: readonly SubscriptionStatus[] = ["active", "past_due"];

export type PlanPrice = { monthlyPriceCents: number; annualPriceCents: number; currency: string };

export type MrrInput = {
  status: SubscriptionStatus;
  interval: BillingInterval;
  priceCents: number | null;
  priceCurrency: string | null;
};

export type Mrr = {
  /** Monthly recurring revenue in the smallest unit of `currency`; 0 when not paying. */
  mrrCents: number;
  currency: string;
  /** True when the amount comes from the plan's list price rather than the provider's real price. */
  estimated: boolean;
  /** Paying status (active / past_due), whatever the amount. */
  paying: boolean;
};

/** Monthly-normalised amount for one interval's charge (annual ÷ 12, rounded). */
export function monthlyAmount(amountCents: number, interval: BillingInterval): number {
  return interval === "year" ? Math.round(amountCents / 12) : amountCents;
}

export function subscriptionMrr(sub: MrrInput, plan: PlanPrice): Mrr {
  const real = sub.priceCents !== null && sub.priceCents !== undefined;
  const currency = (real && sub.priceCurrency ? sub.priceCurrency : plan.currency).toUpperCase();
  const paying = PAYING_STATUSES.includes(sub.status);
  if (!paying) return { mrrCents: 0, currency, estimated: false, paying };
  const amount = real ? sub.priceCents! : sub.interval === "year" ? plan.annualPriceCents : plan.monthlyPriceCents;
  return { mrrCents: Math.max(0, monthlyAmount(amount, sub.interval)), currency, estimated: !real, paying };
}

/** The subscription fields the history cares about. */
export type SubscriptionState = MrrInput & {
  id: string;
  billingAccountId: string;
  planId: string;
  provider: string;
};

type Client = Tx | Db;

/**
 * Logs a revenue-relevant change of one subscription. `before` is the row as
 * it was (null when it was just created), `after` the row as written. Returns
 * true when a row was written.
 *
 * `at` defaults to now on purpose: each row is computed against the row
 * before it, so the history must be in the order changes were applied — a
 * provider's event timestamp (whole seconds, possibly delivered late) is not.
 *
 * A price that is merely read for the first time (null → known, same status,
 * plan and interval) is not logged: nothing changed for the customer, and
 * logging it would show up as a fake expansion or contraction.
 */
export async function recordSubscriptionChange(db: Client, before: SubscriptionState | null, after: SubscriptionState, at: Date = new Date()): Promise<boolean> {
  const plans = await db.plan.findMany({
    where: { id: { in: [...new Set([after.planId, before?.planId].filter((x): x is string => Boolean(x)))] } },
    select: { id: true, monthlyPriceCents: true, annualPriceCents: true, currency: true },
  });
  const planOf = (id: string) => plans.find((p) => p.id === id);
  const afterPlan = planOf(after.planId);
  if (!afterPlan) return false;
  const next = subscriptionMrr(after, afterPlan);

  if (before) {
    const beforePlan = planOf(before.planId);
    const prev = beforePlan ? subscriptionMrr(before, beforePlan) : null;
    const sameShape = before.status === after.status && before.planId === after.planId && before.interval === after.interval && before.provider === after.provider;
    const priceJustLearned = before.priceCents === null && after.priceCents !== null;
    if (sameShape && (priceJustLearned || (prev && prev.mrrCents === next.mrrCents && prev.currency === next.currency))) return false;
  }

  await db.subscriptionStatusChange.create({
    data: {
      subscriptionId: after.id,
      billingAccountId: after.billingAccountId,
      fromStatus: before?.status ?? null,
      toStatus: after.status,
      planId: after.planId,
      interval: after.interval,
      mrrCents: next.mrrCents,
      currency: next.currency,
      provider: after.provider,
      at,
    },
  });
  return true;
}
