"use client";

import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { SearchX, X } from "lucide-react";
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
import type { Paged } from "@/lib/types";
import type { AdminAuditRow } from "@/features/common/types";
import { AuditTable, FilterBar, platformEmpty, PlatformTile, platformKey, TableFooter } from "@/features/common/platform";

const ACTOR_TYPES = [
  { value: "platform_admin", label: "Platform staff" },
  { value: "user", label: "Customers" },
  { value: "api_key", label: "API keys" },
  { value: "system", label: "System" },
];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** /audit — every audit event on the installation, platform and workspace alike. */
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
