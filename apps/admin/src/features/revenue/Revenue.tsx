"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { ReactNode } from "react";
import { Lock, RefreshCw, TrendingUp, Users, Hourglass, Repeat, CalendarRange, CircleDollarSign } from "lucide-react";
import {
  addLocalDays,
  isLocalDateString,
  labelOf,
  localDayDiff,
  PLATFORM_REVENUE_MAX_DAYS,
  type PlatformRevenueCurrency,
  type PlatformRevenueReport,
} from "@growthdesk/shared";
import { Badge, StatusBadge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Card, CardHeader } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { IconTile } from "@/components/ui/IconTile";
import { Input, NativeSelect } from "@/components/ui/Input";
import { Page, PageHeader } from "@/components/ui/PageHeader";
import { Skeleton } from "@/components/ui/Skeleton";
import { StatCard } from "@/components/ui/StatCard";
import { Tooltip } from "@/components/ui/Tooltip";
import { platformKey, PLATFORM_ROLE_LABELS, providerLabel, table, usePlatform } from "@/features/common/platform";
import { cn } from "@/lib/cn";
import { formatCurrency, formatDate, formatMoney, formatNumber, formatPercent } from "@/lib/format";
import { useApiQuery } from "@/lib/query";
import { useFormat } from "@/lib/session";
import { ColumnChart, DailyLineChart } from "./charts";

/*
 * /revenue — recurring revenue across the installation (GET /admin/revenue,
 * platform admin and above). Every figure is per currency with no
 * conversion; the currency switcher picks which one the page shows. Nothing
 * is filled in: a day without a snapshot, a month without paid invoices, or
 * a period before tracking began is shown as exactly that.
 *
 * The range and currency live in the URL (?range=30|90|365|custom&from&to&currency).
 */

const PRESETS = [
  { key: "30", label: "30 days" },
  { key: "90", label: "90 days" },
  { key: "365", label: "12 months" },
  { key: "custom", label: "Custom" },
] as const;
type PresetKey = (typeof PRESETS)[number]["key"];

const todayUtc = () => new Date().toISOString().slice(0, 10);
/** A UTC calendar day ("2026-10-09") as "Oct 9, 2026". */
const utcDay = (day: string | null | undefined) => (day ? formatDate(`${day}T12:00:00Z`, { timeZone: "UTC" }) : "—");

/** Resolves the URL into the API query, or an error message for an invalid custom range. */
function useRange() {
  const params = useSearchParams();
  const raw = params.get("range");
  const preset: PresetKey = PRESETS.some((p) => p.key === raw) ? (raw as PresetKey) : "30";
  const today = todayUtc();
  if (preset !== "custom") {
    const days = Number(preset);
    return { preset, from: addLocalDays(today, -(days - 1)), to: today, error: null as string | null };
  }
  const from = params.get("from") ?? addLocalDays(today, -29);
  const to = params.get("to") ?? today;
  let error: string | null = null;
  if (!isLocalDateString(from) || !isLocalDateString(to)) error = "Enter both dates.";
  else if (localDayDiff(from, to) < 0) error = "The end date is before the start date.";
  else if (localDayDiff(from, to) + 1 > PLATFORM_REVENUE_MAX_DAYS) error = `A report can cover at most ${PLATFORM_REVENUE_MAX_DAYS} days.`;
  return { preset, from, to, error };
}

function useSetParams() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  return (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === "") next.delete(k);
      else next.set(k, v);
    }
    const qs = next.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };
}

function RangePicker({ value, onChange }: { value: PresetKey; onChange: (v: PresetKey) => void }) {
  return (
    <div role="radiogroup" aria-label="Date range" className="inline-flex h-8 items-center rounded-md border border-line bg-well p-0.5">
      {PRESETS.map((p) => (
        <button
          key={p.key}
          type="button"
          role="radio"
          aria-checked={value === p.key}
          onClick={() => onChange(p.key)}
          className={cn(
            "h-full rounded-sm px-2.5 text-xs font-medium whitespace-nowrap transition-colors outline-none focus-visible:ring-2 focus-visible:ring-accent-ring",
            value === p.key ? "bg-panel text-text-hi shadow-card" : "text-text-3 hover:text-text",
          )}
        >
          {p.label}
        </button>
      ))}
    </div>
  );
}

