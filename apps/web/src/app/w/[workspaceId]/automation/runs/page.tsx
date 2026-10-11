"use client";

import { Suspense, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { WORKFLOW_RUN_STATUSES, labelOf } from "@growthdesk/shared";
import { Card } from "@/components/ui/Card";
import { NativeSelect } from "@/components/ui/Input";
import { Page, PageHeader } from "@/components/ui/PageHeader";
import { RequirePermission } from "@/components/ui/RequirePermission";
import { LoadingBlock } from "@/components/ui/Skeleton";
import { EntityTile } from "@/components/ui/icons";
import { AutomationTabs } from "@/components/automation/AutomationTabs";
import { RunsList } from "@/components/automation/RunsList";
import { useApiQuery } from "@/lib/query";
import { useWorkspace } from "@/lib/session";
import type { WorkflowListItem } from "@/lib/types/automation";

/**
 * Filters live in the address (?status=&workflowId=), so the "awaiting
 * approval" badge on the workflows list and the approval notification
 * (?run=<id>) can link straight to the right view.
 */
function Runs() {
  const ws = useWorkspace();
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const runId = params.get("run") ?? undefined;
  const [highlight] = useState(runId);
  // The approval notification links with ?run=; those runs are the ones waiting.
  const status = params.get("status") ?? (runId ? "waiting_approval" : "");
  const workflowId = params.get("workflowId") ?? "";
  const workflows = useApiQuery<WorkflowListItem[]>(ws.key("workflows", "list"), ws.path("/workflows"));
  const awaiting = (workflows.data ?? []).reduce((n, w) => n + w.awaitingApproval, 0);

  const setFilter = (key: "status" | "workflowId", value: string) => {
    const next = new URLSearchParams(params.toString());
    next.delete("run");
    // Dropping ?run= must not silently drop the status it implied.
    if (key !== "status" && runId && !params.get("status")) next.set("status", "waiting_approval");
    if (value) next.set(key, value);
    else next.delete(key);
    const qs = next.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };

  return (
    <>
      <AutomationTabs awaiting={awaiting} />
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="w-48">
          <NativeSelect
            size="sm"
            aria-label="Filter by status"
            value={status}
            onChange={(e) => setFilter("status", e.target.value)}
            options={[{ value: "", label: "All statuses" }, ...WORKFLOW_RUN_STATUSES.map((s) => ({ value: s, label: labelOf(s) }))]}
          />
        </div>
        <div className="w-60 max-w-full">
          <NativeSelect
            size="sm"
            aria-label="Filter by workflow"
            value={workflowId}
            onChange={(e) => setFilter("workflowId", e.target.value)}
            options={[
              { value: "", label: "All workflows" },
              ...(workflows.data ?? []).map((w) => ({ value: w.id, label: w.name })),
              ...(workflowId && workflows.data && !workflows.data.some((w) => w.id === workflowId) ? [{ value: workflowId, label: "Deleted workflow" }] : []),
            ]}
          />
        </div>
      </div>
      <Card>
        <RunsList status={status} filterWorkflowId={workflowId} highlightRunId={highlight} />
      </Card>
    </>
  );
}

export default function WorkflowRunsPage() {
  return (
    <Page>
      <RequirePermission permission="automation.read">
        <PageHeader title="Workflow runs" icon={<EntityTile of="runs" />} description="Every time a workflow fired, what it did, and the runs waiting for someone to approve them." />
        <Suspense fallback={<LoadingBlock />}>
          <Runs />
        </Suspense>
      </RequirePermission>
    </Page>
  );
}
