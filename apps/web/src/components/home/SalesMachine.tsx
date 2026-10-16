"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";
import {
  ArrowDownRight,
  ArrowUpRight,
  BarChart3,
  CalendarCheck,
  ChevronRight,
  Filter,
  Handshake,
  Megaphone,
  MessageSquareReply,
  Rocket,
  Send,
  Trophy,
} from "lucide-react";
import { addLocalDays, localDay, presetRange } from "@growthdesk/shared";
import { DailyChart } from "@/components/analytics/DailyChart";
import { Funnel } from "@/components/analytics/Funnel";
import { Segmented } from "@/components/pipeline/controls";
import { StatusBadge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, CardHeader } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { IconBadge, type Tint } from "@/components/ui/IconTile";
import { Skeleton } from "@/components/ui/Skeleton";
import { cn } from "@/lib/cn";
import { formatNumber, formatPercent } from "@/lib/format";
import { useApiQuery } from "@/lib/query";
import { useFormat, useWorkspace } from "@/lib/session";
import type {
  AnalyticsCampaigns,
  AnalyticsOverview,
  AnalyticsPipeline,
  SeriesPoint,
} from "@/lib/types/analytics";

/*
 * The analytics half of Home: the last 30 days as a sales machine, from
 * messages out to revenue in. KPI tiles with a trend line and the change from
 * the 30 days before, the engine (each step of the funnel with its rate from
 * the step before), daily activity, the pipeline funnel and the campaigns
 * doing the work. Same requests (and cache entries) as Reports' 30-day view.
 */

function useRanges() {
  const ws = useWorkspace();
  const current = presetRange("30d", localDay(new Date(), ws.timezone));
  const previous = {
    from: addLocalDays(current.from, -30),
    to: addLocalDays(current.from, -1),
  };
  return { current, previous };
}

export function useOverview() {
  const ws = useWorkspace();
  const { current, previous } = useRanges();
  const now = useApiQuery<AnalyticsOverview>(
    ws.key("analytics", "overview"),
    ws.path("/analytics/overview"),
    { query: current },
  );
  const before = useApiQuery<AnalyticsOverview>(
    ws.key("analytics", "overview"),
    ws.path("/analytics/overview"),
    { query: previous },
  );
  return { now, before };
}

/* ---------- KPI tiles ---------- */

