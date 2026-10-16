"use client";

import Link from "next/link";
import { useState, type DragEvent } from "react";
import { ArrowRightLeft, Building2, Clock, Info, Plus, User } from "lucide-react";
import { labelOf, localDay } from "@growthdesk/shared";
import { Avatar } from "@/components/ui/Avatar";
import { IconButton } from "@/components/ui/Button";
import { Tooltip } from "@/components/ui/Tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/DropdownMenu";
import { cn } from "@/lib/cn";
import { useFormat, useWorkspace } from "@/lib/session";
import type { Deal, Pipeline, PipelineStage } from "@/lib/types/pipeline";
import { NextStepLine, StaleBadge } from "./DealSignals";
import { StageDot } from "./StageDot";
import { totalsByCurrency } from "./utils";

/** The MIME type a dragged card carries, so a stray text drop is ignored. */
const DRAG_TYPE = "application/x-growthdesk-deal";

export type BoardProps = {
  pipeline: Pipeline;
  deals: Deal[];
  canWrite: boolean;
  onMove: (deal: Deal, stage: PipelineStage) => void;
  onAdd?: (stageId: string) => void;
};

/**
 * The pipeline as columns. Cards drag between columns (native HTML5 drag and
 * drop); every card also has a "Move to…" menu, which is the keyboard and
 * touch path — phones do not fire HTML5 drag events.
 */
