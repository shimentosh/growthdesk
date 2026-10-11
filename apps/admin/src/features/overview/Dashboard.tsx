"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { ArrowRight, Building2, CreditCard, LifeBuoy, RefreshCw, Settings, Users } from "lucide-react";
import { labelOf, SUBSCRIPTION_STATUSES } from "@growthdesk/shared";
import { Badge, statusTone, StatusBadge, type Tone } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Card, CardHeader } from "@/components/ui/Card";
import { ErrorState } from "@/components/ui/ErrorState";
import { Page, PageHeader } from "@/components/ui/PageHeader";
import { Skeleton } from "@/components/ui/Skeleton";
import { StatCard } from "@/components/ui/StatCard";
import { PLATFORM, PlatformTile, platformKey, type PlatformSection } from "@/features/common/platform";
import { MrrHeadline } from "@/features/revenue/MrrHeadline";
import type { AdminOverview } from "@/features/common/types";
import { cn } from "@/lib/cn";
import { formatNumber, formatPercent } from "@/lib/format";
import { useApiQuery } from "@/lib/query";
import { useFormat } from "@/lib/session";

/*
 * / — the state of the installation at a glance. Every number is a live count
 * from GET /admin/overview (refetched every minute); nothing here is estimated.
 */

type Row = { label: ReactNode; value: ReactNode; href?: string; tone?: "bad" | "warn" };

/** A titled card for one area: its tile, a link to the area, and label → value rows. */
function SectionCard({
  of,
  title,
  description,
  href,
  linkLabel = "Open",
  className,
  children,
}: {
  of: PlatformSection;
  title: string;
  description: string;
  href: string;
  linkLabel?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Card className={cn("flex flex-col", className)}>
      <CardHeader
        icon={<PlatformTile of={of} size="sm" />}
        title={title}
        description={description}
        actions={
          <Button size="sm" variant="ghost" href={href} iconRight={<ArrowRight />}>
            {linkLabel}
          </Button>
        }
      />
      <div className="flex flex-1 flex-col">{children}</div>
    </Card>
  );
}

