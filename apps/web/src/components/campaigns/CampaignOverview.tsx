"use client";

import type { UseQueryResult } from "@tanstack/react-query";
import Link from "next/link";
import {
  Activity,
  CalendarCheck,
  CalendarClock,
  CircleAlert,
  CircleCheck,
  ClipboardCheck,
  Gauge,
  Infinity as AlwaysOn,
  ListOrdered,
  Mail,
  MailOpen,
  MailX,
  MousePointerClick,
  PlayCircle,
  Reply,
  Send,
  Settings2,
  TrendingUp,
  UserMinus,
  UserRound,
  Users,
} from "lucide-react";
import type { ReactNode } from "react";
import { labelOf } from "@growthdesk/shared";
import { Callout } from "@/components/ui/Callout";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { COL, ColumnLabel } from "@/components/ui/columns";
import { Fact, FactGrid } from "@/components/ui/Fact";
import { SkeletonText } from "@/components/ui/Skeleton";
import { StatCard } from "@/components/ui/StatCard";
import { useAiAgents } from "@/components/calls/callHooks";
import { StepTile, stepSummary } from "@/components/sequences/StepsEditor";
import type { ApiError } from "@/lib/api";
import { cn } from "@/lib/cn";
import { formatNumber } from "@/lib/format";
import { useApiQuery } from "@/lib/query";
import { useFormat, useWorkspace } from "@/lib/session";
import type { CampaignDetail, CampaignHealth, CampaignReadiness, StepStats } from "@/lib/types/campaigns";
import { FixLink, SkippedList, plural } from "./common";

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "Mon–Fri, 09:00–17:00 Europe/London" — what the stored send window means to the engine. */
export function scheduleLine(s: CampaignDetail["schedule"]): string {
  const days = [...s.days].sort((a, b) => a - b);
  const weekdays = days.length === 5 && [1, 2, 3, 4, 5].every((d) => days.includes(d));
  const dayText = days.length === 7 ? "Every day" : weekdays ? "Mon–Fri" : days.map((d) => DAY_NAMES[d]).join(", ");
  // shared/schedule.ts: an end before the start runs overnight into the next day; equal times mean 24 hours.
  const hours = s.to === s.from ? (s.from === "00:00" ? "any time" : `24 hours from ${s.from}`) : s.to < s.from ? `${s.from}–${s.to} (overnight)` : `${s.from}–${s.to}`;
  return `${dayText}, ${hours} (${s.timezone})`;
}

