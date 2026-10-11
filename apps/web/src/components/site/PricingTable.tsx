"use client";

import Link from "next/link";
import { useState } from "react";
import { Check, Minus } from "lucide-react";
import { FEATURE_KEYS, FEATURE_LABELS, formatMoney, isUnlimited, LIMIT_KEYS, LIMIT_LABELS, type LimitKey } from "@growthdesk/shared";
import { Card } from "@/components/ui/Card";
import { cn } from "@/lib/cn";
import type { PublicPlan } from "@/lib/site";

/*
 * The public plans (GET /v1/plans) with a monthly/annual switch. Prices,
 * limits and features are the plan rows as the super-admin set them; the
 * labels are the shared catalogue's (packages/shared/src/plans.ts).
 */

type Interval = "monthly" | "annual";

const fmtLimit = (n: number | undefined) => (n === undefined ? "—" : isUnlimited(n) ? "Unlimited" : new Intl.NumberFormat("en-US").format(n));

/** The limits shown on each card, most decisive first; the comparison table lists them all. */
const CARD_LIMITS: LimitKey[] = ["contacts", "seats", "mailboxes", "monthlyEmails", "marketingContacts", "monthlyAiCredits"];

function price(plan: PublicPlan, interval: Interval) {
  if (plan.monthlyPriceCents === 0 && plan.annualPriceCents === 0) return { main: formatMoney(0, plan.currency), sub: "Free forever" };
  if (interval === "annual" && plan.annualPriceCents > 0) {
    return {
      main: formatMoney(Math.round(plan.annualPriceCents / 12), plan.currency),
      sub: `per month, billed ${formatMoney(plan.annualPriceCents, plan.currency)} yearly`,
    };
  }
  return { main: formatMoney(plan.monthlyPriceCents, plan.currency), sub: "per month, billed monthly" };
}

function ctaLabel(plan: PublicPlan) {
  if (plan.monthlyPriceCents === 0 && plan.annualPriceCents === 0) return "Start free";
  if (plan.trialDays > 0) return `Start ${plan.trialDays}-day free trial`;
  return "Get started";
}

