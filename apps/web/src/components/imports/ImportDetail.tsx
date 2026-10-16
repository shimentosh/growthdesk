"use client";

import { useMemo, useState } from "react";
import { CircleCheck, CircleX, Columns3, RefreshCw, SearchX, Settings2, SkipForward, TriangleAlert, UserPlus, UserPen, Users } from "lucide-react";
import { labelOf } from "@growthdesk/shared";
import { Button } from "@/components/ui/Button";
import { StatusBadge } from "@/components/ui/Badge";
import { Callout } from "@/components/ui/Callout";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { COL } from "@/components/ui/columns";
import { EmptyState } from "@/components/ui/EmptyState";
import { QueryState } from "@/components/ui/ErrorState";
import { EntityTile } from "@/components/ui/icons";
import { KeyValueList } from "@/components/ui/KeyValue";
import { Meter } from "@/components/ui/Meter";
import { PageHeader } from "@/components/ui/PageHeader";
import { SearchInput } from "@/components/ui/SearchInput";
import { SkeletonText } from "@/components/ui/Skeleton";
import { StatCard } from "@/components/ui/StatCard";
import { formatNumber, toDate } from "@/lib/format";
import { useApiMutation, useApiQuery } from "@/lib/query";
import { useFormat, useWorkspace } from "@/lib/session";
import type { CustomFieldDefinition } from "@/lib/types/crm-settings";
import { IMPORT_MAX_ERRORS, type ImportDetail } from "@/lib/types/imports";
import { IMPORT_POLL_MS, isActiveImport, useRefreshWhenImportsFinish } from "./hooks";
import { importFieldLabel } from "./labels";
import { Table, Td, Th } from "./Table";

/** A running import whose row has not moved for this long is probably stuck (worker restart, lost job). */
const STALE_MS = 10 * 60_000;
const isStale = (updatedAt: string) => {
  const d = toDate(updatedAt);
  return d ? Date.now() - d.getTime() > STALE_MS : false;
};

export function ImportDetailView({ id }: { id: string }) {
  const ws = useWorkspace();
  const key = ws.key("imports", "detail", id);
  const cached = useApiQuery<ImportDetail>(key, ws.path(`/imports/${id}`));
  const active = cached.data ? isActiveImport(cached.data.status) : false;
  const query = useApiQuery<ImportDetail>(key, ws.path(`/imports/${id}`), { refetchInterval: active ? IMPORT_POLL_MS : false });
  useRefreshWhenImportsFinish(active ? [id] : [], [ws.key("imports", "list")]);

  return (
    <QueryState
      query={query}
      errorTitle={query.error?.isNotFound ? "Import not found" : undefined}
      loading={
        <>
          <PageHeader title="Import" icon={<EntityTile of="imports" />} back={{ href: ws.href("/imports"), label: "Imports" }} />
          <SkeletonText lines={6} />
        </>
      }
    >
      {(imp) => <Detail imp={imp} />}
    </QueryState>
  );
}