/** A trend line for a tile: one series, no axes; decorative (the number above carries the value). */
function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2) return <div className="h-9" />;
  const max = Math.max(...values, 1);
  const step = 100 / (values.length - 1);
  const pts = values.map(
    (v, i) => `${(i * step).toFixed(2)},${(30 - (v / max) * 26).toFixed(2)}`,
  );
  return (
    <svg
      aria-hidden
      viewBox="0 0 100 32"
      preserveAspectRatio="none"
      className="h-9 w-full overflow-visible"
    >
      <polygon
        points={`0,32 ${pts.join(" ")} 100,32`}
        fill="var(--accent)"
        opacity={0.1}
      />
      <polyline
        points={pts.join(" ")}
        fill="none"
        stroke="var(--accent)"
        strokeWidth={2}
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

/** Change from the 30 days before, as an arrow and a percentage (nothing when there is no base). */
function Delta({
  now,
  before,
}: {
  now: number | undefined;
  before: number | undefined;
}) {
  if (now === undefined || before === undefined || before === 0)
    return <span className="text-xs text-text-3">Last 30 days</span>;
  const change = (now - before) / before;
  if (Math.abs(change) < 0.005)
    return (
      <span className="text-xs text-text-3">Same as the 30 days before</span>
    );
  const up = change > 0;
  const Icon = up ? ArrowUpRight : ArrowDownRight;
  return (
    <span className="inline-flex items-center gap-1 text-xs text-text-3">
      <span
        className={cn(
          "inline-flex items-center font-medium",
          up ? "text-ok-ink" : "text-bad-ink",
        )}
      >
        <Icon aria-hidden className="size-3.5" strokeWidth={2.25} />
        {formatPercent(Math.abs(change), 0)}
      </span>
      vs the 30 days before
    </span>
  );
}

function KpiTile({
  label,
  icon,
  tint,
  value,
  hint,
  series,
  now,
  before,
  href,
  loading,
}: {
  label: string;
  icon: ReactNode;
  tint: Tint;
  value: ReactNode;
  hint?: ReactNode;
  series: number[];
  now?: number;
  before?: number;
  href: string;
  loading: boolean;
}) {
  return (
    <Link
      href={href}
      className="group flex min-w-0 flex-col rounded-xl border border-line bg-panel px-4 pt-3.5 pb-2 shadow-card transition-[border-color,box-shadow] hover:border-line-strong hover:shadow-md"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-text-3">{label}</span>
        <IconBadge icon={icon} tint={tint} className="-my-1" />
      </div>
      {loading ? (
        <Skeleton className="mt-2 h-7 w-24" />
      ) : (
        <div className="mt-1.5 flex items-baseline gap-2">
          <span className="text-2xl font-semibold tracking-[-0.025em] text-text-hi tabular-nums">
            {value}
          </span>
          {hint && <span className="truncate text-xs text-text-3">{hint}</span>}
        </div>
      )}
      <div className="mt-0.5 h-4">
        {!loading && <Delta now={now} before={before} />}
      </div>
      <div className="mt-2 -mx-1">
        {loading ? <div className="h-9" /> : <Sparkline values={series} />}
      </div>
    </Link>
  );
}

export function KpiTiles() {
  const ws = useWorkspace();
  const f = useFormat();
  const { now, before } = useOverview();
  const o = now.data;
  const b = before.data;
  const s = (k: keyof SeriesPoint) =>
    (o?.series ?? []).map((p) => Number(p[k]) || 0);
  const loading = now.isPending;
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <KpiTile
        label="Messages sent"
        icon={<Send />}
        tint="blue"
        value={formatNumber(o?.outreach.sent)}
        series={s("sent")}
        now={o?.outreach.sent}
        before={b?.outreach.sent}
        href={ws.href("/reports")}
        loading={loading}
      />
      <KpiTile
        label="Replies"
        icon={<MessageSquareReply />}
        tint="cyan"
        value={formatNumber(o?.outreach.replies)}
        hint={
          o?.outreach.replyRate != null
            ? `${formatPercent(o.outreach.replyRate)} reply rate`
            : undefined
        }
        series={s("replies")}
        now={o?.outreach.replies}
        before={b?.outreach.replies}
        href={ws.href(ws.can("inbox.read") ? "/inbox" : "/reports")}
        loading={loading}
      />
      <KpiTile
        label="Meetings booked"
        icon={<CalendarCheck />}
        tint="purple"
        value={formatNumber(o?.activity.meetingsBooked)}
        hint={o ? `${formatNumber(o.activity.meetingsHeld)} held` : undefined}
        series={s("meetingsBooked")}
        now={o?.activity.meetingsBooked}
        before={b?.activity.meetingsBooked}
        href={ws.href("/meetings")}
        loading={loading}
      />
      <KpiTile
        label="Revenue won"
        icon={<Trophy />}
        tint="green"
        value={o ? f.money(o.pipeline.valueWon, o.range.currency) : "—"}
        hint={
          o
            ? `${formatNumber(o.pipeline.won)} ${o.pipeline.won === 1 ? "deal" : "deals"}`
            : undefined
        }
        series={s("valueWon")}
        now={o?.pipeline.valueWon}
        before={b?.pipeline.valueWon}
        href={ws.href("/deals")}
        loading={loading}
      />
    </div>
  );
}

/* ---------- The engine ---------- */

type EngineStep = {
  key: string;
  label: string;
  icon: ReactNode;
  tint: Tint;
  value: number;
  href: string;
};

/**
 * Each stage of the machine in order, with how big it is against the first
 * stage (the bar) and against the stage before (the rate). The stages are
 * counted over the same 30 days, not as one cohort, so a rate is a ratio of
 * volumes rather than a strict conversion.
 */
