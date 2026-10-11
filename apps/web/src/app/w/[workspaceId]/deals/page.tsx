"use client";

import { useState } from "react";
import type { QueryKey } from "@tanstack/react-query";
import { useQueryClient } from "@tanstack/react-query";
import { Columns3, Handshake, List, Plus, Settings2, SquareKanban } from "lucide-react";
import { DEAL_STATUSES, labelOf } from "@growthdesk/shared";
import { CloseDealModal, type CloseRequest } from "@/components/pipeline/CloseDealModal";
import { Segmented, useSearchState } from "@/components/pipeline/controls";
import { DealBoard } from "@/components/pipeline/DealBoard";
import { DealTable } from "@/components/pipeline/DealTable";
import { NewDealModal } from "@/components/pipeline/NewDealModal";
import { stageRef, totalsByCurrency } from "@/components/pipeline/utils";
import { useMembers } from "@/components/pickers/Pickers";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { QueryState } from "@/components/ui/ErrorState";
import { NativeSelect } from "@/components/ui/Input";
import { Page, PageHeader } from "@/components/ui/PageHeader";
import { Pagination } from "@/components/ui/Pagination";
import { RequirePermission } from "@/components/ui/RequirePermission";
import { SearchInput } from "@/components/ui/SearchInput";
import { Skeleton } from "@/components/ui/Skeleton";
import { ENTITY, EntityTile } from "@/components/ui/icons";
import { formatNumber } from "@/lib/format";
import { useApiMutation, useApiQuery } from "@/lib/query";
import { useWorkspace } from "@/lib/session";
import type { Paged } from "@/lib/types";
import type { Deal, DealDetail, Pipeline, PipelineStage } from "@/lib/types/pipeline";

/** The API's ceiling for one page of deals (DealListQuery.pageSize max). */
const BOARD_LIMIT = 1000;
const LIST_PAGE_SIZE = 50;

type MoveVars = { deal: Deal; stage: PipelineStage; reason?: string; boardKey: QueryKey; previous?: Paged<Deal> };

export default function DealsPage() {
  return (
    <Page width="full">
      <RequirePermission permission="deals.read">
        <Deals />
      </RequirePermission>
    </Page>
  );
}

