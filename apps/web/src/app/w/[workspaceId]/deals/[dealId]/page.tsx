"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { CalendarDays, CalendarPlus, CheckSquare, History, Plus, Trash2 } from "lucide-react";
import { labelOf } from "@growthdesk/shared";
import { AiSummaryCard } from "@/components/ai/AiSummaryCard";
import { CloseDealModal, type CloseRequest } from "@/components/pipeline/CloseDealModal";
import { DealDetailsForm, DealFacts, DealNotes, DealTimeline, StagePanel } from "@/components/pipeline/DealSections";
import { MeetingModal } from "@/components/pipeline/MeetingModal";
import { TaskDrawer } from "@/components/pipeline/TaskDrawer";
import { stageRef } from "@/components/pipeline/utils";
import { StatusBadge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, CardHeader } from "@/components/ui/Card";
import { Checkbox } from "@/components/ui/Checkbox";
import { ConfirmDialog } from "@/components/ui/Dialog";
import { QueryState } from "@/components/ui/ErrorState";
import { Page, PageHeader } from "@/components/ui/PageHeader";
import { RequirePermission } from "@/components/ui/RequirePermission";
import { SkeletonText } from "@/components/ui/Skeleton";
import { EntityTile } from "@/components/ui/icons";
import { cn } from "@/lib/cn";
import { useApiMutation, useApiQuery } from "@/lib/query";
import { useFormat, useWorkspace } from "@/lib/session";
import type { DealDetail, Pipeline, PipelineStage, Task } from "@/lib/types/pipeline";

export default function DealPage() {
  return (
    <Page width="capped">
      <RequirePermission permission="deals.read">
        <DealRecord />
      </RequirePermission>
    </Page>
  );
}

function DealRecord() {
  const { dealId } = useParams<{ dealId: string }>();
  const ws = useWorkspace();
  const query = useApiQuery<DealDetail>(ws.key("deals", dealId), ws.path(`/deals/${dealId}`));
  return (
    <QueryState query={query} loading={<SkeletonText lines={8} />} errorTitle={query.error?.isNotFound ? "Deal not found" : undefined}>
      {(deal) => <DealView deal={deal} />}
    </QueryState>
  );
}