export function RevenueEngine() {
  const ws = useWorkspace();
  const { now } = useOverview();
  const o = now.data;
  const steps: EngineStep[] = o
    ? [
        {
          key: "contacted",
          label: "Reached",
          icon: <Send />,
          tint: "blue",
          value: o.outreach.contacted,
          href: "/campaigns",
        },
        {
          key: "replied",
          label: "Replied",
          icon: <MessageSquareReply />,
          tint: "cyan",
          value: o.outreach.replied,
          href: ws.can("inbox.read") ? "/inbox" : "/reports",
        },
        {
          key: "meetings",
          label: "Meetings",
          icon: <CalendarCheck />,
          tint: "purple",
          value: o.activity.meetingsBooked,
          href: "/meetings",
        },
        {
          key: "deals",
          label: "Deals opened",
          icon: <Handshake />,
          tint: "orange",
          value: o.pipeline.created,
          href: "/deals",
        },
        {
          key: "won",
          label: "Won",
          icon: <Trophy />,
          tint: "green",
          value: o.pipeline.won,
          href: "/deals",
        },
      ]
    : [];
  const base = steps[0]?.value ?? 0;
  return (
    <Card>
      <CardHeader
        icon={<Rocket />}
        title="Revenue engine"
        description="The last 30 days, from first message to closed-won. Each rate compares a stage with the one before it."
        actions={
          <Button
            size="sm"
            variant="ghost"
            icon={<BarChart3 />}
            href={ws.href("/reports")}
          >
            Reports
          </Button>
        }
      />
      {now.isError ? (
        <p className="px-4 pb-4 text-sm text-text-3">
          Could not load: {now.error.message}
        </p>
      ) : (
        <ol className="grid grid-cols-2 gap-px overflow-hidden rounded-b-xl border-t border-line bg-line sm:grid-cols-3 lg:grid-cols-5">
          {!o &&
            Array.from({ length: 5 }, (_, i) => (
              <li key={i} className="flex flex-col gap-2 bg-panel px-4 py-3.5">
                <Skeleton className="h-7 w-24" />
                <Skeleton className="h-6 w-14" />
                <Skeleton className="h-1" />
              </li>
            ))}
          {steps.map((st, i) => {
            const prev = i > 0 ? steps[i - 1]?.value : undefined;
            const rate = prev ? st.value / prev : null;
            return (
              <li key={st.key} className="bg-panel">
                <Link
                  href={ws.href(st.href)}
                  className="flex h-full flex-col gap-2 px-4 py-3.5 hover:bg-hover"
                >
                  <span className="flex items-center gap-2">
                    <IconBadge icon={st.icon} tint={st.tint} />
                    <span className="text-xs font-medium text-text-3">
                      {st.label}
                    </span>
                    {i > 0 && (
                      <span
                        className="ml-auto inline-flex items-center gap-0.5 text-2xs text-text-3 tabular-nums"
                        title={`${st.label} ÷ ${steps[i - 1]?.label.toLowerCase()}`}
                      >
                        <ChevronRight aria-hidden className="size-3" />
                        {rate === null ? "—" : formatPercent(rate, 0)}
                      </span>
                    )}
                  </span>
                  <span className="text-xl font-semibold tracking-[-0.02em] text-text-hi tabular-nums">
                    {formatNumber(st.value)}
                  </span>
                  <span
                    aria-hidden
                    className="h-1 overflow-hidden rounded-full bg-s-3"
                  >
                    <span
                      className="block h-full rounded-full"
                      style={{
                        width:
                          st.value && base
                            ? `max(4px, ${Math.min(100, (st.value / base) * 100).toFixed(1)}%)`
                            : 0,
                        background: `var(--tint-${st.tint})`,
                      }}
                    />
                  </span>
                </Link>
              </li>
            );
          })}
        </ol>
      )}
    </Card>
  );
}

/* ---------- Activity, pipeline, campaigns ---------- */

const ACTIVITY = [
  { value: "sent", label: "Sent", title: "Messages sent per day" },
  { value: "replies", label: "Replies", title: "Replies per day" },
  {
    value: "meetingsBooked",
    label: "Meetings",
    title: "Meetings booked per day",
  },
] as const;
type ActivityKey = (typeof ACTIVITY)[number]["value"];

export function ActivityCard() {
  const ws = useWorkspace();
  const { now } = useOverview();
  const [metric, setMetric] = useState<ActivityKey>("sent");
  const m = ACTIVITY.find((a) => a.value === metric)!;
  return (
    <Card className="flex h-full flex-col">
      <CardHeader
        icon={<BarChart3 />}
        title="Daily activity"
        actions={
          <Segmented
            aria-label="Measure"
            value={metric}
            onChange={setMetric}
            options={ACTIVITY.map(({ value, label }) => ({ value, label }))}
          />
        }
      />
      <div className="px-4 pb-4">
        {now.data ? (
          <DailyChart
            points={now.data.series.map((p) => ({
              date: p.date,
              value: p[metric],
            }))}
            label={m.title}
            format={(v) => formatNumber(v)}
          />
        ) : (
          <Skeleton className="h-[220px]" />
        )}
      </div>
      <div className="mt-auto border-t border-line px-4 py-2 text-right">
        <Link
          href={ws.href("/reports")}
          className="inline-flex items-center gap-0.5 text-xs font-medium text-accent-ink hover:text-accent-hi"
        >
          Full report
          <ChevronRight aria-hidden className="size-3.5" />
        </Link>
      </div>
    </Card>
  );
}

