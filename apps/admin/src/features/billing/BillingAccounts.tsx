"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { labelOf, SUBSCRIPTION_STATUSES } from "@growthdesk/shared";
import { Badge, StatusBadge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { QueryState } from "@/components/ui/ErrorState";
import { NativeSelect } from "@/components/ui/Input";
import { Page, PageHeader } from "@/components/ui/PageHeader";
import { Pagination } from "@/components/ui/Pagination";
import { SearchInput } from "@/components/ui/SearchInput";
import { SkeletonText } from "@/components/ui/Skeleton";
import { cn } from "@/lib/cn";
import { useApiQuery } from "@/lib/query";
import { useFormat } from "@/lib/session";
import type { Paged } from "@/lib/types";
import type { AdminBillingAccountRow } from "@/features/common/types";
import { FilterBar, PersonCell, platformEmpty, PlatformTile, platformKey, providerLabel, table, TableFooter } from "@/features/common/platform";

/** /billing — paying customers (billing accounts) and their subscriptions. */
export function BillingAccountsList() {
  const f = useFormat();
  const params = useSearchParams();
  const [q, setQ] = useState("");
  const [status, setStatus] = useState(params.get("status") ?? "");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const list = useApiQuery<Paged<AdminBillingAccountRow>>(platformKey("billing-accounts"), "/admin/billing-accounts", {
    query: { q, status: status || undefined, page, pageSize },
    keepPrevious: true,
  });

  return (
    <Page>
      <PageHeader
        icon={<PlatformTile of="billing" />}
        title="Billing accounts"
        description="The paying customer behind one or more workspaces. Plans change from verified payment-provider events; manual plans are for invoiced customers."
      />
      <FilterBar>
        <SearchInput
          value={q}
          onChange={(v) => {
            setQ(v);
            setPage(1);
          }}
          placeholder="Search name, email, workspace or id…"
          className="sm:w-72"
        />
        <NativeSelect
          aria-label="Subscription state"
          value={status}
          onChange={(e) => {
            setStatus(e.target.value);
            setPage(1);
          }}
          placeholder="Any state"
          options={[...SUBSCRIPTION_STATUSES.map((s) => ({ value: s, label: labelOf(s) })), { value: "none", label: "No subscription" }]}
          className="w-44"
        />
      </FilterBar>
      <QueryState
        query={list}
        loading={<SkeletonText lines={8} />}
        isEmpty={(d) => d.total === 0}
        empty={
          <Card>
            <EmptyState {...platformEmpty("billing")} title="No billing accounts match" description="Try another search or filter." />
          </Card>
        }
      >
        {(data) => (
          <Card className={cn("overflow-hidden", list.isPlaceholderData && "opacity-60")}>
            <div className={table.wrap}>
              <table className={table.table}>
                <thead>
                  <tr>
                    <th className={table.th}>Account</th>
                    <th className={table.th}>Owner</th>
                    <th className={table.th}>Plan</th>
                    <th className={table.th}>State</th>
                    <th className={table.th}>Paid through</th>
                    <th className={table.th}>Workspaces</th>
                    <th className={table.th}>Renews / ends</th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((a) => (
                    <tr key={a.id} className="hover:bg-hover">
                      <td className={cn(table.td, "max-w-64")}>
                        <Link href={`/billing/${a.id}`} className="block min-w-0 hover:underline">
                          <div className="truncate font-medium">{a.name}</div>
                          {a.billingEmail && <div className="truncate text-xs text-text-3">{a.billingEmail}</div>}
                        </Link>
                      </td>
                      <td className={cn(table.td, "max-w-60")}>
                        <PersonCell person={a.owner} />
                      </td>
                      <td className={table.td}>{a.subscription?.plan.name ?? "—"}</td>
                      <td className={table.td}>{a.subscription ? <StatusBadge value={a.subscription.status} /> : <Badge>None</Badge>}</td>
                      <td className={cn(table.td, "text-text-2")}>{a.subscription ? providerLabel(a.subscription.provider) : "—"}</td>
                      <td className={cn(table.td, "tabular-nums")}>{a.workspaces}</td>
                      <td className={cn(table.td, "whitespace-nowrap text-text-2")}>
                        {a.subscription?.status === "trialing" && a.subscription.trialEndsAt
                          ? `Trial ends ${f.date(a.subscription.trialEndsAt)}`
                          : a.subscription?.currentPeriodEnd
                            ? f.date(a.subscription.currentPeriodEnd)
                            : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <TableFooter>
              <Pagination
                page={data.page}
                pageSize={data.pageSize}
                total={data.total}
                onPageChange={setPage}
                onPageSizeChange={(s) => {
                  setPageSize(s);
                  setPage(1);
                }}
              />
            </TableFooter>
          </Card>
        )}
      </QueryState>
    </Page>
  );
}
