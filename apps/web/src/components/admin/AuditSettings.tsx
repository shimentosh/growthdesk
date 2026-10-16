"use client";

import { useState } from "react";
import { ScrollText } from "lucide-react";
import { labelOf } from "@growthdesk/shared";
import { Card } from "@/components/ui/Card";
import { COL, ColumnLabel } from "@/components/ui/columns";
import { EmptyState } from "@/components/ui/EmptyState";
import { EntityTile } from "@/components/ui/icons";
import { QueryState } from "@/components/ui/ErrorState";
import { PageHeader } from "@/components/ui/PageHeader";
import { Pagination } from "@/components/ui/Pagination";
import { RequirePermission } from "@/components/ui/RequirePermission";
import { SkeletonText } from "@/components/ui/Skeleton";
import { cn } from "@/lib/cn";
import { useApiQuery } from "@/lib/query";
import { useFormat, useWorkspace } from "@/lib/session";
import type { Paged } from "@/lib/types";
import type { AuditEventRow } from "@/lib/types/admin";
import { describeAction, table } from "./labels";

const ACTOR_TYPES: Record<string, string> = {
  platform_admin: "Growthdesk support",
  api_key: "API key",
  system: "System",
};

/** A metadata value, short enough for one table cell. */
function show(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (Array.isArray(value)) return value.map(show).join(", ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function Details({ metadata }: { metadata: Record<string, unknown> }) {
  const entries = Object.entries(metadata ?? {});
  if (!entries.length) return <span className="text-text-3">—</span>;
  return (
    <dl className="flex flex-col gap-0.5 text-xs">
      {entries.slice(0, 4).map(([k, v]) => (
        <div key={k} className="flex min-w-0 gap-1.5">
          <dt className="shrink-0 text-text-3">{labelOf(k)}</dt>
          <dd className="min-w-0 truncate text-text-2" title={show(v)}>
            {show(v)}
          </dd>
        </div>
      ))}
      {entries.length > 4 && <div className="text-text-3">+{entries.length - 4} more</div>}
    </dl>
  );
}

/** Settings → Audit log: who changed what in the workspace, newest first. */
export function AuditSettings() {
  const ws = useWorkspace();
  const f = useFormat();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const log = useApiQuery<Paged<AuditEventRow>>(ws.key("audit"), ws.path("/audit"), { query: { page, pageSize }, keepPrevious: true });

  return (
    <RequirePermission permission="audit.read">
      <PageHeader icon={<EntityTile of="audit" />} title="Audit log" description="Security and administration events in this workspace, newest first. Times are in the workspace time zone." />
      <QueryState
        query={log}
        loading={<SkeletonText lines={8} />}
        isEmpty={(d) => d.total === 0}
        empty={
          <Card>
            <EmptyState compact icon={<ScrollText />} tint="brown" title="Nothing recorded yet" description="Changes to members, roles, settings and billing will be listed here." />
          </Card>
        }
      >
        {(data) => (
          <div className="flex flex-col gap-3">
            <Card className={cn(log.isPlaceholderData && "opacity-60")}>
              <div className={table.wrap}>
                <table className={table.table}>
                  <thead>
                    <tr>
                      <th className={table.th}><ColumnLabel icon={COL.updated}>When</ColumnLabel></th>
                      <th className={table.th}><ColumnLabel icon={COL.person}>Who</ColumnLabel></th>
                      <th className={table.th}><ColumnLabel icon={COL.activity}>What</ColumnLabel></th>
                      <th className={table.th}><ColumnLabel icon={COL.details}>Details</ColumnLabel></th>
                      <th className={table.th}><ColumnLabel icon={COL.ip}>IP address</ColumnLabel></th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.items.map((e) => (
                      <tr key={e.id} className="align-top">
                        <td className={cn(table.td, "align-top whitespace-nowrap text-text-2")} title={f.dateTime(e.createdAt)}>
                          {f.dateTime(e.createdAt)}
                        </td>
                        <td className={cn(table.td, "max-w-56 align-top")}>
                          {e.actor ? (
                            <>
                              <div className="truncate">{e.actor.name || e.actor.email}</div>
                              {e.actor.name && <div className="truncate text-xs text-text-3">{e.actor.email}</div>}
                            </>
                          ) : (
                            <span className="text-text-2">{ACTOR_TYPES[e.actorType] ?? labelOf(e.actorType || "unknown")}</span>
                          )}
                        </td>
                        <td className={cn(table.td, "align-top")}>
                          <div className="font-medium whitespace-nowrap" title={e.action}>
                            {describeAction(e.action)}
                          </div>
                          {e.targetType && (
                            <div className="text-xs text-text-3">
                              {labelOf(e.targetType)}
                              {e.targetId && <span className="ml-1 font-mono" title={e.targetId}>{e.targetId.length > 12 ? `${e.targetId.slice(0, 8)}…` : e.targetId}</span>}
                            </div>
                          )}
                        </td>
                        <td className={cn(table.td, "max-w-72 align-top")}>
                          <Details metadata={e.metadata} />
                        </td>
                        <td className={cn(table.td, "align-top font-mono text-xs whitespace-nowrap text-text-3")}>{e.ip || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
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
          </div>
        )}
      </QueryState>
    </RequirePermission>
  );
}
