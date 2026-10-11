import type { MrrMovementKind, SubscriptionStatus } from "@growthdesk/shared";
import { PAYING_STATUSES } from "../billing/subscription-history.js";

/*
 * Pure revenue arithmetic over the subscription status history
 * (SubscriptionStatusChange rows). No database, no clock: tested in
 * revenue-math.spec.ts.
 *
 * Each history row says what one account's subscription became (status, MRR,
 * currency) at a moment. A movement compares a row with the same account's
 * previous row:
 *   0 → >0          new, or reactivation when the account had paid before
 *   >0 → 0          churn
 *   >0 → more/less  expansion / contraction
 * The first row of an account has no previous row. Its previous MRR is known
 * to be 0 when the subscription was just created or came from a non-paying
 * status (a trial); when it came from a paying status, the account was
 * already paying before tracking began and the amount is unknown — that row
 * is reported as "unclassified" rather than guessed.
 */

export type HistoryRow = {
  billingAccountId: string;
  at: Date;
  fromStatus: SubscriptionStatus | null;
  toStatus: SubscriptionStatus;
  mrrCents: number;
  currency: string;
};

export type Movement = { kind: MrrMovementKind; billingAccountId: string; currency: string; amountCents: number; at: Date };

type Point = { mrrCents: number; currency: string };

/** The movement(s) between two known states of one account. A currency switch moves revenue between currencies without counting a lost or won customer. */
export function classifyChange(prev: Point, next: Point, everPaid: boolean): { kind: MrrMovementKind; currency: string; amountCents: number }[] {
  const p = prev.mrrCents;
  const n = next.mrrCents;
  if (p > 0 && n > 0 && prev.currency !== next.currency) {
    return [
      { kind: "contraction", currency: prev.currency, amountCents: p },
      { kind: "expansion", currency: next.currency, amountCents: n },
    ];
  }
  if (p <= 0 && n > 0) return [{ kind: everPaid ? "reactivation" : "new", currency: next.currency, amountCents: n }];
  if (p > 0 && n <= 0) return [{ kind: "churn", currency: prev.currency, amountCents: p }];
  if (n > p) return [{ kind: "expansion", currency: next.currency, amountCents: n - p }];
  if (n < p) return [{ kind: "contraction", currency: next.currency, amountCents: p - n }];
  return [];
}

/**
 * Every movement in the history, in time order. `rows` may hold several
 * accounts in any order; each account's rows should be complete up to the
 * latest moment of interest (earlier rows decide "previous MRR" and
 * "has paid before").
 */
export function classifyMovements(rows: HistoryRow[]): { movements: Movement[]; unclassified: HistoryRow[] } {
  const byAccount = new Map<string, HistoryRow[]>();
  for (const r of rows) {
    const list = byAccount.get(r.billingAccountId) ?? [];
    list.push(r);
    byAccount.set(r.billingAccountId, list);
  }
  const movements: Movement[] = [];
  const unclassified: HistoryRow[] = [];
  for (const list of byAccount.values()) {
    list.sort((a, b) => a.at.getTime() - b.at.getTime());
    let prev: Point | null = null;
    let everPaid = false;
    for (const row of list) {
      const known: Point | null =
        prev ?? (row.fromStatus === null || !PAYING_STATUSES.includes(row.fromStatus) ? { mrrCents: 0, currency: row.currency } : null);
      if (known) {
        for (const m of classifyChange(known, row, everPaid)) movements.push({ ...m, billingAccountId: row.billingAccountId, at: row.at });
      } else {
        unclassified.push(row);
        everPaid = true; // It was in a paying status before tracking began.
      }
      if (row.mrrCents > 0) everPaid = true;
      prev = { mrrCents: row.mrrCents, currency: row.currency };
    }
  }
  movements.sort((a, b) => a.at.getTime() - b.at.getTime());
  return { movements, unclassified };
}

export type MovementTotals = {
  newCents: number;
  expansionCents: number;
  contractionCents: number;
  churnCents: number;
  reactivationCents: number;
  netCents: number;
  counts: Record<MrrMovementKind, number>;
};

export function sumMovements(movements: Movement[]): MovementTotals {
  const t: MovementTotals = {
    newCents: 0,
    expansionCents: 0,
    contractionCents: 0,
    churnCents: 0,
    reactivationCents: 0,
    netCents: 0,
    counts: { new: 0, expansion: 0, contraction: 0, churn: 0, reactivation: 0 },
  };
  for (const m of movements) {
    t[`${m.kind}Cents`] += m.amountCents;
    t.counts[m.kind] += 1;
  }
  t.netCents = t.newCents + t.expansionCents + t.reactivationCents - t.contractionCents - t.churnCents;
  return t;
}

/**
 * Trials that started in [from, to) and how many of them later became
 * active (at any time up to the newest row). One trial per account: its first
 * start in the range. `rows` must include each account's rows after `to`.
 */
export function trialConversion(rows: HistoryRow[], from: Date, to: Date): { billingAccountId: string; currency: string; converted: boolean }[] {
  const sorted = [...rows].sort((a, b) => a.at.getTime() - b.at.getTime());
  const starts = new Map<string, HistoryRow>();
  for (const r of sorted) {
    if (r.at < from || r.at >= to) continue;
    if (r.toStatus === "trialing" && r.fromStatus !== "trialing" && !starts.has(r.billingAccountId)) starts.set(r.billingAccountId, r);
  }
  return [...starts.values()].map((start) => ({
    billingAccountId: start.billingAccountId,
    currency: start.currency,
    converted: sorted.some((r) => r.billingAccountId === start.billingAccountId && r.at > start.at && r.toStatus === "active"),
  }));
}

/** a ÷ b to 4 decimal places; null when b is 0. */
export const ratio = (a: number, b: number): number | null => (b > 0 ? Math.round((a / b) * 10_000) / 10_000 : null);

/**
 * Paying accounts at the start of a period, worked back from today's count:
 * every customer won since then (new, reactivation) was not paying at the
 * start, every customer lost (churn) was.
 */
export function payingAtStart(payingNow: number, movementsSinceStart: Movement[]): number {
  let gained = 0;
  let lost = 0;
  for (const m of movementsSinceStart) {
    if (m.kind === "new" || m.kind === "reactivation") gained += 1;
    if (m.kind === "churn") lost += 1;
  }
  return Math.max(0, payingNow - gained + lost);
}
