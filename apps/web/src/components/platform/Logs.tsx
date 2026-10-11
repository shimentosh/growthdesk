"use client";

import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { SearchX, X } from "lucide-react";
import { labelOf } from "@growthdesk/shared";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { QueryState } from "@/components/ui/ErrorState";
import { Input, NativeSelect } from "@/components/ui/Input";
import { Page, PageHeader } from "@/components/ui/PageHeader";
import { Pagination } from "@/components/ui/Pagination";
import { SearchInput } from "@/components/ui/SearchInput";
import { SkeletonText } from "@/components/ui/Skeleton";
import { cn } from "@/lib/cn";
import { useApiQuery } from "@/lib/query";
import { useFormat } from "@/lib/session";
import type { Paged } from "@/lib/types";
import type { AdminAuditRow, EmailLogPage } from "@/lib/types/platform";
import { AuditTable, FilterBar, platformEmpty, PlatformTile, platformKey, table, TableFooter } from "./common";

const ACTOR_TYPES = [
  { value: "platform_admin", label: "Platform staff" },
  { value: "user", label: "Customers" },
  { value: "api_key", label: "API keys" },
  { value: "system", label: "System" },
];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** /admin/audit — every audit event on the installation, platform and workspace alike. */
export function AuditLog() {
  const params = useSearchParams();
  const [workspaceId, setWorkspaceId] = useState(params.get("workspaceId") ?? "");
  const [action, setAction] = useState(params.get("action") ?? "");
  const [actorType, setActorType] = useState(params.get("actorType") ?? "");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const wsValid = !workspaceId || UUID.test(workspaceId.trim());
  const log = useApiQuery<Paged<AdminAuditRow>>(platformKey("audit"), wsValid ? "/admin/audit" : null, {
    query: { workspaceId: workspaceId.trim() || undefined, action: action.trim() || undefined, actorType: actorType || undefined, page, pageSize },
    keepPrevious: true,
  });
  const reset = () => setPage(1);

  return (
    <Page>
      <PageHeader icon={<PlatformTile of="audit" />} title="Audit log" description="Security and administration events across the installation, newest first. Times are in your browser's time zone." />
      <FilterBar>
        <SearchInput
          value={action}
          onChange={(v) => {
            setAction(v);
            reset();
          }}
          placeholder="Action starts with… (e.g. platform.)"
          className="sm:w-72"
        />
        <NativeSelect
          aria-label="Actor"
          value={actorType}
          onChange={(e) => {
            setActorType(e.target.value);
            reset();
          }}
          placeholder="Anyone"
          options={ACTOR_TYPES}
          className="w-44"
        />
        <Input
          aria-label="Workspace id"
          value={workspaceId}
          onChange={(e) => {
            setWorkspaceId(e.target.value);
            reset();
          }}
          invalid={!wsValid}
          placeholder="Workspace id"
          className="w-80 font-mono"
        />
        {(action || actorType || workspaceId) && (
          <Button
            size="sm"
            variant="ghost"
            icon={<X />}
            onClick={() => {
              setAction("");
              setActorType("");
              setWorkspaceId("");
              reset();
            }}
          >
            Clear filters
          </Button>
        )}
      </FilterBar>
      {!wsValid ? (
        <Card>
          <EmptyState compact icon={<SearchX />} title="That is not a workspace id" description="Paste the id from a workspace's admin page." />
        </Card>
      ) : (
        <QueryState
          query={log}
          loading={<SkeletonText lines={8} />}
          isEmpty={(d) => d.total === 0}
          empty={
            <Card>
              <EmptyState {...platformEmpty("audit")} title="No events match" />
            </Card>
          }
        >
          {(data) => (
            <Card className={cn("overflow-hidden", log.isPlaceholderData && "opacity-60")}>
              <AuditTable rows={data.items} showWorkspace />
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
      )}
    </Page>
  );
}

/** /admin/email — the platform's own transactional mail (verification, reset, invitations, notifications). */
export function EmailLog() {
  const f = useFormat();
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [template, setTemplate] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const log = useApiQuery<EmailLogPage>(platformKey("email-log"), "/admin/email-log", {
    query: { q, status: status || undefined, template: template || undefined, page, pageSize },
    keepPrevious: true,
  });

  return (
    <Page>
      <PageHeader
        icon={<PlatformTile of="email" />}
        title="Email log"
        description="Mail Growthdesk itself sends — sign-up verification, password resets, invitations and notifications. Customers' outreach email is not listed here."
      />
      <FilterBar>
        <SearchInput
          value={q}
          onChange={(v) => {
            setQ(v);
            setPage(1);
          }}
          placeholder="Search recipient…"
          className="sm:w-64"
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
            { value: "sent", label: "Sent" },
            { value: "failed", label: "Failed" },
          ]}
          className="w-36"
        />
        <NativeSelect
          aria-label="Template"
          value={template}
          onChange={(e) => {
            setTemplate(e.target.value);
            setPage(1);
          }}
          placeholder="Any template"
          options={(log.data?.templates ?? []).map((t) => ({ value: t, label: labelOf(t) }))}
          className="w-48"
        />
      </FilterBar>
      <QueryState
        query={log}
        loading={<SkeletonText lines={8} />}
        isEmpty={(d) => d.total === 0}
        empty={
          <Card>
            <EmptyState {...platformEmpty("email")} title="No email matches" />
          </Card>
        }
      >
        {(data) => (
          <Card className={cn("overflow-hidden", log.isPlaceholderData && "opacity-60")}>
            <div className={table.wrap}>
              <table className={table.table}>
                <thead>
                  <tr>
                    <th className={table.th}>When</th>
                    <th className={table.th}>To</th>
                    <th className={table.th}>Template</th>
                    <th className={table.th}>Status</th>
                    <th className={table.th}>Error</th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((m) => (
                    <tr key={m.id}>
                      <td className={cn(table.td, "whitespace-nowrap text-text-2")}>{f.dateTime(m.createdAt)}</td>
                      <td className={cn(table.td, "max-w-72 truncate")}>{m.to}</td>
                      <td className={table.td}>{labelOf(m.template)}</td>
                      <td className={table.td}>
                        <Badge tone={m.status === "sent" ? "ok" : "bad"} dot>
                          {labelOf(m.status)}
                        </Badge>
                      </td>
                      <td className={cn(table.td, "max-w-96 text-xs text-bad-ink")}>{m.error || <span className="text-text-3">—</span>}</td>
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
