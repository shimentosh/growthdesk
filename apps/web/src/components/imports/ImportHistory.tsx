"use client";

import Link from "next/link";
import { FileSpreadsheet, History } from "lucide-react";
import { labelOf } from "@growthdesk/shared";
import { Card, CardHeader } from "@/components/ui/Card";
import { COL } from "@/components/ui/columns";
import { StatusBadge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { QueryState } from "@/components/ui/ErrorState";
import { formatNumber } from "@/lib/format";
import { useApiQuery } from "@/lib/query";
import { useFormat, useWorkspace } from "@/lib/session";
import type { ImportSummary } from "@/lib/types/imports";
import { IMPORT_POLL_MS, isActiveImport, useRefreshWhenImportsFinish } from "./hooks";
import { Table, Td, Th } from "./Table";

const count = (n: number, tone?: string) => (n ? <span className={tone}>{formatNumber(n)}</span> : <span className="text-text-3">0</span>);

/** The workspace's last 100 imports (the API keeps no longer list), refreshing while any is running. */
export function ImportHistory() {
  const ws = useWorkspace();
  const f = useFormat();
  // Two observers of one cached query: the first reads what is running, the second polls only while something is.
  const cached = useApiQuery<ImportSummary[]>(ws.key("imports", "list"), ws.path("/imports"));
  const activeIds = (cached.data ?? []).filter((i) => isActiveImport(i.status)).map((i) => i.id);
  const list = useApiQuery<ImportSummary[]>(ws.key("imports", "list"), ws.path("/imports"), { refetchInterval: activeIds.length ? IMPORT_POLL_MS : false });
  useRefreshWhenImportsFinish(activeIds);

  return (
    <Card>
      <CardHeader icon={<History />} title="Import history" description="The last 100 imports, newest first." />
      <QueryState
        query={list}
        isEmpty={(d) => d.length === 0}
        empty={<EmptyState compact icon={<History />} title="No imports yet" description="Imports you start appear here with their progress and results." />}
      >
        {(rows) => (
          <Table>
            <thead>
              <tr>
                <Th icon={COL.file}>File</Th>
                <Th icon={COL.status}>Status</Th>
                <Th align="right" icon={COL.rows}>
                  Rows
                </Th>
                <Th align="right" icon={COL.count}>
                  Created
                </Th>
                <Th align="right" className="hidden sm:table-cell" icon={COL.count}>
                  Updated
                </Th>
                <Th align="right" className="hidden sm:table-cell" icon={COL.skipped}>
                  Skipped
                </Th>
                <Th align="right" icon={COL.failed}>
                  Failed
                </Th>
                <Th className="hidden md:table-cell" icon={COL.date}>
                  Started
                </Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const active = isActiveImport(r.status);
                return (
                  <tr key={r.id} className="hover:bg-hover">
                    <Td className="max-w-72">
                      <Link href={ws.href(`/imports/${r.id}`)} className="group flex min-w-0 items-center gap-2">
                        <FileSpreadsheet aria-hidden className="size-4 shrink-0 text-text-3" />
                        <span className="min-w-0">
                          <span className="block truncate font-medium text-text group-hover:text-accent-hi">{r.fileName || "Untitled import"}</span>
                          {r.source !== "csv" && <span className="block text-xs text-text-3">{labelOf(r.source)}</span>}
                        </span>
                      </Link>
                    </Td>
                    <Td>
                      <StatusBadge value={r.status} />
                    </Td>
                    <Td align="right" className="whitespace-nowrap">
                      {active ? (
                        <span className="text-text-2">
                          {formatNumber(r.processedRows)} / {formatNumber(r.totalRows)}
                        </span>
                      ) : (
                        formatNumber(r.totalRows)
                      )}
                    </Td>
                    <Td align="right">{count(r.createdCount, "text-ok-ink")}</Td>
                    <Td align="right" className="hidden sm:table-cell">
                      {count(r.updatedCount)}
                    </Td>
                    <Td align="right" className="hidden sm:table-cell">
                      {count(r.skippedCount)}
                    </Td>
                    <Td align="right">{count(r.failedCount, "font-medium text-bad-ink")}</Td>
                    <Td className="hidden whitespace-nowrap text-text-2 md:table-cell" title={f.dateTime(r.createdAt)}>
                      {f.smart(r.createdAt)}
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </QueryState>
    </Card>
  );
}