function Deals() {
  const ws = useWorkspace();
  const qc = useQueryClient();
  const search = useSearchState();
  const members = useMembers();
  const canWrite = ws.can("deals.write");

  const view = search.get("view") === "list" ? "list" : "board";
  const q = search.get("q");
  const ownerId = search.get("owner");
  const status = search.get("status");
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState<{ stageId?: string } | null>(null);
  const [closing, setClosing] = useState<CloseRequest | null>(null);

  const pipelines = useApiQuery<Pipeline[]>(ws.key("pipelines"), ws.path("/pipelines"));
  const pipeline = pipelines.data?.find((p) => p.id === search.get("pipeline")) ?? pipelines.data?.[0];

  const boardQuery = { pipelineId: pipeline?.id, ownerId, q, pageSize: BOARD_LIMIT };
  const boardKey: QueryKey = [...ws.key("deals", "board"), boardQuery];
  const board = useApiQuery<Paged<Deal>>(ws.key("deals", "board"), pipeline && view === "board" ? ws.path("/deals") : null, { query: boardQuery });
  const list = useApiQuery<Paged<Deal>>(ws.key("deals", "list"), pipeline && view === "list" ? ws.path("/deals") : null, {
    query: { pipelineId: pipeline?.id, ownerId, q, status, page, pageSize: LIST_PAGE_SIZE },
    keepPrevious: true,
  });

  const move = useApiMutation<DealDetail, MoveVars>({
    path: (v) => ws.path(`/deals/${v.deal.id}/move`),
    body: (v) => ({ stageId: v.stage.id, ...(v.reason ? { reason: v.reason } : {}) }),
    // Winning a deal marks its contact a customer, so contacts refresh too.
    invalidate: (_, v) => (v.stage.kind === "won" ? [ws.key("deals"), ws.key("contacts")] : [ws.key("deals")]),
    success: (_, v) => `“${v.deal.name}” moved to ${v.stage.name}`,
    onError: (_, v) => {
      if (v.previous) qc.setQueryData(v.boardKey, v.previous);
    },
  });

  /** Optimistic: the card jumps columns at once and goes back if the API refuses. */
  const doMove = async (deal: Deal, stage: PipelineStage, reason?: string) => {
    await qc.cancelQueries({ queryKey: boardKey });
    const previous = qc.getQueryData<Paged<Deal>>(boardKey);
    if (previous) {
      const moved: Deal = {
        ...deal,
        stage: stageRef(stage),
        status: stage.kind,
        stageEnteredAt: new Date().toISOString(),
        closedAt: stage.kind === "open" ? null : new Date().toISOString(),
      };
      // The API lists deals newest-in-stage first, so the moved card goes to the top.
      qc.setQueryData<Paged<Deal>>(boardKey, { ...previous, items: [moved, ...previous.items.filter((d) => d.id !== deal.id)] });
    }
    move.mutate({ deal, stage, reason, boardKey, previous });
  };

  const requestMove = (deal: Deal, stage: PipelineStage) => {
    if (stage.kind === "open") void doMove(deal, stage);
    else setClosing({ dealId: deal.id, dealName: deal.name, stage: stageRef(stage) });
  };

  const setFilter = (patch: Record<string, string | null>) => {
    setPage(1);
    search.set(patch);
  };

  const ownerOptions = [
    { value: "", label: "Any owner" },
    { value: "me", label: "Me" },
    ...(members.data?.members ?? []).map((m) => ({ value: m.userId, label: m.name || m.email })),
  ];
  const openDeals = board.data?.items.filter((d) => d.status === "open") ?? [];

  return (
    <>
      <PageHeader
        title="Deals"
        icon={<EntityTile of="deals" />}
        description={
          view === "board" && board.data
            ? `${formatNumber(openDeals.length)} open · ${totalsByCurrency(openDeals, ws.currency)}`
            : view === "list" && list.data
              ? `${formatNumber(list.data.total)} deal${list.data.total === 1 ? "" : "s"}`
              : undefined
        }
        actions={
          <>
            {ws.can("pipelines.manage") && (
              <Button variant="ghost" icon={<Settings2 />} href={ws.href("/settings/pipelines")}>
                Pipelines
              </Button>
            )}
            {canWrite && pipeline && (
              <Button variant="primary" icon={<Plus />} onClick={() => setCreating({})}>
                New deal
              </Button>
            )}
          </>
        }
      />

      <QueryState
        query={pipelines}
        loading={<BoardSkeleton />}
        isEmpty={(d) => d.length === 0}
        empty={
          <EmptyState
            icon={<Handshake />}
            tint={ENTITY.deals.tint}
            title="No pipeline yet"
            description="Deals move through the stages of a pipeline. Create one to start tracking deals."
            action={
              ws.can("pipelines.manage") ? (
                <Button variant="primary" icon={<SquareKanban />} href={ws.href("/settings/pipelines")}>
                  Set up a pipeline
                </Button>
              ) : undefined
            }
          />
        }
      >
        {(all) =>
          pipeline && (
            <>
              <div className="mb-4 flex flex-wrap items-center gap-2">
                {all.length > 1 && (
                  <NativeSelect
                    aria-label="Pipeline"
                    className="w-auto min-w-44"
                    value={pipeline.id}
                    onChange={(e) => setFilter({ pipeline: e.target.value })}
                    options={all.map((p) => ({ value: p.id, label: p.isDefault ? `${p.name} (default)` : p.name }))}
                  />
                )}
                <SearchInput className="w-full sm:w-60" value={q} onChange={(v) => setFilter({ q: v || null })} placeholder="Search deals…" />
                <NativeSelect aria-label="Owner" className="w-auto min-w-36" value={ownerId} onChange={(e) => setFilter({ owner: e.target.value || null })} options={ownerOptions} />
                {view === "list" && (
                  <NativeSelect
                    aria-label="Status"
                    className="w-auto min-w-32"
                    value={status}
                    onChange={(e) => setFilter({ status: e.target.value || null })}
                    options={[{ value: "", label: "Any status" }, ...DEAL_STATUSES.map((s) => ({ value: s, label: labelOf(s) }))]}
                  />
                )}
                <div className="ml-auto">
                  <Segmented
                    aria-label="Layout"
                    value={view}
                    onChange={(v) => setFilter({ view: v === "board" ? null : v })}
                    options={[
                      { value: "board", label: "Board", icon: <Columns3 /> },
                      { value: "list", label: "List", icon: <List /> },
                    ]}
                  />
                </div>
              </div>

              {view === "board" ? (
                <QueryState query={board} loading={<BoardSkeleton />}>
                  {(data) => (
                    <>
                      {data.total > data.items.length && (
                        <Callout tone="warn" className="mb-3">
                          Showing the {formatNumber(data.items.length)} deals that most recently changed stage, of {formatNumber(data.total)}. Use search, the owner filter or
                          the list view to find the rest.
                        </Callout>
                      )}
                      <DealBoard pipeline={pipeline} deals={data.items} canWrite={canWrite} onMove={requestMove} onAdd={(stageId) => setCreating({ stageId })} />
                    </>
                  )}
                </QueryState>
              ) : (
                <Card>
                  <QueryState
                    query={list}
                    isEmpty={(d) => d.items.length === 0}
                    empty={
                      <EmptyState
                        compact
                        icon={<Handshake />}
                        title={q || ownerId || status ? "No deals match these filters" : "No deals in this pipeline yet"}
                        description={q || ownerId || status ? "Clear a filter to see more." : undefined}
                      />
                    }
                  >
                    {(data) => (
                      <>
                        <DealTable deals={data.items} />
                        <Pagination className="border-t border-line px-3 py-2" page={data.page} pageSize={data.pageSize} total={data.total} onPageChange={setPage} />
                      </>
                    )}
                  </QueryState>
                </Card>
              )}
            </>
          )
        }
      </QueryState>

      <NewDealModal
        open={creating !== null}
        onOpenChange={(o) => !o && setCreating(null)}
        pipelines={pipelines.data ?? []}
        pipelineId={pipeline?.id}
        stageId={creating?.stageId}
      />
      <CloseDealModal
        request={closing}
        onCancel={() => setClosing(null)}
        onConfirm={(req, reason) => {
          const deal = (board.data?.items ?? list.data?.items ?? []).find((d) => d.id === req.dealId);
          const stage = pipeline?.stages.find((s) => s.id === req.stage.id);
          setClosing(null);
          if (deal && stage) void doMove(deal, stage, reason);
        }}
      />
    </>
  );
}

function BoardSkeleton() {
  return (
    <div className="flex gap-3 overflow-hidden" aria-hidden>
      {Array.from({ length: 4 }, (_, i) => (
        <div key={i} className="flex w-[272px] shrink-0 flex-col gap-2 rounded-lg border border-line bg-well p-2">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
        </div>
      ))}
    </div>
  );
}