export function DealBoard({ pipeline, deals, canWrite, onMove, onAdd }: BoardProps) {
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const byStage = new Map<string, Deal[]>(pipeline.stages.map((s) => [s.id, []]));
  for (const d of deals) byStage.get(d.stage.id)?.push(d);

  const drop = (e: DragEvent, stage: PipelineStage) => {
    e.preventDefault();
    setOver(null);
    setDragging(null);
    const id = e.dataTransfer.getData(DRAG_TYPE);
    const deal = deals.find((d) => d.id === id);
    if (deal && deal.stage.id !== stage.id) onMove(deal, stage);
  };

  return (
    <div className="-mx-4 overflow-x-auto px-4 pb-3 nav:-mx-6 nav:px-6">
      <ol className="flex min-w-max items-start gap-3" aria-label={`${pipeline.name} stages`}>
        {pipeline.stages.map((stage) => {
          const items = byStage.get(stage.id) ?? [];
          const isOver = over === stage.id && dragging !== null && deals.find((d) => d.id === dragging)?.stage.id !== stage.id;
          return (
            <li
              key={stage.id}
              aria-label={stage.name}
              onDragOver={(e) => {
                if (!canWrite || !e.dataTransfer.types.includes(DRAG_TYPE)) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                if (over !== stage.id) setOver(stage.id);
              }}
              onDragLeave={(e) => {
                // Only when leaving the column itself, not moving between its children.
                if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver((o) => (o === stage.id ? null : o));
              }}
              onDrop={(e) => drop(e, stage)}
              className={cn(
                "flex w-[272px] shrink-0 flex-col rounded-lg border bg-well transition-colors",
                isOver ? "border-accent bg-accent/5" : "border-line",
              )}
            >
              <ColumnHeader stage={stage} items={items} onAdd={canWrite && onAdd ? () => onAdd(stage.id) : undefined} />
              <ul className="flex min-h-24 flex-col gap-2 p-2 pt-1">
                {items.map((d) => (
                  <DealCard
                    key={d.id}
                    deal={d}
                    pipeline={pipeline}
                    canWrite={canWrite}
                    dragging={dragging === d.id}
                    onDragStart={() => setDragging(d.id)}
                    onDragEnd={() => {
                      setDragging(null);
                      setOver(null);
                    }}
                    onMove={(s) => onMove(d, s)}
                  />
                ))}
                {!items.length && (
                  <li className="rounded-md border border-dashed border-line-strong px-2 py-6 text-center text-xs text-text-3">{canWrite ? "Drop a deal here" : "No deals"}</li>
                )}
              </ul>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function ColumnHeader({ stage, items, onAdd }: { stage: PipelineStage; items: Deal[]; onAdd?: () => void }) {
  const ws = useWorkspace();
  return (
    <div className="flex items-start justify-between gap-2 px-3 pt-2.5 pb-1.5">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <StageDot stage={stage} />
          <h2 className="truncate text-sm font-semibold text-text-hi">{stage.name}</h2>
          <span className="text-xs text-text-3 tabular-nums">{items.length}</span>
          {stage.guidance && (
            // The stage's guidance once per column, not on every card.
            <Tooltip content={<span className="block max-w-64 whitespace-pre-line">{stage.guidance}</span>}>
              <button type="button" aria-label={`What to do in ${stage.name}`} className="rounded-xs text-text-3 hover:text-text">
                <Info aria-hidden className="size-3.5" />
              </button>
            </Tooltip>
          )}
        </div>
        <div className="mt-0.5 truncate pl-4 text-xs text-text-3 tabular-nums" title="Total value of the deals in this column">
          {totalsByCurrency(items, ws.currency)}
          <span> · {stage.kind === "open" ? `${stage.probability}%` : labelOf(stage.kind)}</span>
        </div>
      </div>
      {onAdd && <IconButton size="sm" label={`New deal in ${stage.name}`} icon={<Plus />} onClick={onAdd} className="-mr-1" />}
    </div>
  );
}

function DealCard({
  deal,
  pipeline,
  canWrite,
  dragging,
  onDragStart,
  onDragEnd,
  onMove,
}: {
  deal: Deal;
  pipeline: Pipeline;
  canWrite: boolean;
  dragging: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
  onMove: (stage: PipelineStage) => void;
}) {
  const ws = useWorkspace();
  const f = useFormat();
  return (
    <li
      draggable={canWrite}
      onDragStart={(e) => {
        e.dataTransfer.setData(DRAG_TYPE, deal.id);
        e.dataTransfer.effectAllowed = "move";
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      className={cn(
        "group rounded-lg border border-line bg-panel p-3 shadow-card transition-[opacity,border-color] hover:border-line-strong",
        canWrite && "cursor-grab active:cursor-grabbing",
        dragging && "opacity-40",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <Link href={ws.href(`/deals/${deal.id}`)} draggable={false} className="min-w-0 text-sm font-medium text-text hover:text-accent-hi">
          <span className="line-clamp-2 break-words">{deal.name}</span>
        </Link>
        {canWrite && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <IconButton
                size="sm"
                label={`Move “${deal.name}” to…`}
                icon={<ArrowRightLeft />}
                className="-mt-1 -mr-1.5 text-text-3 opacity-70 group-hover:opacity-100 data-[state=open]:opacity-100"
              />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>Move to</DropdownMenuLabel>
              {pipeline.stages.map((s) => (
                <DropdownMenuItem key={s.id} disabled={s.id === deal.stage.id} icon={<StageDot stage={s} className="mx-1" />} onSelect={() => onMove(s)}>
                  {s.name}
                  {s.kind !== "open" && <span className="text-text-3"> · {labelOf(s.kind)}</span>}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      <div className="mt-1 flex items-center justify-between gap-2">
        <span className="text-[15px] font-semibold tracking-[-0.01em] text-text-hi tabular-nums">{f.money(deal.value, deal.currency)}</span>
        <StaleBadge deal={deal} />
      </div>
      {(deal.contact || deal.company) && (
        <div className="mt-2 flex flex-col gap-1 text-xs text-text-2">
          {deal.contact && (
            <span className="flex min-w-0 items-center gap-1">
              <User aria-hidden className="size-3.5 shrink-0 text-text-3" />
              <span className="truncate">{deal.contact.fullName || deal.contact.email || "Unnamed contact"}</span>
            </span>
          )}
          {deal.company && (
            <span className="flex min-w-0 items-center gap-1">
              <Building2 aria-hidden className="size-3.5 shrink-0 text-text-3" />
              <span className="truncate">{deal.company.name}</span>
            </span>
          )}
        </div>
      )}
      {deal.status === "open" && <NextStepLine deal={deal} today={localDay(new Date(), ws.timezone)} className="mt-2" />}
      <div className="mt-2.5 flex items-center justify-between gap-2 border-t border-line pt-2 text-2xs text-text-3">
        <span className="flex items-center gap-1" title={`In ${deal.stage.name} since ${f.dateTime(deal.stageEnteredAt)}`}>
          <Clock aria-hidden className="size-3 shrink-0" />
          {f.relative(deal.stageEnteredAt)}
        </span>
        {deal.owner ? (
          <span className="flex min-w-0 items-center gap-1">
            <span className="truncate">{deal.owner.name}</span>
            <Avatar name={deal.owner.name} size="xs" />
          </span>
        ) : (
          <span>No owner</span>
        )}
      </div>
    </li>
  );
}
