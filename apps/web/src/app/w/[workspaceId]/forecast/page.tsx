"use client";

import { CalendarRange, CircleUserRound, Handshake, TrendingUp, UserRound, Users, UsersRound } from "lucide-react";
import { FORECAST_PERIOD_PRESETS, localDay, periodStartOf, presetPeriod, type ForecastPeriodPreset, type PeriodType } from "@growthdesk/shared";
import { DealsByCategory, OwnerTable, TeamTable } from "@/components/forecast/ForecastTables";
import { ForecastBar, ForecastLegend, ForecastRamp } from "@/components/forecast/ForecastBar";
import { TargetEditor, targetInputId } from "@/components/forecast/TargetEditor";
import { useSearchState } from "@/components/pipeline/controls";
import { useMembers } from "@/components/pickers/Pickers";
import { Callout } from "@/components/ui/Callout";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { QueryState } from "@/components/ui/ErrorState";
import { IconTile } from "@/components/ui/IconTile";
import { NativeSelect } from "@/components/ui/Input";
import { Page, PageHeader } from "@/components/ui/PageHeader";
import { RequirePermission } from "@/components/ui/RequirePermission";
import { Skeleton } from "@/components/ui/Skeleton";
import { StatCard } from "@/components/ui/StatCard";
import { formatCurrency, formatNumber, formatPercent } from "@/lib/format";
import { useApiQuery } from "@/lib/query";
import { useWorkspace } from "@/lib/session";
import type { ForecastResponse } from "@/lib/types/forecast";

/*
 * Forecast: one month or quarter in the workspace's time zone. Won deals
 * count by when they closed; open deals by their expected close date, split
 * by the owner's forecast category; weighted pipeline is value × stage
 * probability. Money is in the workspace currency only (other currencies are
 * listed, never converted). The definitions live in packages/shared/src/forecast.ts.
 */

export default function ForecastPage() {
  return (
    <Page width="full">
      <RequirePermission permission="deals.read">
        <Forecast />
      </RequirePermission>
    </Page>
  );
}

function Forecast() {
  const ws = useWorkspace();
  const search = useSearchState();
  const members = useMembers();
  const today = localDay(new Date(), ws.timezone);
  const preset = (FORECAST_PERIOD_PRESETS.some((p) => p.key === search.get("period")) ? search.get("period") : "this_month") as ForecastPeriodPreset;
  const { periodType, periodStart } = presetPeriod(preset, today);
  const ownerId = search.get("owner");
  const teamId = search.get("team");
  const canTargets = ws.can("targets.manage");
  const teams = useApiQuery<{ teams: { id: string; name: string }[] }>(ws.key("teams"), ws.can("members.read") ? ws.path("/teams") : null);
  const focusTarget = (owner: { userId?: string | null; teamId?: string | null }) => {
    const el = document.getElementById(targetInputId(owner));
    el?.scrollIntoView({ behavior: "smooth", block: "center" });
    el?.focus({ preventScroll: true });
  };

  const query = useApiQuery<ForecastResponse>(ws.key("forecast", "summary"), ws.path("/forecast"), { query: { periodType, periodStart, ...(ownerId ? { ownerId } : {}), ...(teamId ? { teamId } : {}) }, keepPrevious: true });
  const data = query.data;
  const teamView = data?.scope !== "own";

  return (
    <ForecastRamp>
      <PageHeader
        title="Forecast"
        icon={<IconTile icon={<TrendingUp />} tint="green" size="lg" />}
        description={data ? `${data.period.label} · ${data.scope === "own" ? "your deals" : ownerId ? "one rep" : data.team ? data.team.name : "the whole workspace"} · amounts in ${data.currency}` : "What the team will close, against its targets."}
        actions={
          <>
            <NativeSelect
              aria-label="Period"
              icon={<CalendarRange />}
              className="w-auto min-w-40"
              value={preset}
              onChange={(e) => search.set({ period: e.target.value === "this_month" ? null : e.target.value })}
              options={FORECAST_PERIOD_PRESETS.map((p) => ({ value: p.key, label: p.label }))}
            />
            {teamView && (teams.data?.teams.length ?? 0) > 0 && (
              <NativeSelect
                aria-label="Team"
                icon={<UsersRound />}
                className="w-auto min-w-36"
                value={teamId}
                onChange={(e) => search.set({ team: e.target.value || null })}
                options={[{ value: "", label: "All teams" }, ...(teams.data?.teams ?? []).map((t) => ({ value: t.id, label: t.name }))]}
              />
            )}
            {teamView && (
              <NativeSelect
                aria-label="Owner"
                icon={<CircleUserRound />}
                className="w-auto min-w-36"
                value={ownerId}
                onChange={(e) => search.set({ owner: e.target.value || null })}
                options={[
                  { value: "", label: "Everyone" },
                  { value: "me", label: "Me" },
                  ...(members.data?.members ?? []).map((m) => ({ value: m.userId, label: m.name || m.email })),
                ]}
              />
            )}
          </>
        }
      />

      <QueryState query={query} loading={<ForecastSkeleton />}>
        {(f) => (
          <div className="flex flex-col gap-5">
            {f.scope === "own" && <Callout>These are your deals, unowned deals and your team&apos;s, against your own targets. The whole team&apos;s forecast needs “View team performance” or “See records owned by other people”.</Callout>}
            {f.otherCurrencies.length > 0 && (
              <Callout tone="warn" title="Some deals are in other currencies">
                Amounts here are {f.currency} only — nothing is converted.{" "}
                {f.otherCurrencies.map((o) => `${o.currency}: ${formatCurrency(o.won, o.currency)} won, ${formatCurrency(o.open, o.currency)} open (${formatNumber(o.deals)} deal${o.deals === 1 ? "" : "s"})`).join(" · ")}
              </Callout>
            )}
            {f.ignoredTargets > 0 && (
              <Callout tone="warn">
                {formatNumber(f.ignoredTargets)} revenue target{f.ignoredTargets === 1 ? " is" : "s are"} in another currency and {f.ignoredTargets === 1 ? "is" : "are"} left out. Set targets in {f.currency}.
              </Callout>
            )}

            <Summary f={f} />

            {f.teams.length > 0 && (
              <Card>
                <CardHeader icon={<UsersRound />} title="By team" description="Each team's members added up, against the team's target (or its members' targets added up)." actions={<ForecastLegend />} />
                <TeamTable teams={f.teams} owners={f.owners} currency={f.currency} onEditTarget={canTargets ? (t) => focusTarget({ teamId: t.team.id }) : undefined} />
              </Card>
            )}

            <Card>
              <CardHeader icon={<UserRound />} title="By rep" description="Won, commit and best case against each person's target." actions={<ForecastLegend />} />
              {f.owners.length ? (
                <OwnerTable
                  rows={f.owners}
                  currency={f.currency}
                  onEditTarget={canTargets ? (r) => focusTarget({ userId: r.ownerId }) : undefined}
                />
              ) : (
                <EmptyState compact icon={<Users />} title="Nothing in this period yet" description="Deals expected to close in it, deals won in it and targets set for it show here." />
              )}
            </Card>

            <Card>
              <CardHeader
                icon={<Handshake />}
                title={`Deals in ${f.period.label}`}
                description="Won in the period, or open and expected to close in it. Change a deal's category here or on the deal."
              />
              {f.deals.length ? (
                <DealsByCategory deals={f.deals} currency={f.currency} />
              ) : (
                <EmptyState compact icon={<Handshake />} title="No deals in this period" description="Give open deals an expected close date to see them here." />
              )}
            </Card>

            {canTargets && <TargetEditor periodType={periodType as PeriodType} periodStart={periodStartOf(periodType, periodStart)} label={f.period.label} currency={f.currency} />}
          </div>
        )}
      </QueryState>
    </ForecastRamp>
  );
}

