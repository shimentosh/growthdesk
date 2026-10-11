"use client";

import Link from "next/link";
import { useState } from "react";
import { Ban, Check, ChevronRight, CircleCheck, CircleDot, Clock, Hand, History, ListFilter, ShieldCheck, ShieldX, X, type LucideIcon } from "lucide-react";
import { labelOf } from "@growthdesk/shared";
import { StatusBadge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { QueryState } from "@/components/ui/ErrorState";
import { Pagination } from "@/components/ui/Pagination";
import { SkeletonText } from "@/components/ui/Skeleton";
import { useMembers } from "@/components/pickers/Pickers";
import { cn } from "@/lib/cn";
import { useApiMutation, useApiQuery } from "@/lib/query";
import { useFormat, useWorkspace } from "@/lib/session";
import type { Paged } from "@/lib/types";
import { ACTION_LABELS, OP_LABELS, type RunLogEntry, type WorkflowActionType, type WorkflowRun } from "@/lib/types/automation";
import { ACTION_GLYPH, RunStatusBadge } from "./glyphs";

const actionLabel = (t: string | undefined) => (t && ACTION_LABELS[t as WorkflowActionType]?.label) || t || "Action";

/** One log entry in words. */
function LogLine({ entry, nameOf }: { entry: RunLogEntry; nameOf: (userId: string) => string }) {
  const f = useFormat();
  let text: string;
  let tone: "ok" | "bad" | "warn" | "mute" = "mute";
  let Icon: LucideIcon = CircleDot;
  switch (entry.step) {
    case "plan":
      text = `Skipped — ${entry.detail ?? "the plan does not include automation"}`;
      tone = "warn";
      Icon = Ban;
      break;
    case "conditions":
      Icon = ListFilter;
      if (entry.met) {
        text = "Conditions met";
        tone = "ok";
      } else {
        const c = entry.failed;
        text = c ? `Condition not met: ${c.field} ${OP_LABELS[c.op] ?? c.op}${c.op === "exists" ? "" : ` “${c.value}”`}` : "Conditions not met";
        tone = "warn";
      }
      break;
    case "approval":
      if (entry.status === "requested") {
        text = "Waiting for approval";
        tone = "warn";
        Icon = Hand;
      } else {
        text = `${entry.status === "approved" ? "Approved" : "Rejected"}${entry.by ? ` by ${nameOf(entry.by)}` : ""}`;
        tone = entry.status === "approved" ? "ok" : "bad";
        Icon = entry.status === "approved" ? ShieldCheck : ShieldX;
      }
      break;
    case "action": {
      const head = `${typeof entry.index === "number" ? `${entry.index + 1}. ` : ""}${actionLabel(entry.type)}`;
      Icon = ACTION_GLYPH[entry.type as WorkflowActionType]?.icon ?? CircleCheck;
      if (entry.status === "delayed") {
        Icon = Clock;
        text = `${head} — waiting until ${entry.until ? f.dateTime(entry.until) : "later"}`;
      } else if (entry.status === "error") {
        text = `${head} — failed${entry.attempt ? ` (attempt ${entry.attempt})` : ""}: ${entry.error ?? "unknown error"}`;
        tone = "bad";
      } else {
        text = `${head} — ${entry.detail ?? labelOf(entry.status ?? "done")}`;
        tone = entry.status === "skipped" ? "mute" : "ok";
      }
      break;
    }
    default:
      text = [entry.step, entry.status, entry.detail ?? entry.error].filter(Boolean).join(" · ") || "Entry";
  }
  return (
    <li className="flex gap-2.5 text-xs">
      <Icon
        aria-hidden
        className={cn("mt-px size-3.5 shrink-0", tone === "ok" ? "text-ok-ink" : tone === "bad" ? "text-bad-ink" : tone === "warn" ? "text-warn-ink" : "text-text-3")}
      />
      <span className="min-w-0 flex-1 break-words text-text-2">{text}</span>
      {entry.at && <span className="shrink-0 text-text-3 tabular-nums">{f.dateTime(entry.at)}</span>}
    </li>
  );
}

function RunRow({ run, showWorkflow, defaultOpen }: { run: WorkflowRun; showWorkflow: boolean; defaultOpen?: boolean }) {
  const ws = useWorkspace();
  const f = useFormat();
  const members = useMembers();
  const [open, setOpen] = useState(Boolean(defaultOpen));
  const nameOf = (userId: string) => {
    const m = members.data?.members.find((x) => x.userId === userId);
    return m ? m.name || m.email : "a teammate";
  };
  const invalidate = [ws.key("workflow-runs"), ws.key("workflows")];
  const approve = useApiMutation<WorkflowRun, void>({ path: ws.path(`/workflow-runs/${run.id}/approve`), invalidate, success: "Approved — the run continues now" });
  const reject = useApiMutation<WorkflowRun, void>({ path: ws.path(`/workflow-runs/${run.id}/reject`), invalidate, success: "Rejected — the run was canceled" });
  const waiting = run.status === "waiting_approval";
  const log = Array.isArray(run.log) ? run.log : [];

  return (
    <li id={`run-${run.id}`} className={cn("px-4 py-3", defaultOpen && "bg-tint-pick")}>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
        <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="group flex min-w-0 flex-1 items-start gap-3 text-left">
          <RunStatusBadge status={run.status} className="mt-0.5" />
          <span className="min-w-0 flex-1">
            <span className="flex flex-wrap items-center gap-2">
              {showWorkflow && <span className="truncate text-sm font-medium text-text-hi">{run.workflow?.name ?? "Deleted workflow"}</span>}
              <StatusBadge value={run.status} />
            </span>
            <span className="mt-0.5 flex flex-wrap gap-x-3 text-xs text-text-3">
              <span title={f.dateTime(run.createdAt)}>Started {f.relative(run.createdAt)}</span>
              {run.subjectType && <span>{labelOf(run.subjectType)}</span>}
              {run.status === "waiting" && run.resumeAt && <span>Resumes {f.relative(run.resumeAt)}</span>}
              {run.finishedAt && <span>Finished {f.relative(run.finishedAt)}</span>}
            </span>
            {run.error && <span className="mt-0.5 block text-xs break-words text-bad-ink">{run.error}</span>}
          </span>
          <ChevronRight aria-hidden className={cn("mt-1.5 size-4 shrink-0 text-text-3 transition-transform group-hover:text-text-2", open && "rotate-90")} />
        </button>
        {waiting && ws.can("automation.write") && (
          <div className="flex shrink-0 gap-2 pl-10 sm:pl-0">
            <Button size="sm" variant="primary" icon={<Check />} loading={approve.isPending} disabled={reject.isPending} onClick={() => approve.mutate()}>
              Approve
            </Button>
            <Button size="sm" icon={<X />} loading={reject.isPending} disabled={approve.isPending} onClick={() => reject.mutate()}>
              Reject
            </Button>
          </div>
        )}
      </div>
      {open && (
        <div className="mt-2.5 ml-3.5 flex flex-col gap-2 border-l border-line pl-6">
          <div className="flex flex-wrap gap-x-3 text-xs text-text-3">
            {showWorkflow && run.workflow && (
              <Link href={ws.href(`/automation/${run.workflow.id}`)} className="text-accent-hi hover:text-accent">
                Open workflow
              </Link>
            )}
            {run.subjectType === "contact" && run.subjectId && (
              <Link href={ws.href(`/contacts/${run.subjectId}`)} className="text-accent-hi hover:text-accent">
                Open contact
              </Link>
            )}
            {run.attempts > 0 && <span>{run.attempts} failed attempt{run.attempts === 1 ? "" : "s"} on the current action</span>}
          </div>
          {log.length ? (
            <ol className="flex flex-col gap-1.5">
              {log.map((e, i) => (
                <LogLine key={i} entry={e} nameOf={nameOf} />
              ))}
            </ol>
          ) : (
            <p className="text-xs text-text-3">Nothing has happened in this run yet.</p>
          )}
        </div>
      )}
    </li>
  );
}

const PAGE_SIZE = 25;

/**
 * A paged list of workflow runs. With `workflowId` it reads that workflow's
 * runs (GET /workflows/:id/runs, no status filter there); otherwise every run
 * in the workspace, optionally filtered.
 */
export function RunsList({
  workflowId,
  status,
  filterWorkflowId,
  highlightRunId,
}: {
  workflowId?: string;
  status?: string;
  filterWorkflowId?: string;
  highlightRunId?: string;
}) {
  const ws = useWorkspace();
  const [page, setPage] = useState(1);
  const [filterKey, setFilterKey] = useState(`${status}|${filterWorkflowId}`);
  if (filterKey !== `${status}|${filterWorkflowId}`) {
    setFilterKey(`${status}|${filterWorkflowId}`);
    setPage(1);
  }
  const runs = useApiQuery<Paged<WorkflowRun>>(
    ws.key("workflow-runs", workflowId ?? "all"),
    workflowId ? ws.path(`/workflows/${workflowId}/runs`) : ws.path("/workflow-runs"),
    {
      query: { page, pageSize: PAGE_SIZE, ...(workflowId ? {} : { status: status || undefined, workflowId: filterWorkflowId || undefined }) },
      keepPrevious: true,
    },
  );

  return (
    <QueryState
      query={runs}
      loading={
        <div className="p-4">
          <SkeletonText lines={5} />
        </div>
      }
      isEmpty={(d) => d.items.length === 0}
      empty={
        <EmptyState
          compact
          icon={<History />}
          title={status || filterWorkflowId ? "No runs match" : "No runs yet"}
          description={status || filterWorkflowId ? "Try another filter." : "A run starts each time an active workflow's trigger fires."}
        />
      }
    >
      {(d) => (
        <>
          <ul className="divide-y divide-line">
            {d.items.map((r) => (
              <RunRow key={r.id} run={r} showWorkflow={!workflowId} defaultOpen={r.id === highlightRunId} />
            ))}
          </ul>
          {d.total > PAGE_SIZE && <Pagination className="border-t border-line px-4 py-3" page={page} pageSize={PAGE_SIZE} total={d.total} onPageChange={setPage} />}
        </>
      )}
    </QueryState>
  );
}