/** "Estimated" chip; the tooltip says why. The same explanation is printed in the callout above the tiles. */
function EstimatedBadge({ count }: { count: number }) {
  return (
    <Tooltip content={`${formatNumber(count)} paying subscription${count === 1 ? " has" : "s have"} no price from a payment provider; the plan's list price is used.`}>
      <span tabIndex={0} className="inline-flex rounded-xs outline-none focus-visible:ring-2 focus-visible:ring-accent-ring">
        <Badge tone="warn">Estimated</Badge>
      </span>
    </Tooltip>
  );
}

function Panel({ title, description, icon, actions, className, children }: { title: ReactNode; description?: ReactNode; icon?: ReactNode; actions?: ReactNode; className?: string; children: ReactNode }) {
  return (
    <Card className={cn("flex flex-col", className)}>
      <CardHeader title={title} description={description} icon={icon} actions={actions} />
      <div className="flex flex-1 flex-col">{children}</div>
    </Card>
  );
}

// ─── Sections ────────────────────────────────────────────────────────────────

function Kpis({ c, loading }: { c: PlatformRevenueCurrency | undefined; loading: boolean }) {
  const money = (v: number | null | undefined) => (c && v !== null && v !== undefined ? formatMoney(v, c.currency) : "—");
  return (
    <div className="grid grid-cols-1 gap-3 min-[420px]:grid-cols-2 md:grid-cols-3 xl:grid-cols-5">
      <StatCard
        label={
          <span className="inline-flex items-center gap-1.5">
            MRR {c?.estimated && <EstimatedBadge count={c.unpricedCount} />}
          </span>
        }
        icon={<TrendingUp />}
        tint="green"
        loading={loading}
        value={money(c?.mrrCents)}
        hint="Monthly recurring revenue"
      />
      <StatCard label="ARR" icon={<CalendarRange />} tint="teal" loading={loading} value={money(c?.arrCents)} hint="MRR × 12" />
      <StatCard label="ARPA" icon={<CircleDollarSign />} tint="blue" loading={loading} value={money(c?.arpaCents)} hint="MRR per paying account" />
      <StatCard label="Paying accounts" icon={<Users />} tint="indigo" loading={loading} value={formatNumber(c?.payingCount ?? 0)} hint="Active or past due, above zero" />
      <StatCard label="Trialing" icon={<Hourglass />} tint="orange" loading={loading} value={formatNumber(c?.trialingCount ?? 0)} hint="Free trials running now" />
    </div>
  );
}

function MrrTrend({ c, report }: { c: PlatformRevenueCurrency; report: PlatformRevenueReport }) {
  const points = c.daily.map((d) => ({ day: d.day, value: d.mrrCents }));
  const since = report.snapshotsSince;
  const startsLate = since && since > report.range.from;
  return (
    <Panel
      title="MRR trend"
      description={startsLate ? `Daily snapshot at 00:15 UTC. Snapshots start ${utcDay(since)}; earlier days have no data.` : "Daily snapshot at 00:15 UTC."}
      className="lg:col-span-2"
    >
      {points.length >= 2 ? (
        <div className="p-4">
          <DailyLineChart
            points={points}
            from={report.range.from}
            to={report.range.to}
            label={`MRR in ${c.currency}`}
            format={(v) => formatMoney(v, c.currency)}
            formatAxis={(v) => formatCurrency(v / 100, c.currency, { notation: "compact", maximumFractionDigits: 1 })}
          />
        </div>
      ) : (
        <EmptyState
          compact
          icon={<TrendingUp />}
          title={since ? `Snapshots start ${utcDay(since)}` : "No snapshots yet"}
          description={
            points.length === 1
              ? `One snapshot in this range (${utcDay(points[0]!.day)}: ${formatMoney(points[0]!.value, c.currency)}). The trend line appears once there are two.`
              : since
                ? "There are no snapshots in this range. Pick a range that includes days after the first snapshot."
                : "The first snapshot is taken when the worker starts, then every day at 00:15 UTC. Earlier days are never back-filled."
          }
          className="flex-1"
        />
      )}
    </Panel>
  );
}

const SOURCE_BAR: Record<string, string> = { stripe: "bg-accent", manual: "bg-alt", none: "bg-text-3" };