export function PipelineCard() {
  const ws = useWorkspace();
  const { current } = useRanges();
  const q = useApiQuery<AnalyticsPipeline>(
    ws.key("analytics", "pipeline"),
    ws.path("/analytics/pipeline"),
    { query: { ...current, pipelineId: undefined } },
  );
  const d = q.data;
  return (
    <Card className="flex flex-col">
      <CardHeader
        icon={<Filter />}
        title="Pipeline"
        description={
          d
            ? `${formatNumber(d.cohort)} deals opened in 30 days · ${formatNumber(d.open)} still open`
            : undefined
        }
        actions={
          <Button
            size="sm"
            variant="ghost"
            iconRight={<ChevronRight />}
            href={ws.href("/deals")}
          >
            Deals
          </Button>
        }
      />
      <div className="px-4 pb-4">
        {q.isPending ? (
          <div className="flex flex-col gap-2">
            {Array.from({ length: 5 }, (_, i) => (
              <Skeleton key={i} className="h-5" />
            ))}
          </div>
        ) : !d || d.cohort === 0 ? (
          <EmptyState
            compact
            icon={<Handshake />}
            title="No new deals yet"
            description="Deals opened in the last 30 days show here, stage by stage."
            className="py-6"
          />
        ) : (
          <Funnel stages={d.stages} cohort={d.cohort} compact />
        )}
      </div>
    </Card>
  );
}

export function TopCampaigns() {
  const ws = useWorkspace();
  const { current } = useRanges();
  const q = useApiQuery<AnalyticsCampaigns>(
    ws.key("analytics", "campaigns"),
    ws.path("/analytics/campaigns"),
    { query: current },
  );
  const rows = (q.data?.campaigns ?? [])
    .filter((c) => !c.deleted && c.sent > 0)
    .sort((a, b) => b.sent - a.sent)
    .slice(0, 5);
  const top = Math.max(...rows.map((r) => r.sent), 1);
  return (
    <Card className="flex flex-col">
      <CardHeader
        icon={<Megaphone />}
        title="Top campaigns"
        description="By messages sent in the last 30 days"
        actions={
          <Button
            size="sm"
            variant="ghost"
            iconRight={<ChevronRight />}
            href={ws.href("/campaigns")}
          >
            Campaigns
          </Button>
        }
      />
      {q.isPending ? (
        <div className="flex flex-col gap-2 px-4 pb-4">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-9" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <EmptyState
          compact
          icon={<Megaphone />}
          title="Nothing sent yet"
          description="Launch a campaign and its sends, replies and deals show here."
          className="py-6"
          action={
            ws.can("campaigns.write") ? (
              <Button
                size="sm"
                variant="primary"
                icon={<Rocket />}
                href={ws.href("/campaigns")}
              >
                Launch a campaign
              </Button>
            ) : undefined
          }
        />
      ) : (
        <ul className="divide-y divide-line border-t border-line">
          {rows.map((c) => (
            <li key={c.id}>
              <Link
                href={ws.href(`/campaigns/${c.id}`)}
                className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1.5 px-4 py-2.5 hover:bg-hover"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <span className="truncate text-sm font-medium text-text">
                    {c.name}
                  </span>
                  <StatusBadge value={c.status} />
                </span>
                <span className="text-xs text-text-3 tabular-nums">
                  <span className="font-medium text-text-2">
                    {formatNumber(c.sent)}
                  </span>{" "}
                  sent ·{" "}
                  {c.replyRate === null ? "—" : formatPercent(c.replyRate)}{" "}
                  replied
                  {c.deals > 0 &&
                    ` · ${formatNumber(c.deals)} ${c.deals === 1 ? "deal" : "deals"}`}
                </span>
                <span
                  aria-hidden
                  className="col-span-2 h-1 overflow-hidden rounded-full bg-s-3"
                >
                  <span
                    className="block h-full rounded-full bg-accent"
                    style={{ width: `${((c.sent / top) * 100).toFixed(1)}%` }}
                  />
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
