"use client";

import Link from "next/link";
import { useState } from "react";
import { AlarmClock, ArrowRight, CheckCircle2, Gauge, Handshake, Inbox, ListTodo, UserPlus, UserX, Users } from "lucide-react";
import { Avatar } from "@/components/ui/Avatar";
import { Badge, type Tone } from "@/components/ui/Badge";
import { Card, CardHeader } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { NativeSelect } from "@/components/ui/Input";
import { Page, PageHeader } from "@/components/ui/PageHeader";
import { RequirePermission } from "@/components/ui/RequirePermission";
import { SkeletonText } from "@/components/ui/Skeleton";
import { StatCard } from "@/components/ui/StatCard";
import { EntityTile } from "@/components/ui/icons";
import { cn } from "@/lib/cn";
import { formatNumber } from "@/lib/format";
import { useApiQuery } from "@/lib/query";
import { useFormat, useWorkspace } from "@/lib/session";

/* GET /team-overview — apps/api/src/teams/team-overview.service.ts */
type Person = {
  userId: string;
  name: string;
  email: string;
  title: string;
  role: string;
  away: boolean;
  awayUntil: string | null;
  openLeads: number;
  openDeals: number;
  openDealValue: number;
  openTasks: number;
  overdueTasks: number;
  staleLeads: number;
  waitingReplies: number;
  waitingOver24h: number;
  dealsNoNextStep: number;
  speedToLeadMinutes: number | null;
  untouchedLeads: number;
  load: "light" | "normal" | "heavy";
};
type Alert = { key: string; severity: "high" | "medium" | "low"; count: number; title: string; hint: string; href: string; userId?: string };
type Overview = {
  generatedAt: string;
  currency: string;
  staleDays: number;
  speedWindowDays: number;
  totals: Omit<Person, "userId" | "name" | "email" | "title" | "role" | "away" | "awayUntil" | "load"> & { people: number; away: number; unownedLeads: number; unassignedReplies: number };
  people: Person[];
  alerts: Alert[];
};

const SEVERITY: Record<Alert["severity"], { tone: Tone; label: string }> = {
  high: { tone: "bad", label: "Urgent" },
  medium: { tone: "warn", label: "Soon" },
  low: { tone: "info", label: "Tidy up" },
};

/** 30 → "30m", 130 → "2h 10m", 3000 → "2.1d". */
function duration(minutes: number | null) {
  if (minutes == null) return "—";
  if (minutes < 60) return `${Math.max(0, Math.round(minutes))}m`;
  if (minutes < 24 * 60) {
    const h = Math.floor(minutes / 60);
    const m = Math.round(minutes % 60);
    return m ? `${h}h ${m}m` : `${h}h`;
  }
  return `${(minutes / 1440).toFixed(1)}d`;
}

function Num({ value, tone, href, title }: { value: number; tone?: "warn" | "bad"; href?: string; title?: string }) {
  const ws = useWorkspace();
  const cls = cn("tabular-nums", value === 0 ? "text-text-3" : tone === "bad" ? "font-semibold text-bad-ink" : tone === "warn" ? "font-semibold text-warn-ink" : "text-text");
  if (href && value > 0)
    return (
      <Link href={ws.href(href)} title={title} className={cn(cls, "hover:underline")}>
        {formatNumber(value)}
      </Link>
    );
  return (
    <span title={title} className={cls}>
      {formatNumber(value)}
    </span>
  );
}