function Detail({ imp }: { imp: ImportDetail }) {
  const ws = useWorkspace();
  const f = useFormat();
  const [errorSearch, setErrorSearch] = useState("");
  const active = isActiveImport(imp.status);
  const stuck = active && isStale(imp.updatedAt);
  const canRetry = imp.status === "failed" || stuck;
  const options = imp.options ?? {};
  const tags = options.tags ?? [];
  const firstTag = tags[0];

  const fields = useApiQuery<CustomFieldDefinition[]>(ws.key("custom-fields"), ws.can("contacts.read") ? ws.path("/custom-fields") : null, {
    query: { entity: "contact" },
  });
  const customLabels = useMemo(() => Object.fromEntries((fields.data ?? []).map((c) => [c.key, c.label])), [fields.data]);

  const retry = useApiMutation<{ requeued: boolean }>({
    path: ws.path(`/imports/${imp.id}/retry`),
    invalidate: [ws.key("imports")],
    success: "Import queued again",
  });

  const errors = imp.errors ?? [];
  const wholeFailure = errors.find((e) => e.row === 0);
  const rowErrors = errors.filter((e) => e.row !== 0);
  const visibleErrors = errorSearch
    ? rowErrors.filter((e) => e.message.toLowerCase().includes(errorSearch.toLowerCase()) || String(e.row) === errorSearch.trim())
    : rowErrors;
  const truncated = rowErrors.length >= IMPORT_MAX_ERRORS && imp.failedCount > rowErrors.length;
  const mapped = Object.entries(imp.mapping ?? {}).filter(([, t]) => t);
  const skippedColumns = Object.entries(imp.mapping ?? {}).filter(([, t]) => !t).length;

  const meterTone = imp.status === "completed" ? "ok" : imp.status === "failed" ? "bad" : "accent";

  return (
    <>
      <PageHeader
        back={{ href: ws.href("/imports"), label: "Imports" }}
        title={<span className="break-all">{imp.fileName || "Untitled import"}</span>}
        icon={<EntityTile of="imports" />}
        meta={<StatusBadge value={imp.status} />}
        description={`${imp.source === "csv" ? "CSV file" : labelOf(imp.source)} · ${formatNumber(imp.totalRows)} ${imp.totalRows === 1 ? "row" : "rows"} · started ${f.dateTime(imp.createdAt)}`}
        actions={
          <>
            {firstTag && ws.can("contacts.read") && imp.processedRows > 0 && (
              <Button icon={<Users />} href={ws.href(`/contacts?tag=${encodeURIComponent(firstTag)}`)}>
                Contacts tagged &ldquo;{firstTag}&rdquo;
              </Button>
            )}
            {canRetry && (
              <Button variant="primary" icon={<RefreshCw />} loading={retry.isPending} onClick={() => retry.mutate()}>
                Retry
              </Button>
            )}
          </>
        }
      />

      <div className="flex flex-col gap-5">
        {wholeFailure && (
          <Callout tone="bad" title="The import stopped">
            {wholeFailure.message}
            {canRetry ? " Retrying picks up from the last saved row." : ""}
          </Callout>
        )}
        {stuck && (
          <Callout tone="warn" title="No progress for a while">
            This import has not moved since {f.dateTime(imp.updatedAt)}. Retry to queue it again; it resumes from the last saved row.
          </Callout>
        )}

        <Card>
          <CardBody className="flex flex-col gap-4">
            <Meter
              label={active ? (imp.status === "pending" ? "Waiting for a worker…" : "Processing…") : "Rows processed"}
              value={imp.processedRows}
              max={Math.max(imp.totalRows, 1)}
              tone={meterTone}
            />
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <StatCard label="Created" value={formatNumber(imp.createdCount)} icon={<UserPlus />} tint="green" hint="New contacts" tone={imp.createdCount ? "ok" : undefined} />
              <StatCard label="Updated" value={formatNumber(imp.updatedCount)} icon={<UserPen />} tint="blue" hint="Existing contacts, blanks filled in" />
              <StatCard
                label="Skipped"
                value={formatNumber(imp.skippedCount)}
                icon={<SkipForward />}
                tint="gray"
                hint={options.onDuplicate === "skip" ? "Already existed; left alone" : "Already existed; nothing to fill in"}
              />
              <StatCard
                label="Failed"
                value={formatNumber(imp.failedCount)}
                icon={imp.failedCount ? <CircleX /> : <CircleCheck />}
                tint={imp.failedCount ? "red" : "green"}
                hint={imp.failedCount ? "See the rows below" : "No row was refused"}
                tone={imp.failedCount ? "bad" : undefined}
              />
            </div>
          </CardBody>
        </Card>

        <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
          <Card>
            <CardHeader icon={<Settings2 />} title="Settings" />
            <CardBody>
              <KeyValueList
                items={[
                  { label: "Existing contacts", value: options.onDuplicate === "skip" ? "Left alone" : options.onDuplicate === "update" ? "Blank fields filled in" : null },
                  { label: "Tags added", value: tags.length ? tags.join(", ") : null },
                  { label: "Lead source", value: options.leadSource || null },
                  { label: "Phone country", value: options.defaultCountry || null, hint: options.defaultCountry ? undefined : "Workspace default" },
                  { label: "Started", value: f.dateTime(imp.startedAt ?? imp.createdAt) },
                  { label: "Finished", value: imp.finishedAt ? f.dateTime(imp.finishedAt) : null },
                ]}
              />
            </CardBody>
          </Card>

          <Card>
            <CardHeader
              icon={<Columns3 />}
              title="Column mapping"
              description={`${mapped.length} ${mapped.length === 1 ? "column" : "columns"} imported${skippedColumns ? `, ${skippedColumns} ignored` : ""}`}
            />
            <CardBody>
              {mapped.length ? (
                <KeyValueList items={mapped.map(([header, target]) => ({ label: <span title={header}>{header}</span>, value: importFieldLabel(target, customLabels) }))} />
              ) : (
                <p className="text-xs text-text-3">No mapping was recorded for this import.</p>
              )}
            </CardBody>
          </Card>
        </div>

        {rowErrors.length > 0 && (
          <Card>
            <CardHeader
              icon={<TriangleAlert />}
              title="Rows that failed"
              description={
                truncated
                  ? `The first ${formatNumber(rowErrors.length)} of ${formatNumber(imp.failedCount)} failed rows are kept. Row numbers count the header as row 1.`
                  : "Row numbers count the header as row 1, so they match the line in your spreadsheet."
              }
              actions={rowErrors.length > 10 ? <SearchInput value={errorSearch} onChange={setErrorSearch} size="sm" placeholder="Filter errors" className="w-48" /> : undefined}
            />
            {visibleErrors.length ? (
              <div className="max-h-[480px] overflow-y-auto">
                <Table>
                  <thead className="sticky top-0 bg-panel">
                    <tr>
                      <Th className="w-20" align="right" icon={COL.rows}>
                        Row
                      </Th>
                      <Th icon={COL.problem}>Problem</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleErrors.map((e, i) => (
                      <tr key={`${e.row}-${i}`}>
                        <Td align="right" className="text-text-2">
                          {formatNumber(e.row)}
                        </Td>
                        <Td className="text-text">{e.message}</Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </div>
            ) : (
              <EmptyState compact icon={<SearchX />} title="No error matches that filter" />
            )}
          </Card>
        )}
      </div>
    </>
  );
}