function Rows({ rows, loading }: { rows: Row[]; loading: boolean }) {
  return (
    <dl className="divide-y divide-line">
      {rows.map((r, i) => (
        <div key={i} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
          <dt className="min-w-0 truncate text-text-2">{r.label}</dt>
          <dd className={cn("shrink-0 font-medium tabular-nums", r.tone === "bad" ? "text-bad-ink" : r.tone === "warn" ? "text-warn-ink" : "text-text-hi")}>
            {loading ? (
              <Skeleton className="h-4 w-10" />
            ) : r.href ? (
              <Link href={r.href} className="hover:underline">
                {r.value}
              </Link>
            ) : (
              r.value
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

const BAR: Record<Tone, string> = {
  ok: "bg-ok",
  live: "bg-accent",
  warn: "bg-warn",
  bad: "bg-bad",
  info: "bg-alt",
  mute: "bg-s-6",
};

/** Billing accounts by subscription state: a proportion bar, then each state with its count (a link to the filtered list). */
function SubscriptionMix({ data }: { data: AdminOverview | undefined }) {
  const states = [...SUBSCRIPTION_STATUSES, "none" as const];
  const counts = states.map((s) => ({ s, n: data?.billing.subscriptions[s] ?? 0 }));
  const total = counts.reduce((a, c) => a + c.n, 0);
  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex items-baseline gap-2">
        {data ? (
          <span className="text-2xl font-semibold tracking-[-0.025em] text-text-hi tabular-nums">{formatNumber(data.billing.accounts)}</span>
        ) : (
          <Skeleton className="h-7 w-16" />
        )}
        <span className="text-xs text-text-3">billing accounts</span>
      </div>
      {data && total > 0 ? (
        <div className="flex h-2.5 w-full gap-0.5 overflow-hidden rounded-full" role="img" aria-label="Subscriptions by state, shown in the list below">
          {counts
            .filter((c) => c.n > 0)
            .map((c) => (
              <span
                key={c.s}
                title={`${c.s === "none" ? "No subscription" : labelOf(c.s)}: ${formatNumber(c.n)} (${formatPercent(c.n / total, 0)})`}
                className={cn("h-full min-w-1 first:rounded-l-full last:rounded-r-full", BAR[c.s === "none" ? "mute" : statusTone(c.s)])}
                style={{ flexGrow: c.n }}
              />
            ))}
        </div>
      ) : (
        <div className="h-2.5 w-full rounded-full bg-s-3" />
      )}
      <ul className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
        {counts.map(({ s, n }) => (
          <li key={s} className="flex items-center justify-between gap-2 text-sm">
            {s === "none" ? <Badge dot>No subscription</Badge> : <StatusBadge value={s} label={labelOf(s)} />}
            {data ? (
              <span className="flex items-baseline gap-2">
                <span className="text-2xs text-text-3 tabular-nums">{total ? formatPercent(n / total, 0) : "—"}</span>
                <Link href={`/billing?status=${s}`} className="font-medium text-text-hi tabular-nums hover:underline">
                  {formatNumber(n)}
                </Link>
              </span>
            ) : (
              <Skeleton className="h-4 w-8" />
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function OnOff({ on, onLabel, offLabel, onTone, offTone }: { on: boolean; onLabel: string; offLabel: string; onTone: Tone; offTone: Tone }) {
  return (
    <Badge tone={on ? onTone : offTone} dot>
      {on ? onLabel : offLabel}
    </Badge>
  );
}

export function Dashboard() {
  const q = useApiQuery<AdminOverview>(platformKey("overview"), "/admin/overview", { refetchInterval: 60_000 });
  const f = useFormat();
  const d = q.data;
  const loading = q.isPending;
  const n = (v: number | undefined) => formatNumber(v ?? 0);
  const failed = d?.platformMail.failed24h ?? 0;
  const mailTotal = (d?.platformMail.sent24h ?? 0) + failed;

  return (
    <Page width="capped">
      <PageHeader
        icon={<PlatformTile of="overview" />}
        title="Dashboard"
        description="Customers, billing, support and platform mail across this installation."
        actions={
          <>
            {q.dataUpdatedAt > 0 && <span className="hidden text-xs text-text-3 sm:inline">Updated {f.relative(q.dataUpdatedAt)}</span>}
            <Button size="sm" icon={<RefreshCw />} loading={q.isFetching && !loading} onClick={() => void q.refetch()}>
              Refresh
            </Button>
          </>
        }
      />
      {q.isError && !d ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : (
        <div className="flex flex-col gap-5">
          {(d?.settings.maintenanceMode || (d && !d.settings.outreachEnabled)) && (
            <div className="flex flex-col gap-2">
              {d?.settings.maintenanceMode && (
                <Callout tone="warn" title="Maintenance mode is on" action={<Button size="sm" icon={<Settings />} href="/settings">Settings</Button>}>
                  Customers cannot change anything until it is switched off.
                </Callout>
              )}
              {d && !d.settings.outreachEnabled && (
                <Callout tone="warn" title="Outreach is paused" action={<Button size="sm" icon={<Settings />} href="/settings">Settings</Button>}>
                  Campaign emails are being held on every workspace.
                </Callout>
              )}
            </div>
          )}

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard
              label="Users"
              icon={<Users />}
              tint={PLATFORM.users.tint}
              href="/users"
              loading={loading}
              value={n(d?.users.total)}
              hint={d && `+${n(d.users.newThisWeek)} in the last 7 days`}
            />
            <StatCard
              label="Workspaces"
              icon={<Building2 />}
              tint={PLATFORM.workspaces.tint}
              href="/workspaces"
              loading={loading}
              value={n(d?.workspaces.total)}
              hint={d && `+${n(d.workspaces.newThisWeek)} in the last 7 days`}
            />
            <StatCard
              label="Active subscriptions"
              icon={<CreditCard />}
              tint={PLATFORM.billing.tint}
              href="/billing?status=active"
              loading={loading}
              value={n(d?.billing.subscriptions.active)}
              hint={d && `${n(d.billing.subscriptions.trialing)} trialing · ${n(d.billing.subscriptions.past_due)} past due`}
            />
            <StatCard
              label="Open support cases"
              icon={<LifeBuoy />}
              tint={PLATFORM.support.tint}
              href="/support"
              loading={loading}
              tone={d && d.support.open > 0 ? "warn" : undefined}
              value={n(d?.support.open)}
              hint={d && `${n(d.support.pending)} pending on the customer`}
            />
          </div>

          <MrrHeadline data={d} />

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            <SectionCard of="users" title="Customers" description="Accounts and workspaces." href="/users" linkLabel="Users">
              <Rows
                loading={loading}
                rows={[
                  { label: "Users", value: n(d?.users.total), href: "/users" },
                  { label: "New users (7 days)", value: n(d?.users.newThisWeek) },
                  { label: "Disabled accounts", value: n(d?.users.disabled), tone: d && d.users.disabled > 0 ? "warn" : undefined },
                  { label: "Platform staff", value: n(d?.users.staff) },
                  { label: "Workspaces", value: n(d?.workspaces.total), href: "/workspaces" },
                  { label: "New workspaces (7 days)", value: n(d?.workspaces.newThisWeek) },
                  { label: "Suspended workspaces", value: n(d?.workspaces.suspended), tone: d && d.workspaces.suspended > 0 ? "warn" : undefined },
                ]}
              />
            </SectionCard>

            <SectionCard of="billing" title="Billing" description="Billing accounts by the state of their subscription." href="/billing" linkLabel="Billing accounts" className="lg:col-span-2">
              <SubscriptionMix data={d} />
            </SectionCard>

            <SectionCard of="support" title="Support" description="Cases and workspaces letting support in." href="/support">
              <Rows
                loading={loading}
                rows={[
                  { label: "Open cases", value: n(d?.support.open), href: "/support", tone: d && d.support.open > 0 ? "warn" : undefined },
                  { label: "Pending cases", value: n(d?.support.pending) },
                  { label: "Workspaces granting access", value: n(d?.support.activeGrants) },
                ]}
              />
            </SectionCard>

            <SectionCard of="email" title="Email" description="The last 24 hours." href="/email" linkLabel="Delivery log">
              <Rows
                loading={loading}
                rows={[
                  { label: "Platform email sent", value: n(d?.platformMail.sent24h), href: "/email" },
                  { label: "Platform email failed", value: n(failed), href: "/email", tone: failed > 0 ? "bad" : undefined },
                  { label: "Failure rate", value: mailTotal ? formatPercent(failed / mailTotal) : "—", tone: failed > 0 ? "bad" : undefined },
                  { label: "Outreach messages sent", value: n(d?.outreach.messagesSent24h) },
                ]}
              />
              <p className="mt-auto border-t border-line px-4 py-2.5 text-2xs text-text-3">
                Platform email is verification, reset, invitation and notification mail. Outreach counts every workspace&apos;s outbound messages.
              </p>
            </SectionCard>

            <SectionCard of="settings" title="Platform status" description="Install-wide switches." href="/settings" linkLabel="Settings">
              <Rows
                loading={loading}
                rows={[
                  {
                    label: "Maintenance mode",
                    value: d && <OnOff on={d.settings.maintenanceMode} onLabel="On" offLabel="Off" onTone="warn" offTone="ok" />,
                  },
                  {
                    label: "Outreach",
                    value: d && <OnOff on={d.settings.outreachEnabled} onLabel="Sending" offLabel="Paused" onTone="ok" offTone="warn" />,
                  },
                  {
                    label: "Sign-ups",
                    value: d && <OnOff on={d.settings.signupsOpen} onLabel="Open" offLabel="Closed" onTone="ok" offTone="mute" />,
                  },
                ]}
              />
            </SectionCard>
          </div>
        </div>
      )}
    </Page>
  );
}
