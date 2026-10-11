"use client";

import Link from "next/link";
import { Plus } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { QueryState } from "@/components/ui/ErrorState";
import { Page, PageHeader } from "@/components/ui/PageHeader";
import { RequirePermission } from "@/components/ui/RequirePermission";
import { SkeletonText } from "@/components/ui/Skeleton";
import { Switch } from "@/components/ui/Switch";
import { ENTITY, EntityTile } from "@/components/ui/icons";
import { AutomationTabs } from "@/components/automation/AutomationTabs";
import { ActionGlyph, TriggerTile } from "@/components/automation/glyphs";
import { formatNumber } from "@/lib/format";
import { useApiMutation, useApiQuery } from "@/lib/query";
import { useFormat, useWorkspace } from "@/lib/session";
import { ACTION_LABELS, triggerLabel, type Workflow, type WorkflowListItem } from "@/lib/types/automation";

const WorkflowIcon = ENTITY.workflows.icon;

function WorkflowRow({ wf }: { wf: WorkflowListItem }) {
  const ws = useWorkspace();
  const f = useFormat();
  const toggle = useApiMutation<Workflow, { enabled: boolean }>({
    method: "PATCH",
    path: ws.path(`/workflows/${wf.id}`),
    invalidate: [ws.key("workflows")],
    success: (r) => (r.enabled ? `“${r.name}” is on` : `“${r.name}” is off`),
  });
  const href = ws.href(`/automation/${wf.id}`);

  return (
    <li className="flex items-start gap-3 px-4 py-3.5 sm:items-center">
      <TriggerTile trigger={wf.trigger} className={wf.enabled ? undefined : "opacity-60 grayscale"} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <Link href={href} className="truncate text-sm font-medium text-text-hi hover:underline">
            {wf.name}
          </Link>
          {wf.requiresApproval && <Badge quiet>Needs approval</Badge>}
          {wf.awaitingApproval > 0 && (
            <Link href={ws.href(`/automation/runs?status=waiting_approval&workflowId=${wf.id}`)}>
              <Badge tone="warn" dot>
                {wf.awaitingApproval} awaiting approval
              </Badge>
            </Link>
          )}
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-text-3">
          <span>When: {triggerLabel(wf.trigger)}</span>
          <span className="inline-flex items-center gap-1.5">
            {wf.actions.length > 0 && (
              <span className="inline-flex items-center gap-1 text-text-2">
                {wf.actions.slice(0, 6).map((a, i) => (
                  <span key={i} title={ACTION_LABELS[a.type]?.label ?? a.type} className="inline-flex">
                    <ActionGlyph type={a.type} className="size-3.5" />
                  </span>
                ))}
              </span>
            )}
            {wf.actions.length} action{wf.actions.length === 1 ? "" : "s"}
            {wf.conditions.length ? ` · ${wf.conditions.length} condition${wf.conditions.length === 1 ? "" : "s"}` : ""}
          </span>
          <span>
            {formatNumber(wf.runCount)} run{wf.runCount === 1 ? "" : "s"}
            {wf.lastRunAt ? ` · last ${f.relative(wf.lastRunAt)}` : ""}
          </span>
        </div>
        {wf.description && <p className="mt-1 line-clamp-1 text-xs text-text-2">{wf.description}</p>}
      </div>
      <Switch
        checked={wf.enabled}
        disabled={!ws.can("automation.write") || toggle.isPending}
        onCheckedChange={(enabled) => toggle.mutate({ enabled })}
        aria-label={wf.enabled ? `Turn off ${wf.name}` : `Turn on ${wf.name}`}
      />
    </li>
  );
}

export default function AutomationPage() {
  const ws = useWorkspace();
  const list = useApiQuery<WorkflowListItem[]>(ws.key("workflows", "list"), ws.path("/workflows"));
  const canWrite = ws.can("automation.write");
  const awaiting = (list.data ?? []).reduce((n, w) => n + w.awaitingApproval, 0);
  const create = canWrite ? (
    <Button variant="primary" icon={<Plus />} href={ws.href("/automation/new")}>
      New workflow
    </Button>
  ) : undefined;

  return (
    <Page>
      <RequirePermission permission="automation.read">
        <PageHeader
          title="Workflows"
          icon={<EntityTile of="workflows" />}
          description="When something happens — a new lead, a reply, a deal moving — check a few conditions and act: assign, tag, create a task, notify the team."
          actions={list.data && list.data.length > 0 ? create : undefined}
        />
        <AutomationTabs awaiting={awaiting} />
        {!ws.hasFeature("automation") && (
          <Callout tone="warn" title="Your plan does not include workflow automation" className="mb-4">
            Existing workflows do not run, and new ones cannot be created, until the plan is upgraded.
          </Callout>
        )}
        <QueryState
          query={list}
          loading={
            <Card className="p-4">
              <SkeletonText lines={4} />
            </Card>
          }
          isEmpty={(d) => d.length === 0}
          empty={
            <Card>
              <EmptyState
                icon={<WorkflowIcon />}
                tint={ENTITY.workflows.tint}
                title="No workflows yet"
                description={canWrite ? "Automate the busywork: assign new leads round-robin, tag contacts who reply, create a follow-up task when a meeting is booked." : "Nobody has built a workflow yet."}
                action={create}
              />
            </Card>
          }
        >
          {(rows) => (
            <Card>
              <ul className="divide-y divide-line">
                {rows.map((w) => (
                  <WorkflowRow key={w.id} wf={w} />
                ))}
              </ul>
            </Card>
          )}
        </QueryState>
      </RequirePermission>
    </Page>
  );
}