/** Numbers from the API (recounted from enrollments and messages), readiness for a draft, and per-step progress. */
export function CampaignOverview({ campaign }: { campaign: CampaignDetail }) {
  const ws = useWorkspace();
  const f = useFormat();
  const s = campaign.stats;
  const e = campaign.enrollments;
  const isDraft = campaign.status === "draft";
  const isLive = campaign.status === "scheduled" || campaign.status === "running" || campaign.status === "paused";
  const readiness = useApiQuery<CampaignReadiness>(ws.key("campaigns", campaign.id, "readiness"), isDraft ? ws.path(`/campaigns/${campaign.id}/readiness`) : null);
  const health = useApiQuery<CampaignHealth>(ws.key("campaigns", campaign.id, "health"), isLive ? ws.path(`/campaigns/${campaign.id}/health`) : null);
  const stepStats = useApiQuery<StepStats[]>(ws.key("campaigns", campaign.id, "step-stats"), isDraft ? null : ws.path(`/campaigns/${campaign.id}/step-stats`));
  const agents = useAiAgents(!isDraft && campaign.steps.some((s) => s.type === "ai_call"), "all");
  const enrollmentsHref = (status?: string) => ws.href(`/campaigns/${campaign.id}?tab=enrollments${status ? `&status=${status}` : ""}`);
  const tracking = campaign.settings.trackOpens || campaign.settings.trackClicks;

  return (
    <div className="flex flex-col gap-4">
      {isDraft && <Readiness query={readiness} />}
      {isLive && health.data && health.data.issues.length > 0 && <HealthCallout issues={health.data.issues} />}

      {!isDraft && (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard label="Enrolled" icon={<Users />} tint="indigo" value={formatNumber(s.enrolled)} href={enrollmentsHref()} />
            <StatCard label="Messages sent" icon={<Send />} tint="blue" value={formatNumber(s.sent)} />
            <StatCard
              label="Replied"
              icon={<Reply />}
              tint="green"
              value={formatNumber(s.replied)}
              hint={s.enrolled ? `${pct(s.replied, s.enrolled)} of contacts` : undefined}
              tone={s.replied ? "ok" : undefined}
              href={enrollmentsHref("replied")}
            />
            <StatCard
              label="Failed"
              icon={<CircleAlert />}
              tint="red"
              value={formatNumber(s.failed)}
              hint={s.failed ? "Retry them from Enrollments" : "Nothing failed"}
              tone={s.failed ? "bad" : undefined}
              href={enrollmentsHref("failed")}
            />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader icon={<Users />} title="Contacts" description="Where everyone enrolled stands right now." />
              <CardBody className="flex flex-col gap-4">
                <StateBar
                  total={s.enrolled}
                  parts={[
                    { key: "active", label: "Active", value: e.active, color: "bg-accent", href: enrollmentsHref("active") },
                    { key: "paused", label: "Paused", value: e.paused, color: "bg-warn", href: enrollmentsHref("paused") },
                    { key: "completed", label: "Completed", value: e.completed, color: "bg-ok", href: enrollmentsHref("completed") },
                    { key: "stopped", label: "Stopped", value: e.stopped, color: "bg-s-6", href: enrollmentsHref("stopped") },
                    { key: "failed", label: "Failed", value: e.failed, color: "bg-bad", href: enrollmentsHref("failed") },
                  ]}
                />
                {s.updatedAt && <p className="text-xs text-text-3">Counted {f.relative(s.updatedAt)}.</p>}
              </CardBody>
            </Card>

            <Card>
              <CardHeader icon={<TrendingUp />} title="Engagement" description="Rates from the messages sent and the contacts enrolled." />
              <CardBody className="flex flex-col gap-3.5">
                <RateRow icon={<Reply />} label="Reply rate" value={s.replied} of={s.enrolled} unit="contacts" good />
                <RateRow
                  icon={<MailOpen />}
                  label="Open rate"
                  value={s.opened}
                  of={s.sent}
                  unit="messages"
                  off={!campaign.settings.trackOpens ? "Open tracking is off" : undefined}
                />
                <RateRow
                  icon={<MousePointerClick />}
                  label="Click rate"
                  value={s.clicked}
                  of={s.sent}
                  unit="messages"
                  off={!campaign.settings.trackClicks ? "Click tracking is off" : undefined}
                />
                <RateRow icon={<MailX />} label="Bounce rate" value={s.bounced} of={s.sent} unit="messages" warnAbove={0.03} />
                <RateRow icon={<UserMinus />} label="Unsubscribed" value={s.unsubscribed} of={s.enrolled} unit="contacts" warnAbove={0.02} />
              </CardBody>
            </Card>
          </div>
        </>
      )}

      <Card className="overflow-hidden">
        <CardHeader
          icon={<Settings2 />}
          title="Setup"
          actions={
            campaign.settings.keepOpen ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-accent-soft px-2 py-0.5 text-xs font-medium text-accent-ink">
                <AlwaysOn aria-hidden className="size-3.5" />
                Always on
              </span>
            ) : undefined
          }
        />
        <FactGrid columns={3}>
          <Fact icon={<Users />} label="Audience">
            {campaign.audienceDescription}
          </Fact>
          <Fact icon={<ListOrdered />} label="Steps">
            {plural(campaign.stepCount, "step")}
          </Fact>
          <Fact icon={<CalendarClock />} label="Send window">
            <span title={scheduleLine(campaign.schedule)}>{scheduleLine(campaign.schedule)}</span>
          </Fact>
          <Fact icon={<Mail />} label="Mailboxes" hint={campaign.mailboxes.length > 1 ? `${campaign.mailboxes.length} mailboxes take turns` : undefined}>
            {campaign.mailboxes.length ? campaign.mailboxes.map((m) => m.email).join(", ") : "Any connected mailbox"}
          </Fact>
          <Fact icon={<Gauge />} label="New contacts per day">
            {formatNumber(campaign.settings.dailyNewLimit)}
          </Fact>
          <Fact icon={<UserRound />} label="Owner">
            {campaign.owner?.name || campaign.owner?.email || null}
          </Fact>
        </FactGrid>
        {(campaign.startAt || campaign.startedAt || campaign.completedAt || campaign.canceledAt || (campaign.pausedAt && campaign.status === "paused")) && (
          <div className="flex flex-wrap gap-x-5 gap-y-1.5 border-t border-line bg-well px-4 py-2.5 text-xs text-text-2">
            {campaign.startAt && <When icon={<CalendarClock />} label="Starts" at={f.dateTime(campaign.startAt)} />}
            {campaign.startedAt && <When icon={<PlayCircle />} label="Started" at={f.dateTime(campaign.startedAt)} />}
            {campaign.pausedAt && campaign.status === "paused" && <When icon={<Activity />} label="Paused" at={f.dateTime(campaign.pausedAt)} />}
            {campaign.completedAt && <When icon={<CalendarCheck />} label="Completed" at={f.dateTime(campaign.completedAt)} />}
            {campaign.canceledAt && <When icon={<CircleAlert />} label="Stopped" at={f.dateTime(campaign.canceledAt)} />}
          </div>
        )}
      </Card>

      {!isDraft && (
        <Card className="overflow-hidden">
          <CardHeader icon={<ListOrdered />} title="By step" description="Runs recorded for each step, and how many active contacts are waiting to run it next." />
          {stepStats.isPending ? (
            <CardBody>
              <SkeletonText lines={4} />
            </CardBody>
          ) : stepStats.isError ? (
            <CardBody>
              <p className="text-sm text-bad-ink">{stepStats.error.message}</p>
            </CardBody>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] border-collapse text-sm">
                <thead className="border-y border-line bg-s-2">
                  <tr>
                    {(
                      [
                        ["Step", COL.steps],
                        ["Waiting", COL.pending],
                        ["Done", COL.result],
                        ["Skipped", COL.skipped],
                        ["Failed", COL.failed],
                        ["Unclear", COL.problem],
                        ["Sent", COL.sent],
                        ["Opened", COL.opened],
                        ["Clicked", COL.clicked],
                        ["Bounced", COL.bounced],
                      ] as const
                    ).map(([h, icon], i) => (
                      <th key={h} scope="col" className={cn("h-8 px-3 text-xs font-medium whitespace-nowrap text-text-3", i ? "text-right" : "text-left")}>
                        <ColumnLabel icon={icon}>{h}</ColumnLabel>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {stepStats.data.map((row) => {
                    const step = campaign.steps.find((x) => x.position === row.position);
                    const n = (v: number | undefined) => <span className={cn("tabular-nums", v ? "text-text" : "text-text-3")}>{v === undefined ? "—" : formatNumber(v)}</span>;
                    return (
                      <tr key={row.position}>
                        <td className="max-w-72 px-3 py-2">
                          <div className="flex min-w-0 items-center gap-2.5">
                            <StepTile type={row.type} />
                            <div className="min-w-0">
                              <span className="font-medium text-text">
                                <span className="text-text-3 tabular-nums">{row.position + 1}.</span> {labelOf(row.type)}
                              </span>
                              {step && <span className="block truncate text-xs text-text-3">{stepSummary(step, agents.data)}</span>}
                            </div>
                          </div>
                        </td>
                        <td className="px-3 py-2 text-right">{n(row.waiting)}</td>
                        <td className="px-3 py-2 text-right">{n(row.executions.succeeded)}</td>
                        <td className="px-3 py-2 text-right">{n(row.executions.skipped)}</td>
                        <td className="px-3 py-2 text-right">{n(row.executions.failed)}</td>
                        <td className="px-3 py-2 text-right" title="The worker stopped mid-send; the message may have gone out, so it was not sent again.">
                          {n(row.executions.uncertain)}
                        </td>
                        <td className="px-3 py-2 text-right">{n(row.messages?.sent)}</td>
                        <td className="px-3 py-2 text-right">{n(row.messages && campaign.settings.trackOpens ? row.messages.opened : undefined)}</td>
                        <td className="px-3 py-2 text-right">{n(row.messages && campaign.settings.trackClicks ? row.messages.clicked : undefined)}</td>
                        <td className="px-3 py-2 text-right">{n(row.messages?.bounced)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}
    </div>
  );
}

/** What holds a launched campaign back (GET /health): mailboxes that cannot send, stuck or failed enrollments. */
function HealthCallout({ issues }: { issues: CampaignHealth["issues"] }) {
  return (
    <Callout tone="warn" title="Needs attention">
      <ul className="flex flex-col gap-1.5">
        {issues.map((p, i) => (
          <li key={i} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
            <span className="min-w-0">{p.message}</span>
            {p.fix && <FixLink fix={p.fix} />}
          </li>
        ))}
      </ul>
    </Callout>
  );
}

function Readiness({ query }: { query: UseQueryResult<CampaignReadiness, ApiError> }) {
  if (query.isPending)
    return (
      <Card className="p-4">
        <SkeletonText lines={3} />
      </Card>
    );
  if (query.isError) return <Callout tone="bad">Could not check whether the campaign is ready: {query.error.message}</Callout>;
  const r = query.data;
  return (
    <Card>
      <CardHeader
        icon={r.ready ? <CircleCheck className="text-ok-ink" /> : <ClipboardCheck />}
        title={r.ready ? "Ready to launch" : "Before you launch"}
        description={r.ready ? "Everything a launch checks is in place." : "Launching is refused until these are fixed."}
      />
      <CardBody className="flex flex-col gap-3">
        {r.problems.length > 0 && (
          <ul className="flex flex-col gap-1.5 text-sm">
            {r.problems.map((p, i) => (
              <li key={i} className="flex gap-2 text-bad-ink">
                <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
                <span className="flex min-w-0 flex-1 flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                  <span>{p.message}</span>
                  {p.fix && <FixLink fix={p.fix} />}
                </span>
              </li>
            ))}
          </ul>
        )}
        {r.warnings.length > 0 && (
          <Callout tone="warn">
            <ul className="list-disc pl-4">
              {r.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          </Callout>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-md border border-line p-3 text-sm">
            <p className="text-xs text-text-3">Audience</p>
            <p className="mt-1 text-text">{r.audience.description}</p>
            <p className="mt-1 text-text-2">
              {plural(r.audience.candidates, "contact")} · <strong className="font-medium text-text">{formatNumber(r.audience.eligible)}</strong> can be enrolled
            </p>
          </div>
          {r.audience.skipped.length > 0 && (
            <div className="rounded-md border border-line p-3">
              <p className="mb-1 text-xs text-text-3">Would be skipped</p>
              <SkippedList items={r.audience.skipped} />
            </div>
          )}
        </div>
      </CardBody>
    </Card>
  );
}

const pct = (n: number, of: number) => (of ? `${Math.round((n / of) * 1000) / 10}%` : "—");

function When({ icon, label, at }: { icon: ReactNode; label: string; at: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span aria-hidden className="text-text-3 [&_svg]:size-3.5">
        {icon}
      </span>
      <span className="text-text-3">{label}</span>
      <span className="text-text">{at}</span>
    </span>
  );
}

/**
 * Enrollment states as one stacked bar (2px surface gaps, rounded ends) with
 * a legend that carries the counts and links to each filter, so the colour
 * is never the only cue.
 */
function StateBar({ total, parts }: { total: number; parts: { key: string; label: string; value: number; color: string; href: string }[] }) {
  const shown = parts.filter((p) => p.value > 0);
  const sum = shown.reduce((n, p) => n + p.value, 0) || 1;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-2xl font-semibold text-text-hi tabular-nums">{formatNumber(total)}</span>
        <span className="text-xs text-text-3">contacts enrolled</span>
      </div>
      <div className="flex h-2.5 w-full gap-0.5 overflow-hidden rounded-full bg-s-3" role="img" aria-label={shown.map((p) => `${p.label}: ${p.value}`).join(", ") || "Nobody enrolled yet"}>
        {shown.map((p) => (
          <Link
            key={p.key}
            href={p.href}
            title={`${p.label}: ${formatNumber(p.value)} (${pct(p.value, sum)})`}
            className={cn("h-full first:rounded-l-full last:rounded-r-full hover:opacity-80", p.color)}
            style={{ width: `${(p.value / sum) * 100}%` }}
          />
        ))}
      </div>
      <ul className="grid grid-cols-2 gap-x-4 gap-y-1.5 sm:grid-cols-3">
        {parts.map((p) => (
          <li key={p.key}>
            <Link href={p.href} className="flex items-center gap-2 rounded-sm text-xs hover:underline">
              <span aria-hidden className={cn("size-2.5 shrink-0 rounded-full", p.value ? p.color : "bg-s-4")} />
              <span className="text-text-2">{p.label}</span>
              <span className={cn("ml-auto tabular-nums", p.value ? "font-medium text-text" : "text-text-3")}>{formatNumber(p.value)}</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** One rate: label, the percentage, "n of m", and a thin bar (warn colour past a threshold). */
function RateRow({
  icon,
  label,
  value,
  of,
  unit,
  off,
  warnAbove,
  good,
}: {
  icon: ReactNode;
  label: string;
  value: number;
  of: number;
  unit: string;
  off?: string;
  warnAbove?: number;
  good?: boolean;
}) {
  const ratio = of ? value / of : 0;
  const warn = warnAbove !== undefined && of > 0 && ratio > warnAbove;
  return (
    <div className="flex items-center gap-3">
      <span aria-hidden className={cn("flex size-8 shrink-0 items-center justify-center rounded-lg [&_svg]:size-4", warn ? "bg-warn-wash text-warn-ink" : "bg-s-3 text-text-2")}>
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-sm text-text">{label}</span>
          {off ? (
            <span className="text-xs text-text-3">{off}</span>
          ) : (
            <span className="flex items-baseline gap-2">
              <span className={cn("text-sm font-semibold tabular-nums", warn ? "text-warn-ink" : good && value ? "text-ok-ink" : "text-text-hi")}>{pct(value, of)}</span>
              <span className="text-xs text-text-3 tabular-nums">
                {formatNumber(value)} of {formatNumber(of)} {unit}
              </span>
            </span>
          )}
        </div>
        <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-s-3">
          {!off && of > 0 && (
            <div className={cn("h-full rounded-full", warn ? "bg-warn" : good ? "bg-ok" : "bg-accent")} style={{ width: `${Math.min(100, Math.max(value ? 2 : 0, ratio * 100))}%` }} />
          )}
        </div>
      </div>
    </div>
  );
}