export function PricingTable({ plans }: { plans: PublicPlan[] }) {
  const hasAnnual = plans.some((p) => p.annualPriceCents > 0 && p.monthlyPriceCents > 0);
  const [interval, setBilling] = useState<Interval>("monthly");
  const bestSaving = Math.max(
    0,
    ...plans.filter((p) => p.monthlyPriceCents > 0 && p.annualPriceCents > 0).map((p) => 1 - p.annualPriceCents / (p.monthlyPriceCents * 12)),
  );
  const shownFeatures = FEATURE_KEYS.filter((k) => plans.some((p) => p.features[k]));

  return (
    <div>
      {hasAnnual && (
        <div className="mb-10 flex justify-center">
          <div role="radiogroup" aria-label="Billing interval" className="inline-flex rounded-full border border-line-strong bg-panel p-1 shadow-sm">
            {(["monthly", "annual"] as const).map((v) => (
              <button
                key={v}
                type="button"
                role="radio"
                aria-checked={interval === v}
                onClick={() => setBilling(v)}
                className={cn(
                  "inline-flex h-8 items-center gap-2 rounded-full px-4 text-sm font-semibold transition-colors",
                  interval === v ? "bg-solid text-on-solid shadow-sm" : "text-text-2 hover:text-text",
                )}
              >
                {v === "monthly" ? "Monthly" : "Annual"}
                {v === "annual" && bestSaving >= 0.01 && (
                  <span className={cn("rounded-full px-1.5 py-0.5 text-2xs font-bold", interval === v ? "bg-on-solid/15" : "bg-ok-chip text-ok-ink")}>
                    Save up to {Math.round(bestSaving * 100)}%
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>
      )}

      <ul className={cn("grid gap-4", plans.length >= 4 ? "md:grid-cols-2 xl:grid-cols-4" : plans.length === 3 ? "md:grid-cols-3" : "md:grid-cols-2")}>
        {plans.map((plan) => {
          const p = price(plan, interval);
          return (
            <li key={plan.key}>
              <Card className="flex h-full flex-col p-6">
                <h2 className="text-lg font-semibold tracking-[-0.015em] text-text-hi">{plan.name}</h2>
                {plan.description && <p className="mt-1.5 min-h-10 text-sm text-text-3">{plan.description}</p>}
                <div className="mt-5 flex items-baseline gap-1.5">
                  <span className="text-[36px] leading-none font-semibold tracking-[-0.03em] text-text-hi">{p.main}</span>
                </div>
                <p className="mt-1.5 text-xs text-text-3">{p.sub}</p>
                <Link
                  href="/register"
                  className="mt-6 inline-flex h-10 items-center justify-center rounded-md bg-accent px-4 text-sm font-semibold text-on-accent shadow-solid transition-colors hover:bg-accent-hi"
                >
                  {ctaLabel(plan)}
                </Link>
                <ul className="mt-6 flex flex-col gap-2.5 border-t border-line pt-5 text-sm">
                  {CARD_LIMITS.map((k) => (
                    <li key={k} className="flex items-baseline justify-between gap-3">
                      <span className="text-text-2">{LIMIT_LABELS[k]}</span>
                      <span className="font-semibold whitespace-nowrap text-text-hi tabular-nums">{fmtLimit(plan.limits[k])}</span>
                    </li>
                  ))}
                </ul>
                {shownFeatures.some((k) => plan.features[k]) && (
                  <ul className="mt-5 flex flex-col gap-2 border-t border-line pt-5 text-sm">
                    {shownFeatures
                      .filter((k) => plan.features[k])
                      .map((k) => (
                        <li key={k} className="flex items-start gap-2 text-text-2">
                          <Check aria-hidden className="mt-0.5 size-4 shrink-0 text-ok" />
                          {FEATURE_LABELS[k]}
                        </li>
                      ))}
                  </ul>
                )}
              </Card>
            </li>
          );
        })}
      </ul>

      <section aria-labelledby="compare-title" className="mt-20">
        <h2 id="compare-title" className="mb-6 text-center text-2xl font-semibold tracking-[-0.02em] text-text-hi">
          Compare plans
        </h2>
        <Card className="overflow-x-auto">
          <table className="w-full min-w-[640px] border-collapse text-left text-sm">
            <thead>
              <tr className="border-b border-line bg-well">
                <th scope="col" className="px-4 py-3 font-semibold text-text-hi">
                  <span className="sr-only">Limit or feature</span>
                </th>
                {plans.map((p) => (
                  <th key={p.key} scope="col" className="px-4 py-3 text-center font-semibold text-text-hi">
                    {p.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr>
                <th colSpan={plans.length + 1} scope="colgroup" className="bg-bg px-4 pt-4 pb-2 text-xs font-semibold tracking-wide text-text-3 uppercase">
                  Limits
                </th>
              </tr>
              {LIMIT_KEYS.map((k) => (
                <tr key={k} className="border-b border-line">
                  <th scope="row" className="px-4 py-2.5 font-medium text-text-2">
                    {LIMIT_LABELS[k]}
                  </th>
                  {plans.map((p) => (
                    <td key={p.key} className="px-4 py-2.5 text-center text-text-hi tabular-nums">
                      {fmtLimit(p.limits[k])}
                    </td>
                  ))}
                </tr>
              ))}
              <tr>
                <th colSpan={plans.length + 1} scope="colgroup" className="bg-bg px-4 pt-4 pb-2 text-xs font-semibold tracking-wide text-text-3 uppercase">
                  Features
                </th>
              </tr>
              {FEATURE_KEYS.map((k) => (
                <tr key={k} className="border-b border-line last:border-b-0">
                  <th scope="row" className="px-4 py-2.5 font-medium text-text-2">
                    {FEATURE_LABELS[k]}
                  </th>
                  {plans.map((p) => (
                    <td key={p.key} className="px-4 py-2.5 text-center">
                      {p.features[k] ? (
                        <Check aria-label="Included" className="mx-auto size-4 text-ok" />
                      ) : (
                        <Minus aria-label="Not included" className="mx-auto size-4 text-text-3" />
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      </section>
    </div>
  );
}