function Alerts({ alerts }: { alerts: Alert[] }) {
  const ws = useWorkspace();
  return (
    <Card className="mb-4">
      <CardHeader title="Needs attention" description="Where work is slipping right now, most urgent first." icon={<AlarmClock />} />
      {!alerts.length ? (
        <div className="flex items-center gap-2 px-4 pb-4 text-sm text-ok-ink">
          <CheckCircle2 aria-hidden className="size-4" />
          All clear: every reply has someone, every lead has an owner, nothing is overdue.
        </div>
      ) : (
        <ul className="divide-y divide-line border-t border-line">
          {alerts.map((a) => (
            <li key={`${a.key}:${a.userId ?? ""}`}>
              <Link href={ws.href(a.href)} className="group flex items-start gap-3 px-4 py-2.5 hover:bg-hover">
                <Badge tone={SEVERITY[a.severity].tone} dot className="mt-0.5 shrink-0">
                  {SEVERITY[a.severity].label}
                </Badge>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-text">{a.title}</div>
                  <div className="text-xs text-text-3">{a.hint}</div>
                </div>
                <ArrowRight aria-hidden className="mt-1 size-4 shrink-0 text-text-3 transition-transform group-hover:translate-x-0.5" />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function People({ data }: { data: Overview }) {
  const ws = useWorkspace();
  const f = useFormat();
  if (!data.people.length) return <EmptyState icon={<Users />} title="Nobody here yet" description="Invite teammates, or pick another team." />;
  const th = "px-3 py-2 text-left text-xs font-medium whitespace-nowrap text-text-3";
  const td = "px-3 py-2.5 whitespace-nowrap";
  return (
    <Card className="overflow-hidden">
      <CardHeader title="People" description={`Open work per person. Stale = owned leads with nothing for ${data.staleDays} days; speed to lead = median time to the first email, call or booking (last ${data.speedWindowDays} days).`} icon={<Users />} />
      <div className="overflow-x-auto border-t border-line">
        <table className="w-full text-sm">
          <thead className="bg-sunken">
            <tr>
              <th className={th}>Person</th>
              <th className={cn(th, "text-right")}>Leads</th>
              <th className={cn(th, "text-right")}>Stale</th>
              <th className={cn(th, "text-right")}>Deals</th>
              <th className={cn(th, "text-right")}>No next step</th>
              <th className={cn(th, "text-right")}>Tasks</th>
              <th className={cn(th, "text-right")}>Overdue</th>
              <th className={cn(th, "text-right")}>Waiting replies</th>
              <th className={cn(th, "text-right")}>Speed to lead</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {data.people.map((p) => (
              <tr key={p.userId} className="hover:bg-hover">
                <td className={td}>
                  <div className="flex items-center gap-2.5">
                    <Avatar size="sm" name={p.name} email={p.email} />
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <Link href={ws.href(`/leads?owner=${p.userId}`)} className="truncate font-medium text-text hover:text-accent-hi hover:underline">
                          {p.name || p.email}
                        </Link>
                        {p.away && (
                          <Badge tone="warn" quiet title={p.awayUntil ? `Away until ${f.dateTime(p.awayUntil)}` : undefined}>
                            Away
                          </Badge>
                        )}
                        {p.load === "heavy" && (
                          <Badge tone="bad" quiet>
                            Heavy load
                          </Badge>
                        )}
                        {p.load === "light" && (
                          <Badge tone="ok" quiet>
                            Has room
                          </Badge>
                        )}
                      </div>
                      <div className="truncate text-xs text-text-3">{p.title || p.role}</div>
                    </div>
                  </div>
                </td>
                <td className={cn(td, "text-right")}>
                  <Num value={p.openLeads} href={`/leads?owner=${p.userId}`} />
                  {p.untouchedLeads > 0 && <div className="text-xs text-warn-ink">{formatNumber(p.untouchedLeads)} not contacted</div>}
                </td>
                <td className={cn(td, "text-right")}>
                  <Num value={p.staleLeads} tone="warn" />
                </td>
                <td className={cn(td, "text-right")}>
                  <Num value={p.openDeals} />
                  {p.openDealValue > 0 && <div className="text-xs text-text-3">{f.money(p.openDealValue, data.currency)}</div>}
                </td>
                <td className={cn(td, "text-right")}>
                  <Num value={p.dealsNoNextStep} tone="warn" />
                </td>
                <td className={cn(td, "text-right")}>
                  <Num value={p.openTasks} />
                </td>
                <td className={cn(td, "text-right")}>
                  <Num value={p.overdueTasks} tone="bad" />
                </td>
                <td className={cn(td, "text-right")}>
                  <Num value={p.waitingReplies} tone={p.waitingOver24h ? "bad" : undefined} href="/inbox" />
                  {p.waitingOver24h > 0 && <div className="text-xs text-bad-ink">{formatNumber(p.waitingOver24h)} over a day</div>}
                </td>
                <td className={cn(td, "text-right tabular-nums", p.speedToLeadMinutes != null && p.speedToLeadMinutes > 24 * 60 ? "text-warn-ink" : "text-text")}>
                  {duration(p.speedToLeadMinutes)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function Overview() {
  const ws = useWorkspace();
  const f = useFormat();
  const [teamId, setTeamId] = useState("");
  const teams = useApiQuery<{ teams: { id: string; name: string }[] }>(ws.key("teams"), ws.path("/teams"));
  const q = useApiQuery<Overview>(ws.key("team-overview", { teamId }), ws.path("/team-overview"), { query: teamId ? { teamId } : {}, refetchInterval: 60_000 });
  const t = q.data?.totals;

  return (
    <>
      {(teams.data?.teams.length ?? 0) > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <NativeSelect
            icon={<Users />}
            aria-label="Team"
            className="w-auto min-w-40"
            value={teamId}
            onChange={(e) => setTeamId(e.target.value)}
            options={[{ value: "", label: "Everyone" }, ...(teams.data?.teams ?? []).map((x) => ({ value: x.id, label: x.name }))]}
          />
          {q.data && <span className="text-xs text-text-3">Updated {f.time(q.data.generatedAt)}</span>}
        </div>
      )}

      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
        <StatCard label="Open leads" value={t ? formatNumber(t.openLeads) : "—"} loading={q.isPending} icon={<UserPlus />} tint="mint" href={ws.href("/leads")} hint={t && t.untouchedLeads ? `${formatNumber(t.untouchedLeads)} not contacted` : undefined} />
        <StatCard label="Unowned leads" value={t ? formatNumber(t.unownedLeads) : "—"} loading={q.isPending} icon={<UserX />} tint="yellow" tone={t?.unownedLeads ? "warn" : undefined} href={ws.href("/leads?owner=none")} />
        <StatCard label="Open deals" value={t ? formatNumber(t.openDeals) : "—"} loading={q.isPending} icon={<Handshake />} tint="green" href={ws.href("/deals")} hint={t ? f.money(t.openDealValue, q.data?.currency) : undefined} />
        <StatCard
          label="Waiting replies"
          value={t ? formatNumber(t.waitingReplies + t.unassignedReplies) : "—"}
          loading={q.isPending}
          icon={<Inbox />}
          tint="cyan"
          tone={t && (t.waitingOver24h || t.unassignedReplies) ? "bad" : undefined}
          href={ws.href("/inbox")}
          hint={t && t.waitingOver24h ? `${formatNumber(t.waitingOver24h)} over a day` : undefined}
        />
        <StatCard label="Overdue tasks" value={t ? formatNumber(t.overdueTasks) : "—"} loading={q.isPending} icon={<ListTodo />} tint="orange" tone={t?.overdueTasks ? "warn" : undefined} href={ws.href("/tasks")} />
        <StatCard label="Speed to lead" value={t ? duration(t.speedToLeadMinutes) : "—"} loading={q.isPending} icon={<Gauge />} tint="purple" hint="Median to first touch" />
      </div>

      {q.isPending ? (
        <Card className="p-4">
          <SkeletonText lines={8} />
        </Card>
      ) : q.isError ? (
        <ErrorState error={q.error as never} onRetry={() => void q.refetch()} />
      ) : (
        q.data && (
          <>
            <Alerts alerts={q.data.alerts} />
            <People data={q.data} />
          </>
        )
      )}
    </>
  );
}

export default function TeamOverviewPage() {
  return (
    <Page width="full">
      <RequirePermission permission="analytics.team">
        <PageHeader
          title="Team overview"
          icon={<EntityTile of="members" />}
          description="Who carries what, and where work is slipping — replies waiting, leads nobody owns, overdue follow-ups, deals with no next step."
        />
        <Overview />
      </RequirePermission>
    </Page>
  );
}
