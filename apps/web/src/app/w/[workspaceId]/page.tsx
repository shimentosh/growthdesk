"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import {
  AlarmClock,
  CalendarCheck2,
  CalendarClock,
  CalendarDays,
  Check,
  CheckCheck,
  CheckSquare,
  ChevronRight,
  CircleDashed,
  Handshake,
  ListChecks,
  MessageSquareReply,
  Rocket,
  Upload,
  UserX,
  X,
} from "lucide-react";
import { labelOf, type Channel } from "@growthdesk/shared";
import { Button, IconButton } from "@/components/ui/Button";
import { Card, CardHeader } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { QueryState } from "@/components/ui/ErrorState";
import { CHANNEL, EntityTile } from "@/components/ui/icons";
import { Page, PageHeader } from "@/components/ui/PageHeader";
import { SkeletonText } from "@/components/ui/Skeleton";
import { StatCard } from "@/components/ui/StatCard";
import { cn } from "@/lib/cn";
import { useApiMutation, useApiQuery } from "@/lib/query";
import {
  useFormat,
  useMe,
  useWorkspace,
  workspaceDetailKey,
} from "@/lib/session";
import type { TaskSummary } from "@/lib/types";
import {
  ActivityCard,
  KpiTiles,
  PipelineCard,
  RevenueEngine,
  TopCampaigns,
} from "@/components/home/SalesMachine";

