"use client";

import { useState } from "react";
import { CircleDot, RefreshCw, Send } from "lucide-react";
import { Badge, StatusBadge } from "@/components/ui/Badge";
import { IconButton } from "@/components/ui/Button";
import { Drawer } from "@/components/ui/Drawer";
import { EmptyState } from "@/components/ui/EmptyState";
import { QueryState } from "@/components/ui/ErrorState";
import { NativeSelect } from "@/components/ui/Input";
import { Pagination } from "@/components/ui/Pagination";
import { SkeletonText } from "@/components/ui/Skeleton";
import { useApiQuery } from "@/lib/query";
import { useFormat, useWorkspace } from "@/lib/session";
import type { Paged } from "@/lib/types";
import { eventLabel, type WebhookDelivery, type WebhookEndpoint } from "@/lib/types/integrations";

const PAGE_SIZE = 25;

/** Recent deliveries to one endpoint: what was sent, how often it was tried, and what the receiver answered. */
export function WebhookDeliveriesDrawer({ endpoint, onClose }: { endpoint: WebhookEndpoint | null; onClose: () => void }) {
  const ws = useWorkspace();
  const f = useFormat();
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);
  const list = useApiQuery<Paged<WebhookDelivery>>(
    ws.key("webhooks", endpoint?.id, "deliveries"),
    endpoint ? ws.path(`/webhooks/${endpoint.id}/deliveries`) : null,
    { query: { page, pageSize: PAGE_SIZE, status: status || undefined }, keepPrevious: true },
  );

  return (
    <Drawer
      open={endpoint !== null}
      onOpenChange={(o) => {
        if (!o) {
          onClose();
          setPage(1);
          setStatus("");
        }
      }}
      width="lg"
      title="Deliveries"
      description={endpoint ? <span className="font-mono break-all">{endpoint.url}</span> : undefined}
      actions={<IconButton label="Refresh" icon={<RefreshCw className={list.isFetching ? "animate-spin" : undefined} />} onClick={() => void list.refetch()} />}
    >
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="w-40 shrink-0">
          <NativeSelect
            size="sm"
            aria-label="Filter by status"
            icon={<CircleDot />}
            value={status}
            onChange={(e) => {
              setStatus(e.target.value);
              setPage(1);
            }}
            options={[
              { value: "", label: "All statuses" },
              { value: "succeeded", label: "Succeeded" },
              { value: "pending", label: "Retrying" },
              { value: "failed", label: "Failed" },
            ]}
          />
        </div>
        <span className="text-xs text-text-3">Each delivery is tried up to 8 times before it counts as failed.</span>
      </div>
      <QueryState
        query={list}
        loading={<SkeletonText lines={6} />}
        isEmpty={(d) => d.items.length === 0}
        empty={
          <EmptyState
            compact
            icon={<Send />}
            title={status ? "No deliveries with this status" : "Nothing delivered yet"}
            description={status ? undefined : "Deliveries appear here as soon as a subscribed event happens, or when you send a test."}
          />
        }
      >
        {(d) => (
          <>
            <ul className="divide-y divide-line rounded-md border border-line">
              {d.items.map((row) => (
                <li key={row.id} className="flex flex-col gap-1 px-3 py-2.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-text">{row.eventType === "ping" ? "Test (ping)" : eventLabel(row.eventType)}</span>
                    <StatusBadge value={row.status} label={row.status === "pending" ? "Retrying" : undefined} />
                    {row.responseStatus !== null && (
                      <Badge quiet tone={row.responseStatus >= 200 && row.responseStatus < 300 ? "ok" : "bad"}>
                        HTTP {row.responseStatus}
                      </Badge>
                    )}
                    <span className="ml-auto text-xs text-text-3" title={f.dateTime(row.createdAt)}>
                      {f.relative(row.createdAt)}
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-x-3 text-xs text-text-3">
                    <span>
                      {row.attempts} attempt{row.attempts === 1 ? "" : "s"}
                    </span>
                    {row.deliveredAt && <span>Delivered {f.dateTime(row.deliveredAt)}</span>}
                    <span className="font-mono">{row.eventType}</span>
                  </div>
                  {row.error && <p className="font-mono text-xs break-words text-bad-ink">{row.error}</p>}
                </li>
              ))}
            </ul>
            {d.total > PAGE_SIZE && <Pagination className="mt-3" page={page} pageSize={PAGE_SIZE} total={d.total} onPageChange={setPage} />}
          </>
        )}
      </QueryState>
    </Drawer>
  );
}
