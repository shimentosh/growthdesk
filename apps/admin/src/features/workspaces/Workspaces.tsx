"use client";

import Link from "next/link";
import { useState } from "react";
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
import type { AdminWorkspaceRow } from "@/features/common/types";
import { FilterBar, PersonCell, platformEmpty, PlatformTile, platformKey, table, TableFooter } from "@/features/common/platform";

/** /workspaces */
export function WorkspacesList() {
  const f = useFormat();
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const list = useApiQuery<Paged<AdminWorkspaceRow>>(platformKey("workspaces"), "/admin/workspaces", {
    query: { q, status: status || undefined, page, pageSize },
    keepPrevious: true,
  });

  return (
    <Page>
      <PageHeader icon={<PlatformTile of="workspaces" />} title="Workspaces" description="Every customer workspace. Open one for its plan usage, members and support access, or to suspend it." />
      <FilterBar>
        <SearchInput
          value={q}
          onChange={(v) => {
            setQ(v);
            setPage(1);
          }}
          placeholder="Search name, owner email or id…"
          className="sm:w-72"
        />
        <NativeSelect
          aria-label="Status"
          value={status}
          onChange={(e) => {
            setStatus(e.target.value);
            setPage(1);
          }}
          placeholder="Any status"
          options={[
            { value: "active", label: "Active" },
            { value: "suspended", label: "Suspended" },
          ]}
          className="w-40"
        />
      </FilterBar>
      <QueryState
        query={list}
        loading={<SkeletonText lines={8} />}
        isEmpty={(d) => d.total === 0}
        empty={
          <Card>
            <EmptyState {...platformEmpty("workspaces")} title="No workspaces match" description="Try another search or filter." />
          </Card>
        }
      >
        {(data) => (
          <Card className={cn("overflow-hidden", list.isPlaceholderData && "opacity-60")}>
            <div className={table.wrap}>
              <table className={table.table}>
                <thead>
                  <tr>
                    <th className={table.th}>Workspace</th>
                    <th className={table.th}>Status</th>
                    <th className={table.th}>Plan</th>
                    <th className={table.th}>Account owner</th>
                    <th className={table.th}>Members</th>
                    <th className={table.th}>Created</th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((w) => (
                    <tr key={w.id} className="hover:bg-hover">
                      <td className={cn(table.td, "max-w-72")}>
                        <Link href={`/workspaces/${w.id}`} className="block min-w-0 hover:underline">
                          <div className="truncate font-medium">{w.name}</div>
                          <div className="truncate text-xs text-text-3">{w.slug}</div>
                        </Link>
                      </td>
                      <td className={table.td}>
                        <StatusBadge value={w.status} />
                      </td>
                      <td className={table.td}>
                        {w.subscription ? (
                          <span className="flex flex-wrap items-center gap-1.5">
                            <span>{w.subscription.plan.name}</span>
                            <StatusBadge value={w.subscription.status} dot={false} />
                          </span>
                        ) : (
                          <Badge>No subscription</Badge>
                        )}
                      </td>
                      <td className={cn(table.td, "max-w-60")}>
                        <PersonCell person={w.billingAccount.owner} />
                      </td>
                      <td className={cn(table.td, "tabular-nums")}>{w.members}</td>
                      <td className={cn(table.td, "whitespace-nowrap text-text-2")}>{f.date(w.createdAt)}</td>
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
