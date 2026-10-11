"use client";

import Link from "next/link";
import { Building2, ChartPie, CreditCard, LifeBuoy, Mail, Send, Settings, Users } from "lucide-react";
import { labelOf, SUBSCRIPTION_STATUSES } from "@growthdesk/shared";
import { Badge, StatusBadge } from "@/components/ui/Badge";
import { Callout } from "@/components/ui/Callout";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { ErrorState } from "@/components/ui/ErrorState";
import { Page, PageHeader } from "@/components/ui/PageHeader";
import { StatCard } from "@/components/ui/StatCard";
import { Button } from "@/components/ui/Button";
import { formatNumber } from "@/lib/format";
import { useApiQuery } from "@/lib/query";
import type { AdminOverview } from "@/lib/types/platform";
import { PLATFORM, PlatformTile, platformKey } from "./common";

/** /admin — the state of the installation at a glance. Every number is a live count from the API. */
export function Overview() {
  const q = useApiQuery<AdminOverview>(platformKey("overview"), "/admin/overview", { refetchInterval: 60_000 });
  const d = q.data;
  const loading = q.isPending;

  return (
    <Page width="capped">
      <PageHeader icon={<PlatformTile of="overview" />} title="Overview" description="Customers, billing, support and platform mail across this installation." />
      {q.isError && !d ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : (
        <div className="flex flex-col gap-5">
          {d?.settings.maintenanceMode && (
            <Callout tone="warn" title="Maintenance mode is on" action={<Button size="sm" icon={<Settings />} href="/admin/settings">Settings</Button>}>
              Customers cannot change anything until it is switched off.
            </Callout>
          )}
          {d && !d.settings.outreachEnabled && (
            <Callout tone="warn" title="Outreach is paused" action={<Button size="sm" icon={<Settings />} href="/admin/settings">Settings</Button>}>
              Campaign emails are being held on every workspace.
            </Callout>
          )}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <StatCard label="Users" icon={<Users />} tint={PLATFORM.users.tint} href="/admin/users" loading={loading} value={formatNumber(d?.users.total ?? 0)} hint={d && `${formatNumber(d.users.newThisWeek)} new in 7 days · ${formatNumber(d.users.disabled)} disabled`} />
            <StatCard
              label="Workspaces"
              icon={<Building2 />}
              tint={PLATFORM.workspaces.tint}
              href="/admin/workspaces"
              loading={loading}
              value={formatNumber(d?.workspaces.total ?? 0)}
              hint={d && `${formatNumber(d.workspaces.newThisWeek)} new in 7 days · ${formatNumber(d.workspaces.suspended)} suspended`}
            />
            <StatCard label="Billing accounts" icon={<CreditCard />} tint={PLATFORM.billing.tint} href="/admin/billing" loading={loading} value={formatNumber(d?.billing.accounts ?? 0)} />
            <StatCard
              label="Open support cases"
              icon={<LifeBuoy />}
              tint={PLATFORM.support.tint}
              href="/admin/support"
              loading={loading}
              value={formatNumber(d?.support.open ?? 0)}
              hint={d && `${formatNumber(d.support.pending)} pending · ${formatNumber(d.support.activeGrants)} workspaces granting access`}
            />
            <StatCard label="Messages sent (24 h)" icon={<Send />} tint="blue" loading={loading} value={formatNumber(d?.outreach.messagesSent24h ?? 0)} hint="Outbound messages from every workspace" />
            <StatCard
              label="Platform email (24 h)"
              icon={<Mail />}
              tint={d && d.platformMail.failed24h > 0 ? "red" : PLATFORM.email.tint}
              href="/admin/email"
              loading={loading}
              tone={d && d.platformMail.failed24h > 0 ? "bad" : undefined}
              value={formatNumber(d?.platformMail.sent24h ?? 0)}
              hint={d && `${formatNumber(d.platformMail.failed24h)} failed — verification, reset, invitation and notification mail`}
            />
          </div>
          <Card>
            <CardHeader icon={<ChartPie />} title="Subscriptions by state" description="Billing accounts by the state of their subscription." />
            <CardBody>
              {d ? (
                <ul className="grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-4">
                  {[...SUBSCRIPTION_STATUSES, "none" as const].map((s) => (
                    <li key={s} className="flex items-center justify-between gap-2 text-sm">
                      {s === "none" ? <Badge dot>No subscription</Badge> : <StatusBadge value={s} label={labelOf(s)} />}
                      <Link href={`/admin/billing?status=${s}`} className="font-medium text-text-hi tabular-nums hover:underline">
                        {formatNumber(d.billing.subscriptions[s] ?? 0)}
                      </Link>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="h-12" />
              )}
            </CardBody>
          </Card>
        </div>
      )}
    </Page>
  );
}
