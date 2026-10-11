"use client";

import { TrendingUp } from "lucide-react";
import type { PlatformMrrHeadline } from "@growthdesk/shared";
import { Badge } from "@/components/ui/Badge";
import { StatCard } from "@/components/ui/StatCard";
import { Tooltip } from "@/components/ui/Tooltip";
import { formatMoney, formatNumber } from "@/lib/format";

type WithRevenue = { revenue?: { mrr: PlatformMrrHeadline[] } | null };

/**
 * The dashboard's MRR tiles, one per currency, from GET /admin/overview
 * `revenue.mrr`. The API sends `revenue: null` to support staff (revenue is
 * admin-only), and then nothing is shown.
 * `data` is the overview response (the field is newer than the shared AdminOverview type).
 */
export function MrrHeadline({ data }: { data: object | undefined }) {
  const revenue = (data as WithRevenue | undefined)?.revenue;
  if (!revenue) return null;
  if (!revenue.mrr.length) {
    return (
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="MRR" icon={<TrendingUp />} tint="green" href="/revenue" value="—" hint="No paying or trialing subscriptions yet" />
      </div>
    );
  }
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {revenue.mrr.map((m) => (
        <StatCard
          key={m.currency}
          label={
            <span className="inline-flex items-center gap-1.5">
              MRR{revenue.mrr.length > 1 ? ` · ${m.currency}` : ""}
              {m.estimated && (
                <Tooltip content={`${formatNumber(m.unpricedCount)} paying subscription${m.unpricedCount === 1 ? " is" : "s are"} counted at the plan's list price (no price from a payment provider).`}>
                  <span tabIndex={0} className="inline-flex rounded-xs outline-none focus-visible:ring-2 focus-visible:ring-accent-ring">
                    <Badge tone="warn">Estimated</Badge>
                  </span>
                </Tooltip>
              )}
            </span>
          }
          icon={<TrendingUp />}
          tint="green"
          href={`/revenue?currency=${m.currency}`}
          value={formatMoney(m.mrrCents, m.currency)}
          hint={`${formatNumber(m.payingCount)} paying · ${formatNumber(m.trialingCount)} trialing`}
        />
      ))}
    </div>
  );
}
