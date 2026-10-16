"use client";

import Link from "next/link";
import { Suspense, useState, type ReactNode } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  Activity,
  Banknote,
  BarChart3,
  CalendarCheck,
  CheckCheck,
  CheckSquare,
  Eye,
  Funnel as FunnelIcon,
  Handshake,
  ListOrdered,
  MailX,
  MessageSquareReply,
  MessagesSquare,
  MousePointerClick,
  Percent,
  Phone,
  Send,
  SquareKanban,
  Table2,
  Timer,
  TrendingUp,
  Trophy,
  UserMinus,
  Users,
  type LucideIcon,
} from "lucide-react";
import { isLocalDateString, labelOf, localDay, presetRange } from "@growthdesk/shared";
import { DailyChart, dayLabel } from "@/components/analytics/DailyChart";
import { Funnel } from "@/components/analytics/Funnel";
import { RangePicker, type DayRange } from "@/components/analytics/RangePicker";
import { Segmented } from "@/components/pipeline/controls";
import { StatusBadge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { COL, ColumnLabel } from "@/components/ui/columns";
import { EmptyState } from "@/components/ui/EmptyState";
import { QueryState } from "@/components/ui/ErrorState";
import { Page, PageHeader, Section } from "@/components/ui/PageHeader";
import { RequirePermission } from "@/components/ui/RequirePermission";
import { Select } from "@/components/ui/Select";
import { LoadingBlock, Skeleton, SkeletonText } from "@/components/ui/Skeleton";
import { StatCard } from "@/components/ui/StatCard";
import { UpgradePrompt } from "@/components/ui/UpgradePrompt";
import { EntityTile } from "@/components/ui/icons";
import { cn } from "@/lib/cn";
import { formatNumber, formatPercent } from "@/lib/format";
import { useApiQuery } from "@/lib/query";
import { useFormat, useWorkspace } from "@/lib/session";
import type { AnalyticsCampaigns, AnalyticsOverview, AnalyticsPipeline, AnalyticsTeam, SeriesPoint } from "@/lib/types/analytics";

/*
 * Reports: outreach, pipeline and activity for a range of days in the
 * workspace's time zone. Every figure is counted by the API from the records
 * themselves (src/analytics); the definitions in the hints below are the ones
 * the API uses. The range lives in the URL (?from=&to=) so a report can be
 * shared as a link.
 */

export default function ReportsPage() {
  return (
    <Page width="capped">
      <RequirePermission permission="analytics.read">
        <Suspense fallback={<LoadingBlock />}>
          <Reports />
        </Suspense>
      </RequirePermission>
    </Page>
  );
}

const pct = (r: number | null) => formatPercent(r, 1);

function useRange(today: string): [DayRange, (r: DayRange) => void] {
  const sp = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const from = sp.get("from");
  const to = sp.get("to");
  const range = from && to && isLocalDateString(from) && isLocalDateString(to) && from <= to ? { from, to } : presetRange("30d", today);
  const set = (r: DayRange) => {
    const p = new URLSearchParams(sp);
    p.set("from", r.from);
    p.set("to", r.to);
    router.replace(`${pathname}?${p}`, { scroll: false });
  };
  return [range, set];
}

function Reports() {
  const ws = useWorkspace();
  const today = localDay(new Date(), ws.timezone);
  const [range, setRange] = useRange(today);
  const query = { from: range.from, to: range.to };
  const overview = useApiQuery<AnalyticsOverview>(ws.key("analytics", "overview"), ws.path("/analytics/overview"), { query, keepPrevious: true });

  return (
    <>
      <PageHeader
        title="Reports"
        icon={<EntityTile of="reports" />}
        description={`${dayLabel(range.from, true)} – ${dayLabel(range.to, true)} · days in ${ws.timezone}`}
        actions={<RangePicker key={`${range.from}:${range.to}`} value={range} today={today} onChange={setRange} />}
      />
      <QueryState
        query={overview}
        loading={
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {Array.from({ length: 8 }, (_, i) => (
              <StatCard key={i} label={<Skeleton className="h-3 w-20" />} value={null} loading />
            ))}
          </div>
        }
      >
        {(o) => (
          <div className={cn("flex flex-col gap-6 transition-opacity", overview.isPlaceholderData && "opacity-60")}>
            {o.range.scope === "own" && (
              <Callout>Your role sees its own records, so these figures cover your deals, tasks, calls and meetings, conversations assigned to you, and unassigned ones.</Callout>
            )}
            <Outreach o={o} />
            <TrendCard series={o.series} currency={o.range.currency} />
            <PipelineSection o={o} query={query} />
            <ActivitySection o={o} />
            <CampaignsSection query={query} />
            {ws.can("analytics.team") && <TeamSection query={query} />}
          </div>
        )}
      </QueryState>
    </>
  );
}

// ─── KPI sections ─────────────────────────────────────────────────────────────

const grid = "grid grid-cols-2 gap-3 lg:grid-cols-4";

function Outreach({ o }: { o: AnalyticsOverview }) {
  const x = o.outreach;
  const channels = Object.entries(x.byChannel).sort((a, b) => b[1] - a[1]);
  const chat = channels.some(([c]) => c !== "email");
  return (
    <Section title="Outreach" icon={<MessagesSquare />} description="Messages sent in the range, and what happened to those messages.">
      <div className={grid}>
        <StatCard
          label="Messages sent"
          icon={<Send />}
          tint="indigo"
          value={formatNumber(x.sent)}
          hint={channels.length ? channels.map(([c, n]) => `${labelOf(c)} ${formatNumber(n)}`).join(" · ") : "Nothing sent"}
        />
        <StatCard
          label="Reply rate"
          icon={<Percent />}
          tint="green"
          value={pct(x.replyRate)}
          hint={`${formatNumber(x.replied)} of ${formatNumber(x.contacted)} conversations written to`}
        />
        <StatCard label="Replies" icon={<MessageSquareReply />} tint="green" value={formatNumber(x.replies)} hint="From people; auto-replies left out" />
        <StatCard
          label="Bounced"
          icon={<MailX />}
          tint="orange"
          value={formatNumber(x.bounced)}
          tone={x.bounceRate !== null && x.bounceRate >= 0.05 ? "warn" : undefined}
          hint={x.sent ? `${pct(x.bounceRate)} of sent` : undefined}
        />
        <StatCard label="Opens · weak signal" icon={<Eye />} tint="blue" value={formatNumber(x.opened)} hint={`${pct(x.openRate)} of sent; image proxies and privacy features distort opens`} />
        <StatCard label="Clicks" icon={<MousePointerClick />} tint="purple" value={formatNumber(x.clicked)} hint={x.sent ? `${pct(x.clickRate)} of sent, where click tracking is on` : undefined} />
        <StatCard label="Unsubscribes" icon={<UserMinus />} tint="red" value={formatNumber(x.unsubscribes)} hint="Contacts who opted out in the range" />
        {chat && (
          <StatCard label="Delivery receipts" icon={<CheckCheck />} tint="teal" value={formatNumber(x.delivered)} hint="Reported by chat channels; email servers don't confirm delivery" />
        )}
      </div>
    </Section>
  );
}

function PipelineSection({ o, query }: { o: AnalyticsOverview; query: DayRange }) {
  const f = useFormat();
  const p = o.pipeline;
  return (
    <Section title="Pipeline" icon={<Handshake />} description="Deals created, and deals closed, in the range.">
      <div className={grid}>
        <StatCard label="Deals created" icon={<Handshake />} tint="blue" value={formatNumber(p.created)} />
        <StatCard label="Won" icon={<Trophy />} tint="yellow" value={formatNumber(p.won)} hint={p.winRate === null ? "None closed" : `${pct(p.winRate)} of ${formatNumber(p.won + p.lost)} closed`} />
        <StatCard
          label={`Value won (${o.range.currency})`}
          icon={<Banknote />}
          tint="green"
          value={f.money(p.valueWon, o.range.currency)}
          hint={p.otherCurrencies.length ? `Also ${p.otherCurrencies.map((c) => f.money(c.value, c.currency)).join(", ")} in other currencies, not converted` : undefined}
        />
        <StatCard
          label="Average time to close"
          icon={<Timer />}
          tint="orange"
          value={p.avgDaysToClose === null ? "—" : `${formatNumber(p.avgDaysToClose)} d`}
          hint="Created to won, for deals won in the range"
        />
      </div>
      <FunnelCard query={query} />
    </Section>
  );
}

function FunnelCard({ query }: { query: DayRange }) {
  const ws = useWorkspace();
  const [pipelineId, setPipelineId] = useState<string | undefined>(undefined);
  const funnel = useApiQuery<AnalyticsPipeline>(ws.key("analytics", "pipeline"), ws.path("/analytics/pipeline"), {
    query: { ...query, pipelineId },
    keepPrevious: true,
  });
  return (
    <Card>
      <CardHeader
        icon={<FunnelIcon />}
        title="Stage funnel"
        description="Deals created in the range, and how far each has got so far. A deal counts at every stage up to the furthest it reached; the percentage is from the stage above."
        actions={
          funnel.data && funnel.data.pipelines.length > 1 ? (
            <Select
              aria-label="Pipeline"
              icon={<SquareKanban />}
              size="sm"
              className="w-48"
              value={funnel.data.pipelineId ?? undefined}
              onValueChange={setPipelineId}
              options={funnel.data.pipelines.map((p) => ({ value: p.id, label: p.name }))}
            />
          ) : undefined
        }
      />
      <CardBody>
        <QueryState query={funnel} loading={<SkeletonText lines={6} />}>
          {(d) =>
            d.cohort === 0 ? (
              <p className="py-4 text-center text-xs text-text-3">No deals were created in this pipeline in the range.</p>
            ) : (
              <div className="flex flex-col gap-3">
                <Funnel stages={d.stages} cohort={d.cohort} />
                <p className="text-xs text-text-3">
                  {formatNumber(d.cohort)} created · {formatNumber(d.won)} won · {formatNumber(d.lost)} lost · {formatNumber(d.open)} still open
                </p>
              </div>
            )
          }
        </QueryState>
      </CardBody>
    </Card>
  );
}

function ActivitySection({ o }: { o: AnalyticsOverview }) {
  const a = o.activity;
  return (
    <Section title="Activity" icon={<Activity />} description="Work logged in the range.">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        <StatCard label="Tasks completed" icon={<CheckSquare />} tint="orange" value={formatNumber(a.tasksCompleted)} />
        <StatCard label="Meetings booked" icon={<CalendarCheck />} tint="red" value={formatNumber(a.meetingsBooked)} hint={`Not since canceled · ${formatNumber(a.meetingsHeld)} held in the range`} />
        <StatCard label="Calls logged" icon={<Phone />} tint="teal" value={formatNumber(a.callsLogged)} hint={`${formatNumber(a.callsConnected)} connected`} />
      </div>
    </Section>
  );
}

// ─── Daily chart ──────────────────────────────────────────────────────────────

type MetricKey = Exclude<keyof SeriesPoint, "date" | "bounced" | "dealsCreated">;
const METRICS: { value: MetricKey; label: string; title: string }[] = [
  { value: "sent", label: "Sent", title: "Messages sent" },
  { value: "replies", label: "Replies", title: "Replies received" },
  { value: "dealsWon", label: "Deals won", title: "Deals won" },
  { value: "valueWon", label: "Value won", title: "Value won" },
  { value: "meetingsBooked", label: "Meetings", title: "Meetings booked" },
  { value: "tasksCompleted", label: "Tasks", title: "Tasks completed" },
  { value: "callsLogged", label: "Calls", title: "Calls logged" },
];
const METRIC_ICON: Partial<Record<MetricKey, LucideIcon>> = {
  sent: COL.sent,
  replies: COL.replied,
  dealsWon: COL.won,
  valueWon: COL.amount,
  meetingsBooked: COL.meetings,
  tasksCompleted: COL.tasks,
  callsLogged: COL.phone,
};

function TrendCard({ series, currency }: { series: SeriesPoint[]; currency: string }) {
  const f = useFormat();
  const [metric, setMetric] = useState<MetricKey>("sent");
  const [asTable, setAsTable] = useState(false);
  const m = METRICS.find((x) => x.value === metric)!;
  const money = metric === "valueWon";
  const format = (v: number) => (money ? f.money(v, currency) : formatNumber(v));
  const points = series.map((p) => ({ date: p.date, value: p[metric] }));
  const sum = points.reduce((a, p) => a + p.value, 0);

  return (
    <Card>
      <CardHeader
        icon={<TrendingUp />}
        title={money ? `${m.title} (${currency})` : m.title}
        description={`${format(sum)} over ${formatNumber(points.length)} days, by day in the workspace's time zone`}
        actions={
          <Button size="sm" variant="ghost" icon={asTable ? <BarChart3 /> : <Table2 />} onClick={() => setAsTable((v) => !v)}>
            {asTable ? "Chart" : "Table"}
          </Button>
        }
      />
      <CardBody className="flex flex-col gap-3">
        <div className="overflow-x-auto">
          <Segmented aria-label="Measure" value={metric} onChange={setMetric} options={METRICS.map(({ value, label }) => ({ value, label }))} />
        </div>
        {asTable ? (
          <div className="max-h-[220px] overflow-y-auto rounded-md border border-line">
            <table className="w-full border-collapse text-sm">
              <caption className="sr-only">{m.title} by day</caption>
              <thead className="sticky top-0 bg-panel">
                <tr className="border-b border-line">
                  <th scope="col" className="h-8 px-3 text-left text-xs font-medium text-text-3">
                    <ColumnLabel icon={COL.date}>Day</ColumnLabel>
                  </th>
                  <th scope="col" className="h-8 px-3 text-right text-xs font-medium text-text-3">
                    <ColumnLabel icon={METRIC_ICON[metric]}>{m.label}</ColumnLabel>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {points.map((p) => (
                  <tr key={p.date}>
                    <td className="px-3 py-1.5 text-text-2">{dayLabel(p.date, true)}</td>
                    <td className={cn("px-3 py-1.5 text-right tabular-nums", p.value ? "text-text" : "text-text-3")}>{format(p.value)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <DailyChart points={points} label={m.title} format={format} integer={!money} />
        )}
      </CardBody>
    </Card>
  );
}

// ─── Campaigns ────────────────────────────────────────────────────────────────

function Th({ children, left, icon }: { children: ReactNode; left?: boolean; icon?: LucideIcon }) {
  return (
    <th scope="col" className={cn("h-8 px-3 text-xs font-medium whitespace-nowrap text-text-3", left ? "text-left" : "text-right")}>
      <ColumnLabel icon={icon}>{children}</ColumnLabel>
    </th>
  );
}

const Num = ({ v, dash }: { v: number | string; dash?: boolean }) => (
  <td className={cn("px-3 py-2 text-right tabular-nums", v && v !== "—" ? "text-text" : "text-text-3")}>{dash ? "—" : typeof v === "number" ? formatNumber(v) : v}</td>
);

function CampaignsSection({ query }: { query: DayRange }) {
  const ws = useWorkspace();
  const data = useApiQuery<AnalyticsCampaigns>(ws.key("analytics", "campaigns"), ws.path("/analytics/campaigns"), { query, keepPrevious: true });
  return (
    <Section title="Campaigns" icon={<Send />} description="Each campaign's sends in the range. Reply rate is the share of people messaged in the range who replied afterwards.">
      <QueryState query={data} loading={<SkeletonText lines={5} />}>
        {(d) =>
          d.campaigns.length === 0 ? (
            <Card>
              <EmptyState compact icon={<Send />} title="No campaign sends in this range" description="Campaigns appear here once they have sent in the chosen days." />
            </Card>
          ) : (
            <>
              <Card className="overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[860px] border-collapse text-sm">
                    <thead className="border-b border-line bg-s-2">
                      <tr>
                        <Th left icon={COL.campaign}>
                          Campaign
                        </Th>
                        <Th icon={COL.sent}>Sent</Th>
                        <Th icon={COL.people}>People</Th>
                        <Th icon={COL.replied}>Replied</Th>
                        <Th icon={COL.rate}>Reply rate</Th>
                        <Th icon={COL.bounced}>Bounced</Th>
                        <Th icon={COL.opened}>Opens</Th>
                        <Th icon={COL.clicked}>Clicks</Th>
                        <Th icon={COL.unsubscribed}>Unsubscribed</Th>
                        <Th icon={COL.deals}>Deals</Th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-line">
                      {d.campaigns.map((c) => (
                        <tr key={c.id}>
                          <td className="max-w-72 px-3 py-2">
                            <span className="flex items-center gap-2">
                              {c.deleted || !ws.can("campaigns.read") ? (
                                <span className="truncate font-medium text-text">{c.name}</span>
                              ) : (
                                <Link href={ws.href(`/campaigns/${c.id}`)} className="truncate font-medium text-text hover:underline">
                                  {c.name}
                                </Link>
                              )}
                              {c.deleted ? <span className="shrink-0 text-xs text-text-3">(deleted)</span> : <StatusBadge value={c.status} />}
                            </span>
                          </td>
                          <Num v={c.sent} />
                          <Num v={c.contacted} />
                          <Num v={c.replied} />
                          <Num v={pct(c.replyRate)} />
                          <Num v={c.bounced} />
                          <Num v={c.opened} dash={!c.trackOpens && !c.opened} />
                          <Num v={c.clicked} dash={!c.trackClicks && !c.clicked} />
                          <Num v={c.unsubscribed} />
                          <Num v={c.deals} />
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>
              {d.steps.length > 0 && <StepsCard steps={d.steps} />}
            </>
          )
        }
      </QueryState>
    </Section>
  );
}

function StepsCard({ steps }: { steps: AnalyticsCampaigns["steps"] }) {
  return (
    <Card className="overflow-hidden">
      <CardHeader
        icon={<ListOrdered />}
        title="By sequence step"
        description="All campaigns together, by step number: the first touch against each follow-up. A reply counts for the last step sent before it."
      />
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] border-collapse text-sm">
          <thead className="border-b border-line bg-s-2">
            <tr>
              <Th left icon={COL.steps}>
                Step
              </Th>
              <Th icon={COL.sent}>Sent</Th>
              <Th icon={COL.replied}>Replied</Th>
              <Th icon={COL.rate}>Reply rate</Th>
              <Th icon={COL.bounced}>Bounced</Th>
              <Th icon={COL.opened}>Opens</Th>
              <Th icon={COL.clicked}>Clicks</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {steps.map((s) => (
              <tr key={s.position}>
                <td className="px-3 py-2 font-medium text-text">
                  Step {s.position + 1}
                  {s.position === 0 && <span className="ml-1.5 text-xs font-normal text-text-3">first touch</span>}
                </td>
                <Num v={s.sent} />
                <Num v={s.replied} />
                <Num v={pct(s.replyRate)} />
                <Num v={s.bounced} />
                <Num v={s.opened} />
                <Num v={s.clicked} />
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

// ─── Team ─────────────────────────────────────────────────────────────────────

function TeamSection({ query }: { query: DayRange }) {
  const ws = useWorkspace();
  const allowed = ws.hasFeature("advancedReporting");
  const data = useApiQuery<AnalyticsTeam>(ws.key("analytics", "team"), allowed ? ws.path("/analytics/team") : null, { query, keepPrevious: true });
  return (
    <Section
      title="Team"
      icon={<Users />}
      description="Per member, for the range. Sends count for their author (a campaign's owner for campaign sends); replies for the conversation's assignee, else the campaign's owner; deals and meetings for their owner."
    >
      {!allowed ? (
        <UpgradePrompt details={{ feature: "advancedReporting", plan: ws.plan?.name }} />
      ) : (
        <TeamTable data={data} />
      )}
    </Section>
  );
}

function TeamTable({ data }: { data: ReturnType<typeof useApiQuery<AnalyticsTeam>> }) {
  const f = useFormat();
  return (
    <QueryState query={data} loading={<SkeletonText lines={4} />}>
      {(d) => (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px] border-collapse text-sm">
              <thead className="border-b border-line bg-s-2">
                <tr>
                  <Th left icon={COL.person}>
                    Member
                  </Th>
                  <Th icon={COL.sent}>Sent</Th>
                  <Th icon={COL.replied}>Replies</Th>
                  <Th icon={COL.meetings}>Meetings</Th>
                  <Th icon={COL.phone}>Calls</Th>
                  <Th icon={COL.tasks}>Tasks done</Th>
                  <Th icon={COL.deals}>Deals created</Th>
                  <Th icon={COL.won}>Won</Th>
                  <Th icon={COL.amount}>Value won ({d.range.currency})</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {d.members.map((m) => (
                  <tr key={m.userId}>
                    <td className="max-w-64 px-3 py-2">
                      <span className="block truncate font-medium text-text">{m.name || m.email}</span>
                      <span className="block truncate text-xs text-text-3">
                        {labelOf(m.role)} · {m.email}
                      </span>
                    </td>
                    <Num v={m.sent} />
                    <Num v={m.replies} />
                    <Num v={m.meetingsBooked} />
                    <td className={cn("px-3 py-2 text-right tabular-nums", m.callsLogged ? "text-text" : "text-text-3")}>
                      {formatNumber(m.callsLogged)}
                      {m.callsLogged > 0 && <span className="ml-1 text-xs text-text-3">({formatNumber(m.callsConnected)} connected)</span>}
                    </td>
                    <Num v={m.tasksCompleted} />
                    <Num v={m.dealsCreated} />
                    <Num v={m.dealsWon} />
                    <Num v={m.valueWon ? f.money(m.valueWon, d.range.currency) : 0} />
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </QueryState>
  );
}
