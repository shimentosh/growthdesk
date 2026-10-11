"use client";

import Link from "next/link";
import { useState } from "react";
import { PLATFORM_ROLES, type PlatformRole } from "@growthdesk/shared";
import { Avatar } from "@/components/ui/Avatar";
import { Badge } from "@/components/ui/Badge";
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
import type { AdminUserRow } from "@/lib/types/platform";
import { FilterBar, PLATFORM_ROLE_LABELS, PlatformRoleBadge, platformEmpty, PlatformTile, platformKey, table, TableFooter } from "./common";

const SCOPES = [
  { value: "all", label: "Everyone" },
  { value: "staff", label: "Platform staff" },
  { value: "disabled", label: "Disabled accounts" },
];

/** /admin/users — every account on the installation. */
export function UsersList() {
  const f = useFormat();
  const [q, setQ] = useState("");
  const [scope, setScope] = useState("all");
  const [role, setRole] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const list = useApiQuery<Paged<AdminUserRow>>(platformKey("users"), "/admin/users", {
    query: { q, scope, role: role || undefined, page, pageSize },
    keepPrevious: true,
  });

  return (
    <Page>
      <PageHeader icon={<PlatformTile of="users" />} title="Users" description="Every account on this installation. Open one to disable it, sign it out everywhere or change its platform role." />
      <FilterBar>
        <SearchInput
          value={q}
          onChange={(v) => {
            setQ(v);
            setPage(1);
          }}
          placeholder="Search name, email or id…"
          className="sm:w-72"
        />
        <NativeSelect
          aria-label="Show"
          value={scope}
          onChange={(e) => {
            setScope(e.target.value);
            setPage(1);
          }}
          options={SCOPES}
          className="w-48"
        />
        <NativeSelect
          aria-label="Platform role"
          value={role}
          onChange={(e) => {
            setRole(e.target.value);
            setPage(1);
          }}
          placeholder="Any platform role"
          options={PLATFORM_ROLES.map((r) => ({ value: r, label: PLATFORM_ROLE_LABELS[r] }))}
          className="w-44"
        />
      </FilterBar>
      <QueryState
        query={list}
        loading={<SkeletonText lines={8} />}
        isEmpty={(d) => d.total === 0}
        empty={
          <Card>
            <EmptyState {...platformEmpty("users")} title="No accounts match" description="Try another search or filter." />
          </Card>
        }
      >
        {(data) => (
          <Card className={cn("overflow-hidden", list.isPlaceholderData && "opacity-60")}>
            <div className={table.wrap}>
              <table className={table.table}>
                <thead>
                  <tr>
                    <th className={table.th}>Person</th>
                    <th className={table.th}>Platform role</th>
                    <th className={table.th}>Status</th>
                    <th className={table.th}>Workspaces</th>
                    <th className={table.th}>Last sign-in</th>
                    <th className={table.th}>Joined</th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((u) => (
                    <tr key={u.id} className="hover:bg-hover">
                      <td className={cn(table.td, "max-w-72")}>
                        <Link href={`/admin/users/${u.id}`} className="group flex min-w-0 items-center gap-2.5">
                          <Avatar name={u.name} email={u.email} size="sm" />
                          <span className="min-w-0">
                            <span className="block truncate font-medium group-hover:underline">{u.name || u.email}</span>
                            {u.name && <span className="block truncate text-xs text-text-3">{u.email}</span>}
                          </span>
                        </Link>
                      </td>
                      <td className={table.td}>
                        <PlatformRoleBadge role={u.platformRole as PlatformRole} />
                      </td>
                      <td className={table.td}>
                        {u.disabledAt ? (
                          <Badge tone="bad" dot>
                            Disabled
                          </Badge>
                        ) : u.emailVerified ? (
                          <Badge tone="ok" dot>
                            Active
                          </Badge>
                        ) : (
                          <Badge tone="warn" dot>
                            Email not confirmed
                          </Badge>
                        )}
                      </td>
                      <td className={cn(table.td, "tabular-nums")}>{u.workspaceCount}</td>
                      <td className={cn(table.td, "whitespace-nowrap text-text-2")}>{u.lastLoginAt ? f.relative(u.lastLoginAt) : "Never"}</td>
                      <td className={cn(table.td, "whitespace-nowrap text-text-2")}>{f.date(u.createdAt)}</td>
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
