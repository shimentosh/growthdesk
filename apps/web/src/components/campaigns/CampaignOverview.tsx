"use client";

import type { UseQueryResult } from "@tanstack/react-query";
import { Activity, CircleAlert, CircleCheck, ClipboardCheck, ListOrdered, MailOpen, MailX, MousePointerClick, Reply, Send, Settings2, UserMinus, Users } from "lucide-react";
import { labelOf } from "@growthdesk/shared";
import { Callout } from "@/components/ui/Callout";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { KeyValueList } from "@/components/ui/KeyValue";
import { SkeletonText } from "@/components/ui/Skeleton";
import { StatCard } from "@/components/ui/StatCard";
import { StepTile, stepSummary } from "@/components/sequences/StepsEditor";
import type { ApiError } from "@/lib/api";
import { cn } from "@/lib/cn";
import { formatNumber } from "@/lib/format";
import { useApiQuery } from "@/lib/query";
import { useFormat, useWorkspace } from "@/lib/session";
import type { CampaignDetail, CampaignReadiness, StepStats } from "@/lib/types/campaigns";
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
  const readiness = useApiQuery<CampaignReadiness>(ws.key("campaigns", campaign.id, "readiness"), isDraft ? ws.path(`/campaigns/${campaign.id}/readiness`) : null);
  const stepStats = useApiQuery<StepStats[]>(ws.key("campaigns", campaign.id, "step-stats"), isDraft ? null : ws.path(`/campaigns/${campaign.id}/step-stats`));
  const enrollmentsHref = (status?: string) => ws.href(`/campaigns/${campaign.id}?tab=enrollments${status ? `&status=${status}` : ""}`);
  const tracking = campaign.settings.trackOpens || campaign.settings.trackClicks;

  return (
    <div className="flex flex-col gap-4">
      {isDraft && <Readiness query={readiness} />}

      {!isDraft && (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatCard label="Enrolled" icon={<Users />} tint="indigo" value={formatNumber(s.enrolled)} href={enrollmentsHref()} />
            <StatCard
              label="Active"
              icon={<Activity />}
              tint="cyan"
              value={formatNumber(e.active)}
              hint={e.paused ? `${formatNumber(e.paused)} paused` : undefined}
              href={enrollmentsHref("active")}
            />
            <StatCard label="Completed" icon={<CircleCheck />} tint="teal" value={formatNumber(e.completed)} href={enrollmentsHref("completed")} />
            <StatCard label="Messages sent" icon={<Send />} tint="blue" value={formatNumber(s.sent)} />
            <StatCard label="Replied" icon={<Reply />} tint="green" value={formatNumber(s.replied)} tone={s.replied ? "ok" : undefined} />
            <StatCard label="Bounced" icon={<MailX />} tint="orange" value={formatNumber(s.bounced)} tone={s.bounced ? "warn" : undefined} />
            <StatCard label="Unsubscribed" icon={<UserMinus />} tint="gray" value={formatNumber(s.unsubscribed)} />
            <StatCard label="Failed" icon={<CircleAlert />} tint="red" value={formatNumber(s.failed)} tone={s.failed ? "bad" : undefined} href={enrollmentsHref("failed")} />
          </div>
          {tracking ? (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <StatCard
                label="Opened"
                icon={<MailOpen />}
                tint="blue"
                value={campaign.settings.trackOpens ? formatNumber(s.opened) : "—"}
                hint={campaign.settings.trackOpens ? "Messages with an open recorded" : "Open tracking is off"}
              />
              <StatCard
                label="Clicked"
                icon={<MousePointerClick />}
                tint="purple"
                value={campaign.settings.trackClicks ? formatNumber(s.clicked) : "—"}
                hint={campaign.settings.trackClicks ? "Messages with a click recorded" : "Click tracking is off"}
              />
            </div>
          ) : null}
          {s.updatedAt && <p className="-mt-1 text-xs text-text-3">Counted {f.relative(s.updatedAt)}. Stopped: {formatNumber(e.stopped)}.</p>}
        </>
      )}

      <Card>
        <CardHeader icon={<Settings2 />} title="Setup" />
        <CardBody>
          <KeyValueList
            columns={2}
            items={[
              { label: "Audience", value: campaign.audienceDescription },
              { label: "Steps", value: plural(campaign.stepCount, "step") },
              { label: "Send window", value: scheduleLine(campaign.schedule) },
              {
                label: "Mailboxes",
                value: campaign.mailboxes.length ? campaign.mailboxes.map((m) => m.email).join(", ") : "Any connected mailbox in the workspace",
              },
              { label: "New contacts per day", value: formatNumber(campaign.settings.dailyNewLimit) },
              { label: "Owner", value: campaign.owner?.name || campaign.owner?.email || "—" },
              ...(campaign.startAt ? [{ label: "Start", value: f.dateTime(campaign.startAt) }] : []),
              ...(campaign.startedAt ? [{ label: "Started", value: f.dateTime(campaign.startedAt) }] : []),
              ...(campaign.pausedAt && campaign.status === "paused" ? [{ label: "Paused", value: f.dateTime(campaign.pausedAt) }] : []),
              ...(campaign.completedAt ? [{ label: "Completed", value: f.dateTime(campaign.completedAt) }] : []),
              ...(campaign.canceledAt ? [{ label: "Stopped", value: f.dateTime(campaign.canceledAt) }] : []),
            ]}
          />
        </CardBody>
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
                    {["Step", "Waiting", "Done", "Skipped", "Failed", "Unclear", "Sent", "Opened", "Clicked", "Bounced"].map((h, i) => (
                      <th key={h} scope="col" className={cn("h-8 px-3 text-xs font-medium whitespace-nowrap text-text-3", i ? "text-right" : "text-left")}>
                        {h}
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
                              {step && <span className="block truncate text-xs text-text-3">{stepSummary(step)}</span>}
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