function Summary({ f }: { f: ForecastResponse }) {
  const t = f.total;
  const money = (v: number | null) => (v === null ? "—" : formatCurrency(v, f.currency, { notation: v >= 100_000 ? "compact" : "standard", maximumFractionDigits: v >= 100_000 ? 1 : 0 }));
  const beaten = t.gap !== null && t.gap <= 0;
  return (
    <>
      <Card>
        <CardBody className="flex flex-col gap-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <div>
              <div className="text-xs font-medium text-text-3">Attainment</div>
              <div className="text-[34px] leading-tight font-semibold tracking-[-0.025em] text-text-hi">{t.attainment === null ? "No target" : formatPercent(t.attainment, 0)}</div>
            </div>
            <div className="text-right text-sm text-text-2">
              <span className="font-medium text-text-hi">{formatCurrency(t.won, f.currency)}</span> won
              {t.target !== null && <> of {formatCurrency(t.target, f.currency)}</>}
              <div className="text-xs text-text-3">
                With commit {formatCurrency(t.projected, f.currency)} · with best case {formatCurrency(t.upside, f.currency)}
              </div>
            </div>
          </div>
          <ForecastBar figures={t} currency={f.currency} />
          <ForecastLegend />
        </CardBody>
      </Card>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <StatCard label="Target" value={money(t.target)} hint={t.target === null ? "None set for this period" : undefined} />
        <StatCard label="Won" value={money(t.won)} hint={`${formatNumber(t.dealsWon)} deal${t.dealsWon === 1 ? "" : "s"}${t.dealsWonTarget !== null ? ` of ${formatNumber(t.dealsWonTarget)}` : ""}`} />
        <StatCard label="Commit" value={money(t.commit)} hint="Open, expected to land" />
        <StatCard label="Best case" value={money(t.bestCase)} hint="Open, could land" />
        <StatCard label="Weighted pipeline" value={money(t.weighted)} hint={`${formatNumber(t.openDeals)} open deal${t.openDeals === 1 ? "" : "s"} × stage probability`} />
        <StatCard
          label={beaten ? "Ahead of target" : "Gap to target"}
          value={t.gap === null ? "—" : money(Math.abs(t.gap))}
          tone={beaten ? "ok" : undefined}
          hint={t.coverage !== null ? `Open pipeline covers ${formatNumber(t.coverage, { maximumFractionDigits: 1 })}×` : `${formatNumber(t.meetingsBooked)} meeting${t.meetingsBooked === 1 ? "" : "s"} booked`}
        />
      </div>
    </>
  );
}

function ForecastSkeleton() {
  return (
    <div className="flex flex-col gap-5" aria-hidden>
      <Skeleton className="h-36 w-full rounded-xl" />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="h-24 rounded-xl" />
        ))}
      </div>
      <Skeleton className="h-64 w-full rounded-xl" />
    </div>
  );
}