function DealView({ deal }: { deal: DealDetail }) {
  const ws = useWorkspace();
  const router = useRouter();
  const qc = useQueryClient();
  const f = useFormat();
  const canWrite = ws.can("deals.write");
  const [closing, setClosing] = useState<CloseRequest | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [addingTask, setAddingTask] = useState(false);
  const [addingMeeting, setAddingMeeting] = useState(false);

  const pipelines = useApiQuery<Pipeline[]>(ws.key("pipelines"), ws.path("/pipelines"));
  const pipeline = pipelines.data?.find((p) => p.id === deal.pipelineId);

  const move = useApiMutation<DealDetail, { stage: PipelineStage; reason?: string }>({
    path: ws.path(`/deals/${deal.id}/move`),
    body: (v) => ({ stageId: v.stage.id, ...(v.reason ? { reason: v.reason } : {}) }),
    // Winning a deal marks its contact a customer, so contacts refresh too.
    invalidate: (_, v) => (v.stage.kind === "won" ? [ws.key("deals"), ws.key("contacts")] : [ws.key("deals")]),
    success: (_, v) => (v.stage.kind === "open" ? `Moved to ${v.stage.name}` : `Marked ${labelOf(v.stage.kind).toLowerCase()}`),
  });

  const remove = useApiMutation<unknown, void>({
    method: "DELETE",
    path: ws.path(`/deals/${deal.id}`),
    success: "Deal deleted",
    errorToast: false,
    onSuccess: () => {
      // Leave first so the record's own query is not refetched into a 404.
      router.replace(ws.href("/deals"));
      qc.removeQueries({ queryKey: ws.key("deals", deal.id) });
      void qc.invalidateQueries({ queryKey: ws.key("deals", "board") });
      void qc.invalidateQueries({ queryKey: ws.key("deals", "list") });
    },
  });

  const contactLabel = deal.contact ? deal.contact.fullName || deal.contact.email || "Unnamed contact" : null;

  return (
    <>
      <PageHeader
        back={{ href: ws.href("/deals"), label: "Deals" }}
        icon={<EntityTile of="deals" />}
        title={deal.name}
        meta={<StatusBadge value={deal.status} />}
        description={
          <>
            <span className="font-medium text-text tabular-nums">{f.money(deal.value, deal.currency)}</span>
            {" · "}
            {deal.stage.name}
            {deal.owner && ` · Owned by ${deal.owner.name}`}
          </>
        }
        actions={
          ws.can("deals.delete") ? (
            <Button variant="danger" icon={<Trash2 />} onClick={() => setConfirmDelete(true)}>
              Delete
            </Button>
          ) : undefined
        }
      />

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="flex min-w-0 flex-col gap-5">
          <StagePanel
            deal={deal}
            pipeline={pipeline}
            canWrite={canWrite}
            pending={move.isPending}
            onMove={(stage) => move.mutate({ stage })}
            onClose={(stage) => setClosing({ dealId: deal.id, dealName: deal.name, stage: stageRef(stage) })}
          />
          <DealDetailsForm key={deal.id} deal={deal} canWrite={canWrite} />
          <DealNotes deal={deal} canWrite={canWrite} />
          <DealTimeline dealId={deal.id} />
        </div>
        <div className="flex min-w-0 flex-col gap-5">
          <AiSummaryCard kind="deal" id={deal.id} />
          <DealFacts deal={deal} />
          <DealTasks deal={deal} onAdd={() => setAddingTask(true)} />
          <DealMeetings deal={deal} onAdd={() => setAddingMeeting(true)} />
          <StageHistory deal={deal} />
        </div>
      </div>

      <CloseDealModal
        request={closing}
        pending={move.isPending}
        onCancel={() => setClosing(null)}
        onConfirm={(req, reason) => {
          const stage = pipeline?.stages.find((s) => s.id === req.stage.id);
          if (stage) move.mutate({ stage, reason }, { onSuccess: () => setClosing(null) });
        }}
      />
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete “${deal.name}”?`}
        description="The deal is removed from the pipeline and from every deal list."
        confirmLabel="Delete deal"
        onConfirm={() => remove.mutateAsync()}
      />
      <TaskDrawer
        open={addingTask}
        onOpenChange={setAddingTask}
        defaults={{ dealId: deal.id, dealLabel: deal.name, contactId: deal.contact?.id ?? null, contactLabel }}
      />
      <MeetingModal
        open={addingMeeting}
        onOpenChange={setAddingMeeting}
        defaults={{ dealId: deal.id, dealLabel: deal.name, contactId: deal.contact?.id ?? null, contactLabel }}
      />
    </>
  );
}

function DealTasks({ deal, onAdd }: { deal: DealDetail; onAdd: () => void }) {
  const ws = useWorkspace();
  const f = useFormat();
  const canWrite = ws.can("tasks.write");
  const toggle = useApiMutation<unknown, Task>({
    method: "PATCH",
    path: (t) => ws.path(`/tasks/${t.id}`),
    body: (t) => ({ status: t.status === "done" ? "open" : "done" }),
    invalidate: [ws.key("tasks"), ws.key("deals", deal.id)],
    success: (_, t) => (t.status === "done" ? "Task reopened" : "Task completed"),
  });
  if (!ws.can("tasks.read")) return null;
  const now = Date.now();
  return (
    <Card>
      <CardHeader
        icon={<CheckSquare />}
        title="Tasks"
        description={deal.tasks.length >= 50 ? "The 50 most recent." : undefined}
        actions={
          canWrite ? (
            <Button size="sm" variant="ghost" icon={<Plus />} onClick={onAdd}>
              Add
            </Button>
          ) : undefined
        }
      />
      {deal.tasks.length === 0 ? (
        <p className="flex items-center justify-center gap-2 px-4 py-6 text-xs text-text-3">
          <CheckSquare aria-hidden className="size-3.5" />
          No tasks on this deal.
        </p>
      ) : (
        <ul className="divide-y divide-line">
          {deal.tasks.map((t) => {
            const overdue = t.status === "open" && t.dueAt && new Date(t.dueAt).getTime() < now;
            return (
              <li key={t.id} className="flex items-start gap-2.5 px-4 py-2.5">
                <span className="pt-0.5">
                  <Checkbox
                    checked={t.status === "done"}
                    disabled={!canWrite || t.status === "canceled" || (toggle.isPending && toggle.variables?.id === t.id)}
                    onCheckedChange={() => toggle.mutate(t)}
                    aria-label={t.status === "done" ? `Reopen “${t.title}”` : `Complete “${t.title}”`}
                  />
                </span>
                <Link href={ws.href(`/tasks?view=all&task=${t.id}`)} className="min-w-0 flex-1">
                  <span className={cn("block truncate text-sm hover:text-accent-hi", t.status === "open" ? "text-text" : "text-text-3 line-through")}>{t.title}</span>
                  <span className={cn("block text-xs", overdue ? "text-bad-ink" : "text-text-3")}>
                    {labelOf(t.type)}
                    {t.dueAt && ` · ${overdue ? "Overdue, " : "Due "}${f.smart(t.dueAt)}`}
                    {t.status === "canceled" && " · Canceled"}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

function DealMeetings({ deal, onAdd }: { deal: DealDetail; onAdd: () => void }) {
  const ws = useWorkspace();
  const f = useFormat();
  return (
    <Card>
      <CardHeader
        icon={<CalendarDays />}
        title="Meetings"
        actions={
          ws.can(["deals.write", "contacts.write"]) ? (
            <Button size="sm" variant="ghost" icon={<CalendarPlus />} onClick={onAdd}>
              Record
            </Button>
          ) : undefined
        }
      />
      {deal.meetings.length === 0 ? (
        <p className="flex items-center justify-center gap-2 px-4 py-6 text-xs text-text-3">
          <CalendarDays aria-hidden className="size-3.5" />
          No meetings on this deal.
        </p>
      ) : (
        <ul className="divide-y divide-line">
          {deal.meetings.map((m) => (
            <li key={m.id}>
              <Link href={ws.href("/meetings")} className="flex items-start justify-between gap-3 px-4 py-2.5 hover:bg-hover">
                <span className="min-w-0">
                  <span className="block truncate text-sm text-text">{m.title}</span>
                  <span className="block text-xs text-text-3">{f.dateTime(m.startsAt)}</span>
                </span>
                <StatusBadge value={m.status} />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function StageHistory({ deal }: { deal: DealDetail }) {
  const f = useFormat();
  if (!deal.history.length) return null;
  return (
    <Card>
      <CardHeader
        icon={<History />}
        title="Stage history"
      />
      <ol className="divide-y divide-line">
        {deal.history.map((h) => (
          <li key={h.id} className="px-4 py-2.5">
            <span className="block text-sm text-text">{h.fromStage === null ? `Created in ${h.toStage || "a removed stage"}` : `${h.fromStage || "A removed stage"} → ${h.toStage || "a removed stage"}`}</span>
            <span className="block text-xs text-text-3" title={f.dateTime(h.changedAt)}>
              {f.relative(h.changedAt)}
            </span>
          </li>
        ))}
      </ol>
    </Card>
  );
}
