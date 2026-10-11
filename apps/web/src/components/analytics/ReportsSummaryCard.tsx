"use client";

import { BarChart3, CalendarRange } from "lucide-react";
import { localDay, presetRange } from "@growthdesk/shared";
import { Button } from "@/components/ui/Button";
import { Card, CardHeader } from "@/components/ui/Card";
import { formatNumber, formatPercent } from "@/lib/format";
import { useApiQuery } from "@/lib/query";
import { useFormat, useWorkspace } from "@/lib/session";
import type { AnalyticsOverview } from "@/lib/types/analytics";

/** Home-page glance at the last 30 days (same request, and cache entry, as Reports with its default range). */
export function ReportsSummaryCard() {
  const ws = useWorkspace();
  const f = useFormat();
  const range = presetRange("30d", localDay(new Date(), ws.timezone));
  const q = useApiQuery<AnalyticsOverview>(ws.key("analytics", "overview"), ws.path("/analytics/overview"), { query: range });
  const o = q.data;
  const cells = [
    { label: "Messages sent", value: o && formatNumber(o.outreach.sent) },
    { label: "Reply rate", value: o && formatPercent(o.outreach.replyRate) },
    { label: "Deals won", value: o && formatNumber(o.pipeline.won) },
    { label: `Value won (${ws.currency})`, value: o && f.money(o.pipeline.valueWon, o.range.currency) },
  ];
  return (
    <Card className="mb-5">
      <CardHeader
        icon={<CalendarRange />}
        title="Last 30 days"
        description={q.isError ? `Could not load: ${q.error.message}` : undefined}
        actions={
          <Button size="sm" variant="ghost" icon={<BarChart3 />} href={ws.href("/reports")}>
            Reports
          </Button>
        }
      />
      <dl className="grid grid-cols-2 sm:grid-cols-4">
        {cells.map((c) => (
          <div key={c.label} className="px-4 py-3">
            <dt className="text-xs text-text-3">{c.label}</dt>
            <dd className="mt-0.5 text-lg font-semibold text-text-hi tabular-nums">{c.value ?? <span className="text-text-3">…</span>}</dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}