function Sources({ c }: { c: PlatformRevenueCurrency }) {
  const total = c.sources.reduce((a, s) => a + s.mrrCents, 0);
  return (
    <Panel title="Where MRR comes from" description="By how the account is billed.">
      <div className="flex flex-col gap-4 p-4">
        {total > 0 ? (
          <div className="flex h-2.5 w-full gap-0.5 overflow-hidden rounded-full" role="img" aria-label="MRR by billing source, listed below">
            {c.sources
              .filter((s) => s.mrrCents > 0)
              .map((s) => (
                <span
                  key={s.provider}
                  title={`${providerLabel(s.provider)}: ${formatMoney(s.mrrCents, c.currency)} (${formatPercent(s.mrrCents / total, 0)})`}
                  className={cn("h-full min-w-1 first:rounded-l-full last:rounded-r-full", SOURCE_BAR[s.provider] ?? "bg-ok")}
                  style={{ flexGrow: s.mrrCents }}
                />
              ))}
          </div>
        ) : (
          <div className="h-2.5 w-full rounded-full bg-s-3" />
        )}
        {c.sources.length ? (
          <ul className="flex flex-col gap-2.5">
            {c.sources.map((s) => (
              <li key={s.provider} className="flex items-start justify-between gap-3 text-sm">
                <div className="flex min-w-0 items-start gap-2">
                  <span aria-hidden className={cn("mt-1.5 size-2 shrink-0 rounded-full", SOURCE_BAR[s.provider] ?? "bg-ok")} />
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-1.5 font-medium text-text-hi">
                      {providerLabel(s.provider)}
                      {s.estimated && <Badge tone="warn">List price</Badge>}
                    </div>
                    <div className="text-xs text-text-3">
                      {formatNumber(s.payingCount)} paying · {formatNumber(s.trialingCount)} trialing
                    </div>
                  </div>
                </div>
                <div className="shrink-0 text-right">
                  <div className="font-medium text-text-hi tabular-nums">{formatMoney(s.mrrCents, c.currency)}</div>
                  <div className="text-2xs text-text-3 tabular-nums">{total ? formatPercent(s.mrrCents / total, 0) : "—"}</div>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-text-3">No paying or trialing subscriptions in {c.currency}.</p>
        )}
      </div>
      <p className="mt-auto border-t border-line px-4 py-2.5 text-2xs text-text-3">
        Stripe figures are what Stripe charges. Manual (invoiced) and None (no payment provider) use the plan&apos;s list price: they are estimates, not charges this system has seen.
      </p>
    </Panel>
  );
}

function Movement({ c, tracking }: { c: PlatformRevenueCurrency; tracking: ReactNode }) {
  const m = c.movement;
  const rows = [
    { key: "new", label: "New", cents: m.newCents, count: m.counts.new, sign: 1, bar: "bg-ok" },
    { key: "expansion", label: "Expansion", cents: m.expansionCents, count: m.counts.expansion, sign: 1, bar: "bg-ok" },
    { key: "reactivation", label: "Reactivation", cents: m.reactivationCents, count: m.counts.reactivation, sign: 1, bar: "bg-ok" },
    { key: "contraction", label: "Contraction", cents: m.contractionCents, count: m.counts.contraction, sign: -1, bar: "bg-warn" },
    { key: "churn", label: "Churn", cents: m.churnCents, count: m.counts.churn, sign: -1, bar: "bg-bad" },
  ];
  const max = Math.max(1, ...rows.map((r) => r.cents), Math.abs(m.netCents));
  const signed = (cents: number, sign: number) => (cents === 0 ? formatMoney(0, c.currency) : `${sign < 0 ? "−" : "+"}${formatMoney(cents, c.currency)}`);
  return (
    <Panel title="MRR movement" description={tracking} className="lg:col-span-2">
      <dl className="flex flex-col gap-3 p-4">
        {rows.map((r) => (
          <div key={r.key} className="grid grid-cols-[6.5rem_1fr_auto] items-center gap-3 text-sm sm:grid-cols-[8rem_1fr_9rem]">
            <dt className="text-text-2">
              {r.label}
              <span className="ml-1.5 text-2xs text-text-3 tabular-nums">×{formatNumber(r.count)}</span>
            </dt>
            <dd className="h-2.5 rounded-full bg-s-3" aria-hidden>
              <div className={cn("h-full rounded-full", r.bar)} style={{ width: `${(r.cents / max) * 100}%`, minWidth: r.cents > 0 ? 4 : 0 }} />
            </dd>
            <dd className={cn("text-right font-medium tabular-nums", r.cents === 0 ? "text-text-3" : r.sign > 0 ? "text-ok-ink" : r.key === "churn" ? "text-bad-ink" : "text-warn-ink")}>
              {signed(r.cents, r.sign)}
            </dd>
          </div>
        ))}
        <div className="grid grid-cols-[6.5rem_1fr_auto] items-center gap-3 border-t border-line pt-3 text-sm sm:grid-cols-[8rem_1fr_9rem]">
          <dt className="font-medium text-text-hi">Net new MRR</dt>
          <dd className="h-2.5 rounded-full bg-s-3" aria-hidden>
            <div className={cn("h-full rounded-full", m.netCents >= 0 ? "bg-accent" : "bg-bad")} style={{ width: `${(Math.abs(m.netCents) / max) * 100}%`, minWidth: m.netCents ? 4 : 0 }} />
          </dd>
          <dd className={cn("text-right font-semibold tabular-nums", m.netCents > 0 ? "text-ok-ink" : m.netCents < 0 ? "text-bad-ink" : "text-text-hi")}>
            {m.netCents >= 0 ? signed(m.netCents, 1) : signed(-m.netCents, -1)}
          </dd>
        </div>
      </dl>
      {m.unclassified > 0 && (
        <p className="mt-auto border-t border-line px-4 py-2.5 text-2xs text-text-3">
          {formatNumber(m.unclassified)} change{m.unclassified === 1 ? "" : "s"} not classified: the subscription was already paying before tracking began, so its earlier MRR is unknown.
        </p>
      )}
    </Panel>
  );
}

function RateCard({ title, rate, detail, tracking, tone }: { title: string; rate: number | null; detail: ReactNode; tracking: ReactNode; tone?: "ok" | "bad" }) {
  return (
    <Card className="flex flex-col px-4 py-3.5">
      <span className="text-xs font-medium text-text-3">{title}</span>
      <span className={cn("mt-1.5 text-2xl font-semibold tracking-[-0.025em] tabular-nums", rate === null ? "text-text-3" : tone === "bad" ? "text-bad-ink" : tone === "ok" ? "text-ok-ink" : "text-text-hi")}>
        {rate === null ? "—" : formatPercent(rate)}
      </span>
      <span className="mt-0.5 text-xs text-text-2">{detail}</span>
      <span className="mt-2 text-2xs text-text-3">{tracking}</span>
    </Card>
  );
}

function Collected({ c }: { c: PlatformRevenueCurrency }) {
  const total = c.collected.reduce((a, m) => a + m.amountCents, 0);
  const invoices = c.collected.reduce((a, m) => a + m.invoices, 0);
  const points = c.collected.map((m) => {
    const d = new Date(`${m.month}-15T12:00:00Z`);
    return {
      key: m.month,
      label: d.toLocaleString("en-US", { month: "short", timeZone: "UTC" }),
      long: d.toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" }),
      value: m.amountCents,
      note: `${formatNumber(m.invoices)} invoice${m.invoices === 1 ? "" : "s"}`,
    };
  });
  return (
    <Panel
      title="Collected revenue"
      description="Paid invoices from the payment provider, by month paid (UTC). Manual plans invoiced outside the app are not included."
      actions={
        <span className="text-right text-xs text-text-3">
          <span className="font-medium text-text-hi tabular-nums">{formatMoney(total, c.currency)}</span> · {formatNumber(invoices)} invoices, 12 months
        </span>
      }
    >
      {total > 0 ? (
        <div className="p-4">
          <ColumnChart
            points={points}
            label={`Collected revenue in ${c.currency} by month`}
            format={(v) => formatMoney(v, c.currency)}
            formatAxis={(v) => formatCurrency(v / 100, c.currency, { notation: "compact", maximumFractionDigits: 1 })}
          />
        </div>
      ) : (
        <EmptyState compact icon={<CircleDollarSign />} title="No paid invoices in the last 12 months" description={`Nothing in ${c.currency} has been paid through the payment provider in this period.`} />
      )}
    </Panel>
  );
}

function Plans({ c }: { c: PlatformRevenueCurrency }) {
  return (
    <Panel title="By plan" description="Paying and trialing subscriptions on each plan today.">
      {c.plans.length ? (
        <div className={table.wrap}>
          <table className={table.table}>
            <thead>
              <tr>
                <th className={table.th}>Plan</th>
                <th className={cn(table.th, "text-right")}>Paying</th>
                <th className={cn(table.th, "text-right")}>Trialing</th>
                <th className={cn(table.th, "text-right")}>MRR</th>
                <th className={cn(table.th, "text-right")}>Share</th>
              </tr>
            </thead>
            <tbody>
              {c.plans.map((p) => (
                <tr key={p.planId}>
                  <td className={table.td}>
                    <span className="font-medium text-text-hi">{p.name}</span>
                    {p.estimated && <span className="ml-1.5 text-2xs text-warn-ink">list price</span>}
                  </td>
                  <td className={cn(table.td, "text-right tabular-nums")}>{formatNumber(p.subscribers)}</td>
                  <td className={cn(table.td, "text-right tabular-nums")}>{formatNumber(p.trialing)}</td>
                  <td className={cn(table.td, "text-right font-medium tabular-nums")}>{formatMoney(p.mrrCents, c.currency)}</td>
                  <td className={cn(table.td, "text-right text-text-3 tabular-nums")}>{c.mrrCents ? formatPercent(p.mrrCents / c.mrrCents, 0) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyState compact icon={<Repeat />} title="No subscribers" description={`No paying or trialing subscriptions in ${c.currency}.`} />
      )}
    </Panel>
  );
}

function TopAccounts({ c }: { c: PlatformRevenueCurrency }) {
  return (
    <Panel title="Top accounts" description="Highest MRR today, at most 10.">
      {c.topAccounts.length ? (
        <div className={table.wrap}>
          <table className={table.table}>
            <thead>
              <tr>
                <th className={table.th}>Account</th>
                <th className={table.th}>Plan</th>
                <th className={table.th}>Billed via</th>
                <th className={cn(table.th, "text-right")}>MRR</th>
              </tr>
            </thead>
            <tbody>
              {c.topAccounts.map((a) => (
                <tr key={a.billingAccountId}>
                  <td className={cn(table.td, "max-w-56")}>
                    <Link href={`/billing/${a.billingAccountId}`} className="block truncate font-medium text-text-hi hover:underline">
                      {a.name || "Unnamed account"}
                    </Link>
                    {a.status !== "active" && <StatusBadge value={a.status} label={labelOf(a.status)} className="mt-0.5" />}
                  </td>
                  <td className={cn(table.td, "whitespace-nowrap")}>
                    {a.plan.name}
                    <span className="ml-1 text-xs text-text-3">{a.interval === "year" ? "annual" : "monthly"}</span>
                  </td>
                  <td className={cn(table.td, "whitespace-nowrap text-text-2")}>{providerLabel(a.provider)}</td>
                  <td className={cn(table.td, "text-right whitespace-nowrap")}>
                    <span className="font-medium tabular-nums">{formatMoney(a.mrrCents, c.currency)}</span>
                    {a.estimated && <div className="text-2xs text-warn-ink">list price</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyState compact icon={<Users />} title="No paying accounts" description={`Nobody pays in ${c.currency} today.`} />
      )}
    </Panel>
  );
}

function LoadingBody() {
  return (
    <div className="flex flex-col gap-5">
      <Kpis c={undefined} loading />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Skeleton className="h-72 rounded-xl lg:col-span-2" />
        <Skeleton className="h-72 rounded-xl" />
      </div>
    </div>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────

export function Revenue() {
  const { role, canChange } = usePlatform();
  const f = useFormat();
  const params = useSearchParams();
  const setParams = useSetParams();
  const range = useRange();
  const q = useApiQuery<PlatformRevenueReport>(platformKey("revenue"), canChange && !range.error ? "/admin/revenue" : null, {
    query: { from: range.from, to: range.to },
    keepPrevious: true,
  });
  const report = q.data;
  const currencies = report?.currencies ?? [];
  const wanted = params.get("currency");
  const c = currencies.find((x) => x.currency === wanted) ?? currencies[0];

  const tracking: string = report?.trackingSince
    ? report.effectiveFrom
      ? `Since tracking began ${f.date(report.trackingSince)}${report.effectiveFrom !== report.trackingSince ? `, covering ${f.date(report.effectiveFrom)} – ${utcDay(report.range.to)}` : ""}.`
      : `Since tracking began ${f.date(report.trackingSince)}: after this range, so nothing here is covered.`
    : "Tracking begins with the first subscription change; nothing has been recorded yet.";

  const header = (
    <PageHeader
      icon={<IconTile icon={<TrendingUp />} tint="green" size="lg" />}
      title="Revenue & MRR"
      description="Recurring revenue from subscriptions, per currency: no exchange rates are applied."
      actions={
        canChange ? (
          <>
            {currencies.length > 1 && (
              <NativeSelect
                aria-label="Currency"
                value={c?.currency ?? ""}
                onChange={(e) => setParams({ currency: e.target.value })}
                options={currencies.map((x) => ({ value: x.currency, label: x.currency }))}
                className="w-24"
              />
            )}
            <RangePicker
              value={range.preset}
              onChange={(v) => setParams(v === "custom" ? { range: v, from: range.from, to: range.to } : { range: v === "30" ? null : v, from: null, to: null })}
            />
            <Button size="sm" icon={<RefreshCw />} loading={q.isFetching && !q.isPending} onClick={() => void q.refetch()} aria-label="Refresh">
              <span className="max-sm:sr-only">Refresh</span>
            </Button>
          </>
        ) : undefined
      }
    />
  );

  if (!canChange) {
    return (
      <Page width="capped">
        {header}
        <Card>
          <EmptyState
            icon={<Lock />}
            tint="gray"
            title="Revenue is for platform admins"
            description={`Your platform role is ${PLATFORM_ROLE_LABELS[role]}. MRR, invoices and what each account pays are visible to the Admin and Owner roles; ask a platform owner if you need access.`}
          />
        </Card>
      </Page>
    );
  }

  return (
    <Page width="capped">
      {header}
      {range.preset === "custom" && (
        <div className="mb-5 flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-xs text-text-3">
            From (UTC)
            <Input type="date" value={range.from} max={range.to} onChange={(e) => setParams({ from: e.target.value })} className="w-40" invalid={Boolean(range.error)} />
          </label>
          <label className="flex flex-col gap-1 text-xs text-text-3">
            To (UTC)
            <Input type="date" value={range.to} min={range.from} onChange={(e) => setParams({ to: e.target.value })} className="w-40" invalid={Boolean(range.error)} />
          </label>
          {range.error && (
            <p role="alert" className="pb-1.5 text-xs text-bad-ink">
              {range.error}
            </p>
          )}
        </div>
      )}

      {q.isError && !report ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : !report ? (
        range.error ? null : <LoadingBody />
      ) : !c ? (
        <Card>
          <EmptyState
            icon={<TrendingUp />}
            tint="green"
            title="No revenue yet"
            description="There are no paying or trialing subscriptions, paid invoices or snapshots. Figures appear here as customers subscribe."
          />
        </Card>
      ) : (
        <div className={cn("flex flex-col gap-5", q.isPlaceholderData && "opacity-60 transition-opacity")}>
          {c.estimated && (
            <Callout tone="warn" title="MRR is partly estimated">
              {formatNumber(c.unpricedCount)} paying subscription{c.unpricedCount === 1 ? " has" : "s have"} no price from a payment provider (manual plans, no provider, or a Stripe price not read yet), so the plan&apos;s list price is used. Stripe prices are read on every webhook and by the daily reconcile.
            </Callout>
          )}

          <Kpis c={c} loading={false} />

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            <MrrTrend c={c} report={report} />
            <Sources c={c} />
          </div>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            <Movement c={c} tracking={`${utcDay(report.range.from)} – ${utcDay(report.range.to)}. ${tracking}`} />
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-1">
              <RateCard
                title="Trial conversion"
                rate={c.trialConversion.rate}
                tone="ok"
                detail={
                  c.trialConversion.started
                    ? `${formatNumber(c.trialConversion.converted)} of ${formatNumber(c.trialConversion.started)} trials started in this range became active`
                    : "No trials started in this range"
                }
                tracking={tracking}
              />
              <RateCard
                title="Logo churn"
                rate={c.logoChurn.rate}
                tone="bad"
                detail={
                  !report.effectiveFrom
                    ? "Not measurable for this range: no subscription changes were tracked in it"
                    : c.logoChurn.payingAtStart
                    ? `${formatNumber(c.logoChurn.churned)} of ${formatNumber(c.logoChurn.payingAtStart)} accounts paying at the start stopped paying`
                    : c.logoChurn.churned
                      ? `${formatNumber(c.logoChurn.churned)} stopped paying; no paying accounts at the start to compare with`
                      : "No paying accounts at the start of this range"
                }
                tracking={tracking}
              />
            </div>
          </div>

          <Collected c={c} />

          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            <Plans c={c} />
            <TopAccounts c={c} />
          </div>

          <p className="text-2xs text-text-3">
            Generated {f.dateTime(report.generatedAt)} · range {utcDay(report.range.from)} – {utcDay(report.range.to)} ({formatNumber(report.range.days)} days, UTC)
            {currencies.length > 1 && ` · ${currencies.length} currencies, shown one at a time`}
          </p>
        </div>
      )}
    </Page>
  );
}