/** Getting started: the four steps the API tracks, until every one is done or the person hides it. */
function OnboardingChecklist() {
  const ws = useWorkspace();
  const dismiss = useApiMutation({
    path: ws.path("/onboarding/dismiss"),
    invalidate: [workspaceDetailKey(ws.id)],
  });
  const { steps, dismissed } = ws.onboarding;
  const all: {
    key: keyof typeof steps;
    label: string;
    href?: string;
    permission?: string;
  }[] = [
    {
      key: "mailbox",
      label: "Connect a mailbox",
      href: "/settings/mailboxes",
      permission: "integrations.manage",
    },
    {
      key: "contacts",
      label: "Add or import contacts",
      href: "/imports",
      permission: "contacts.import",
    },
    {
      key: "campaign",
      label: "Launch your first campaign",
      href: "/campaigns",
      permission: "campaigns.write",
    },
    {
      key: "team",
      label: "Invite a teammate",
      href: "/settings/members",
      permission: "members.manage",
    },
  ];
  const done = all.filter((s) => steps[s.key]).length;
  if (dismissed || done === all.length) return null;

  return (
    <Card className="mb-5">
      <CardHeader
        title="Get set up"
        icon={<ListChecks />}
        description={`${done} of ${all.length} done`}
        actions={
          <IconButton
            size="sm"
            label="Hide checklist"
            icon={<X />}
            onClick={() => dismiss.mutate()}
            disabled={dismiss.isPending}
          />
        }
      />
      <ul className="grid gap-px sm:grid-cols-2">
        {all.map((s) => {
          const complete = steps[s.key];
          const actionable =
            !complete && s.href && (!s.permission || ws.can(s.permission));
          const body = (
            <>
              <span
                aria-hidden
                className={cn(
                  "flex size-5 shrink-0 items-center justify-center rounded-full",
                  complete
                    ? "bg-ok text-white"
                    : "border border-line-strong text-text-3",
                )}
              >
                {complete ? (
                  <Check className="size-3" strokeWidth={3} />
                ) : (
                  <CircleDashed className="size-3" />
                )}
              </span>
              <span
                className={cn(
                  "text-sm",
                  complete ? "text-text-3 line-through" : "text-text",
                )}
              >
                {s.label}
              </span>
              <span className="sr-only">
                {complete ? "(done)" : "(not done)"}
              </span>
            </>
          );
          return (
            <li key={s.key}>
              {actionable ? (
                <Link
                  href={ws.href(s.href)}
                  className="flex items-center gap-2.5 px-4 py-3 hover:bg-hover"
                >
                  {body}
                </Link>
              ) : (
                <div className="flex items-center gap-2.5 px-4 py-3">
                  {body}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

function ListCard<T>({
  title,
  icon,
  items,
  empty,
  render,
  action,
}: {
  title: string;
  icon: ReactNode;
  items: T[];
  /** What an empty list means, said as good news ("No stalled deals."). */
  empty: string;
  render: (item: T) => ReactNode;
  action?: ReactNode;
}) {
  return (
    <Card>
      <CardHeader
        icon={icon}
        title={
          <span className="flex items-center gap-2">
            {title}
            {items.length > 0 && (
              <span className="rounded-xs bg-mute-chip px-1.5 text-2xs text-text-2 tabular-nums">
                {items.length}
              </span>
            )}
          </span>
        }
        actions={action}
      />
      {items.length === 0 ? (
        <EmptyState
          compact
          icon={<CheckCheck />}
          title="All clear"
          description={empty}
          className="py-6"
        />
      ) : (
        <ul className="divide-y divide-line">{items.map(render)}</ul>
      )}
    </Card>
  );
}

/** Good morning / afternoon / evening, by the viewer's own clock. */
function greeting(now = new Date()) {
  const h = now.getHours();
  return h < 5
    ? "Good evening"
    : h < 12
      ? "Good morning"
      : h < 18
        ? "Good afternoon"
        : "Good evening";
}

const rowClass =
  "flex items-center justify-between gap-3 px-4 py-2.5 hover:bg-hover";

export default function WorkspaceHome() {
  const ws = useWorkspace();
  const me = useMe();
  const f = useFormat();
  const canTasks = ws.can("tasks.read");
  const canAnalytics = ws.can("analytics.read");
  const summary = useApiQuery<TaskSummary>(
    ws.key("tasks", "summary"),
    canTasks ? ws.path("/tasks/summary") : null,
    { refetchInterval: 120_000 },
  );
  const firstName = me.data?.user.name.split(" ")[0];
  const s = summary.data;

  /** A summary list, a skeleton while the summary loads (the cards keep their place). */
  const summaryList = (card: (s: TaskSummary) => ReactNode) =>
    s ? (
      card(s)
    ) : summary.isError ? null : (
      <Card className="p-4">
        <SkeletonText lines={4} />
      </Card>
    );

  const replies = (s: TaskSummary) => (
    <ListCard
      title="Waiting on your reply"
      icon={<MessageSquareReply />}
      items={s.unansweredReplies}
      empty="No unanswered replies."
      action={
        ws.can("inbox.read") ? (
          <Button
            size="sm"
            variant="ghost"
            iconRight={<ChevronRight />}
            href={ws.href("/inbox")}
          >
            Inbox
          </Button>
        ) : undefined
      }
      render={(r) => {
        const ChannelIcon =
          CHANNEL[r.channel as Channel]?.icon ?? MessageSquareReply;
        const inner = (
          <>
            <span className="min-w-0">
              <span className="block truncate text-sm text-text">
                {r.contact?.fullName || r.displayName || r.handle}
              </span>
              <span className="flex min-w-0 items-center gap-1 text-xs text-text-3">
                <ChannelIcon aria-hidden className="size-3 shrink-0" />
                <span className="truncate">
                  {labelOf(r.channel)}
                  {r.subject ? ` · ${r.subject}` : ""}
                </span>
              </span>
            </span>
            <span className="shrink-0 text-xs text-text-3">
              {f.relative(r.lastInboundAt)}
            </span>
          </>
        );
        // The conversation in the inbox; without inbox access, the contact's record.
        const href = ws.can("inbox.read")
          ? ws.href(`/inbox?c=${r.id}`)
          : r.contact
            ? ws.href(`/contacts/${r.contact.id}`)
            : null;
        return (
          <li key={r.id}>
            {href ? (
              <Link href={href} className={rowClass}>
                {inner}
              </Link>
            ) : (
              <div className={rowClass}>{inner}</div>
            )}
          </li>
        );
      }}
    />
  );

  return (
    <Page width="capped">
      <PageHeader
        icon={<EntityTile of="home" />}
        title={firstName ? `${greeting()}, ${firstName}` : "Home"}
        description={`${ws.name} · ${f.date(new Date(), "long")}`}
        actions={
          <>
            {ws.can("contacts.import") && (
              <Button href={ws.href("/imports")} icon={<Upload />}>
                Import leads
              </Button>
            )}
            {ws.can("campaigns.write") && (
              <Button
                variant="primary"
                href={ws.href("/campaigns")}
                icon={<Rocket />}
              >
                Launch campaign
              </Button>
            )}
          </>
        }
      />

      <OnboardingChecklist />

      <div className="flex flex-col gap-5">
        {canAnalytics && (
          <>
            <KpiTiles />
            <RevenueEngine />
            <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
              <div className="min-w-0 lg:col-span-2">
                <ActivityCard />
              </div>
              <PipelineCard />
            </div>
            <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-2">
              <TopCampaigns />
              {canTasks && summaryList(replies)}
            </div>
          </>
        )}

        {canTasks ? (
          <section aria-labelledby="your-day" className="flex flex-col gap-3">
            <div className="mt-2 flex items-center justify-between gap-3">
              <h2
                id="your-day"
                className="flex items-center gap-2 text-sm font-semibold text-text-hi"
              >
                <CalendarCheck2 aria-hidden className="size-4 text-text-3" />
                Your day
              </h2>
              <Button
                size="sm"
                variant="ghost"
                iconRight={<ChevronRight />}
                href={ws.href("/tasks")}
              >
                All tasks
              </Button>
            </div>
            {summary.isError ? (
              <QueryState query={summary}>{() => null}</QueryState>
            ) : (
              <>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <StatCard
                    label="Due today"
                    value={s?.counts.today}
                    loading={!s}
                    icon={<CheckSquare />}
                    tint="orange"
                    href={ws.href("/tasks?view=today")}
                  />
                  <StatCard
                    label="Overdue"
                    value={s?.counts.overdue}
                    loading={!s}
                    icon={<AlarmClock />}
                    tint="red"
                    tone={s && s.counts.overdue > 0 ? "bad" : undefined}
                    href={ws.href("/tasks?view=overdue")}
                  />
                  <StatCard
                    label="Upcoming"
                    value={s?.counts.upcoming}
                    loading={!s}
                    icon={<CalendarClock />}
                    tint="blue"
                    href={ws.href("/tasks?view=upcoming")}
                  />
                </div>

                <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
                  {!canAnalytics && summaryList(replies)}
                  {summaryList((s) => (
                    <ListCard
                      title="Upcoming meetings"
                      icon={<CalendarDays />}
                      items={s.upcomingMeetings}
                      empty="No meetings scheduled."
                      action={
                        <Button
                          size="sm"
                          variant="ghost"
                          iconRight={<ChevronRight />}
                          href={ws.href("/meetings")}
                        >
                          Meetings
                        </Button>
                      }
                      render={(m) => (
                        <li key={m.id}>
                          <Link
                            href={ws.href(
                              m.contact
                                ? `/contacts/${m.contact.id}`
                                : "/meetings",
                            )}
                            className={rowClass}
                          >
                            <span className="min-w-0">
                              <span className="block truncate text-sm text-text">
                                {m.title}
                              </span>
                              {m.contact?.fullName && (
                                <span className="block truncate text-xs text-text-3">
                                  {m.contact.fullName}
                                </span>
                              )}
                            </span>
                            <span className="shrink-0 text-xs text-text-3">
                              {f.smart(m.startsAt)}
                            </span>
                          </Link>
                        </li>
                      )}
                    />
                  ))}
                  {summaryList((s) => (
                    <ListCard
                      title="No next step"
                      icon={<UserX />}
                      items={s.noNextAction}
                      empty="Every active contact has a task or sequence."
                      render={(c) => (
                        <li key={c.id}>
                          <Link
                            href={ws.href(`/contacts/${c.id}`)}
                            className={rowClass}
                          >
                            <span className="min-w-0">
                              <span className="block truncate text-sm text-text">
                                {c.fullName || c.email || "Unnamed contact"}
                              </span>
                              {c.email && c.fullName && (
                                <span className="block truncate text-xs text-text-3">
                                  {c.email}
                                </span>
                              )}
                            </span>
                            <span className="shrink-0 text-xs text-text-3">
                              {labelOf(c.status)}
                            </span>
                          </Link>
                        </li>
                      )}
                    />
                  ))}
                  {summaryList((s) => (
                    <ListCard
                      title="Deals gone quiet"
                      icon={<Handshake />}
                      items={s.inactiveDeals}
                      empty="No stalled deals."
                      render={(d) => (
                        <li key={d.id}>
                          <Link
                            href={ws.href(`/deals/${d.id}`)}
                            className={rowClass}
                          >
                            <span className="min-w-0">
                              <span className="block truncate text-sm text-text">
                                {d.name}
                              </span>
                              <span className="block truncate text-xs text-text-3">
                                Last change {f.relative(d.updatedAt)}
                              </span>
                            </span>
                            <span className="shrink-0 text-sm text-text tabular-nums">
                              {f.money(d.value, d.currency)}
                            </span>
                          </Link>
                        </li>
                      )}
                    />
                  ))}
                </div>
              </>
            )}
          </section>
        ) : (
          !canAnalytics && (
            <Card className="p-6 text-sm text-text-2">
              Your role does not include tasks or reports, so there is nothing
              to summarise here yet.
            </Card>
          )
        )}
      </div>
    </Page>
  );
}
