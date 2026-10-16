"use client";

import Link from "next/link";
import { useMemo, useState, type DragEvent, type MouseEvent, type ReactNode } from "react";
import { AlarmClock, ArrowRightLeft, CheckSquare, Clock, Flag, Handshake, User } from "lucide-react";
import { labelOf, PRIORITIES, TASK_TYPES } from "@growthdesk/shared";
import { useMembers } from "@/components/pickers/Pickers";
import { Avatar } from "@/components/ui/Avatar";
import { IconButton } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Checkbox";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/DropdownMenu";
import { QueryState } from "@/components/ui/ErrorState";
import type { Tint } from "@/components/ui/IconTile";
import { SkeletonText } from "@/components/ui/Skeleton";
import { toast } from "@/components/ui/Toast";
import { cn } from "@/lib/cn";
import { dayKey } from "@/lib/format";
import { useApiMutation, useApiQuery } from "@/lib/query";
import { useFormat, useMe, useWorkspace } from "@/lib/session";
import type { Paged } from "@/lib/types";
import type { TaskRow, TaskView } from "@/lib/types/pipeline";
import { DUE_BUCKETS, dueBucketOf, dueCalendar, dueForBucket, PRIORITY_TINT, TYPE_ICON, type DueBucket, type DueCalendar, type TaskGroupBy } from "./taskMeta";

/** The MIME type a dragged card carries, so a stray text drop is ignored. */
const DRAG_TYPE = "application/x-growthdesk-task";
/** The API's page-size ceiling: the board shows at most this many tasks. */
const BOARD_SIZE = 200;

/** The fields a board move changes, in TaskRow terms (the overlay) — the PATCH body is derived from them. */
type Fields = Partial<Pick<TaskRow, "dueAt" | "status" | "completedAt" | "assigneeId" | "assignee" | "priority" | "type">>;
const BODY_KEYS = ["dueAt", "status", "assigneeId", "priority", "type"] as const;

type MoveVars = { task: TaskRow; fields: Fields; message: string; undo?: Fields };

type Column = {
  id: string;
  label: string;
  /** A coloured dot, an avatar or a glyph before the name. */
  marker: ReactNode;
  /** False: nothing can be dropped here (Overdue). */
  droppable: boolean;
  /** What dropping a task here changes; null when it would change nothing. */
  fieldsFor: (t: TaskRow) => Fields | null;
  /** The toast after a move here. */
  moved: string;
};

const dot = (tint: Tint) => <span aria-hidden className="inline-block size-2 shrink-0 rounded-full" style={{ backgroundColor: `var(--tint-${tint})` }} />;

const DUE_META: Record<DueBucket, { label: string; tint: Tint }> = {
  overdue: { label: "Overdue", tint: "red" },
  today: { label: "Today", tint: "blue" },
  tomorrow: { label: "Tomorrow", tint: "indigo" },
  week: { label: "This week", tint: "purple" },
  later: { label: "Later", tint: "teal" },
  none: { label: "No date", tint: "gray" },
  done: { label: "Done today", tint: "green" },
};

export type TaskBoardProps = {
  /** The view card and filters the list would use; the board shows the same tasks. */
  view: TaskView;
  type: string;
  assigneeId: string;
  groupBy: TaskGroupBy;
  onOpen: (task: TaskRow) => void;
};

/**
 * Tasks as columns, grouped by due date, assignee, priority or type. Cards
 * drag between columns (native HTML5 drag and drop, as on the deals board);
 * every card also has a "Move to…" menu for keyboard and touch. Moves are
 * optimistic: an overlay shows the change at once and is dropped when the
 * refetch lands, or at once when the API refuses (rolling the card back).
 */
export function TaskBoard({ view, type, assigneeId, groupBy, onOpen }: TaskBoardProps) {
  const ws = useWorkspace();
  const f = useFormat();
  const me = useMe();
  const members = useMembers();
  const canWrite = ws.can("tasks.write");
  const canAssign = ws.can("tasks.assign");
  const meId = me.data?.user.id;

  const query = { view, type, assigneeId, page: 1, pageSize: BOARD_SIZE };
  const main = useApiQuery<Paged<TaskRow>>(ws.key("tasks", "board"), ws.path("/tasks"), { query, keepPrevious: true });
  // Open views return no done tasks, so "Done today" asks for them separately (same filters; "Mine" keeps to me).
  const wantsDone = groupBy === "due" && view !== "completed" && view !== "all";
  const doneQuery = { view: "completed", type, assigneeId: assigneeId || (view === "mine" ? "me" : ""), page: 1, pageSize: 100 };
  const done = useApiQuery<Paged<TaskRow>>(ws.key("tasks", "board", "done"), wantsDone ? ws.path("/tasks") : null, { query: doneQuery, keepPrevious: true });

  const [overlay, setOverlay] = useState<Record<string, Fields>>({});
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);

  const drop = (id: string) =>
    setOverlay((o) => {
      if (!(id in o)) return o;
      const { [id]: _gone, ...rest } = o;
      return rest;
    });

  const move = useApiMutation<TaskRow, MoveVars>({
    method: "PATCH",
    path: (v) => ws.path(`/tasks/${v.task.id}`),
    body: (v) => Object.fromEntries(BODY_KEYS.filter((k) => k in v.fields).map((k) => [k, v.fields[k]])),
    // Refetches the board, the list and the view-card counts (all under "tasks").
    invalidate: (_, v) => (v.task.dealId ? [ws.key("tasks"), ws.key("deals", v.task.dealId)] : [ws.key("tasks")]),
    onSuccess: (_, v) => {
      drop(v.task.id);
      const undo = v.undo;
      toast.success(v.message, undo ? { action: { label: "Undo", onClick: () => apply({ ...v.task, ...v.fields }, undo, "Change undone") } } : undefined);
    },
    onError: (_, v) => drop(v.task.id),
  });

  /** Show the change at once, then save it. `undo` omitted: this is itself an undo. */
  const apply = (task: TaskRow, fields: Fields, message: string, undoable = false) => {
    setOverlay((o) => ({ ...o, [task.id]: { ...o[task.id], ...fields } }));
    const undo = undoable ? (Object.fromEntries(Object.keys(fields).map((k) => [k, task[k as keyof Fields]])) as Fields) : undefined;
    move.mutate({ task, fields, message, undo });
  };

  const toggleDone = (t: TaskRow) =>
    t.status === "done"
      ? apply(t, { status: "open", completedAt: null }, "Task reopened", true)
      : apply(t, { status: "done", completedAt: new Date().toISOString() }, "Task completed", true);

  const cal = useMemo(() => dueCalendar(ws.timezone), [ws.timezone, main.dataUpdatedAt, done.dataUpdatedAt]); // eslint-disable-line react-hooks/exhaustive-deps

  // Server rows (plus "Done today" rows), with pending changes laid over them.
  const tasks = useMemo(() => {
    const seen = new Set<string>();
    const rows: TaskRow[] = [];
    const doneToday = (done.data?.items ?? []).filter(
      (t) => t.completedAt && dayKey(t.completedAt, ws.timezone) === cal.today && (view !== "team" || t.assigneeId !== meId),
    );
    for (const t of [...(main.data?.items ?? []), ...(wantsDone ? doneToday : [])]) {
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      rows.push(overlay[t.id] ? { ...t, ...overlay[t.id] } : t);
    }
    return rows;
  }, [main.data, done.data, wantsDone, overlay, cal.today, ws.timezone, view, meId]);

  const memberList = members.data?.members;
  const columns = useMemo<{ columns: Column[]; columnOf: (t: TaskRow) => string | null; canDrag: (t: TaskRow) => boolean }>(() => {
    switch (groupBy) {
      case "assignee": {
        const cols: Column[] = [
          {
            id: "",
            label: "Unassigned",
            marker: <span aria-hidden className="inline-block size-5 shrink-0 rounded-full border border-dashed border-line-strong" />,
            droppable: true,
            fieldsFor: (t) => (t.assigneeId ? { assigneeId: null, assignee: null } : null),
            moved: "Task unassigned",
          },
        ];
        const used = new Set(tasks.map((t) => t.assigneeId).filter(Boolean));
        const people = new Map<string, string>();
        for (const m of memberList ?? []) if ((memberList?.length ?? 0) <= 8 || used.has(m.userId)) people.set(m.userId, m.name || m.email);
        // People with tasks who are not in the member list (it needs members.read, or they left).
        for (const t of tasks) if (t.assignee && !people.has(t.assignee.id)) people.set(t.assignee.id, t.assignee.name || "Teammate");
        for (const [id, name] of people) {
          cols.push({
            id,
            label: id === meId ? `${name} (you)` : name,
            marker: <Avatar name={name} size="xs" />,
            droppable: true,
            fieldsFor: (t) => (t.assigneeId === id ? null : { assigneeId: id, assignee: { id, name } }),
            moved: `Assigned to ${name}`,
          });
        }
        return { columns: cols, columnOf: (t) => t.assigneeId ?? "", canDrag: () => canWrite && canAssign };
      }
      case "priority":
        return {
          columns: [...PRIORITIES].reverse().map((p) => ({
            id: p,
            label: labelOf(p),
            marker: dot(PRIORITY_TINT[p] ?? "gray"),
            droppable: true,
            fieldsFor: (t: TaskRow) => (t.priority === p ? null : { priority: p }),
            moved: `Priority set to ${labelOf(p)}`,
          })),
          columnOf: (t) => t.priority,
          canDrag: () => canWrite,
        };
      case "type":
        return {
          columns: TASK_TYPES.map((ty) => {
            const Icon = TYPE_ICON[ty] ?? CheckSquare;
            return {
              id: ty,
              label: labelOf(ty),
              marker: <Icon aria-hidden className="size-3.5 shrink-0 text-text-3" />,
              droppable: true,
              fieldsFor: (t: TaskRow) => (t.type === ty ? null : { type: ty }),
              moved: `Type set to ${labelOf(ty)}`,
            };
          }),
          columnOf: (t) => t.type,
          canDrag: () => canWrite,
        };
      default:
        return {
          columns: DUE_BUCKETS.map((b) => ({
            id: b,
            label: DUE_META[b].label,
            marker: dot(DUE_META[b].tint),
            droppable: b !== "overdue",
            fieldsFor: (t: TaskRow) => dueFields(b, t, cal),
            moved: b === "done" ? "Task completed" : b === "none" ? "Due date cleared" : `Moved to ${DUE_META[b].label.toLowerCase()}`,
          })),
          columnOf: (t) => dueBucketOf(t, cal),
          // Done cards reopen with their checkbox; dragging them would mean reopening and rescheduling at once.
          canDrag: (t) => canWrite && t.status === "open",
        };
    }
  }, [groupBy, tasks, memberList, meId, canWrite, canAssign, cal]);

  const byColumn = new Map<string, TaskRow[]>(columns.columns.map((c) => [c.id, []]));
  let hidden = 0;
  for (const t of tasks) {
    const col = columns.columnOf(t);
    const list = col === null ? undefined : byColumn.get(col);
    if (list) list.push(t);
    else hidden++;
  }
  // Done today: most recently completed first.
  byColumn.get("done")?.sort((a, b) => (b.completedAt ?? "").localeCompare(a.completedAt ?? ""));

  const moveTo = (t: TaskRow, col: Column) => {
    const fields = col.droppable ? col.fieldsFor(t) : null;
    if (fields) apply(t, fields, col.moved, true);
  };

  const onDrop = (e: DragEvent, col: Column) => {
    e.preventDefault();
    setOver(null);
    setDragging(null);
    const t = tasks.find((x) => x.id === e.dataTransfer.getData(DRAG_TYPE));
    if (t && columns.canDrag(t)) moveTo(t, col);
  };

  const draggedTask = dragging ? tasks.find((t) => t.id === dragging) : undefined;

  return (
    <QueryState query={main} loading={<SkeletonText lines={6} className="p-4" />}>
      {(data) => (
        <>
          {(data.total > data.items.length || hidden > 0) && (
            <p className="mb-2 text-xs text-text-3">
              {data.total > data.items.length && `Showing the first ${data.items.length} of ${data.total} tasks — narrow it down with a view or filter. `}
              {hidden > 0 && groupBy === "due" && `${hidden} task${hidden === 1 ? "" : "s"} completed or canceled before today ${hidden === 1 ? "is" : "are"} not shown.`}
            </p>
          )}
          <div className="-mx-4 overflow-x-auto px-4 pb-3 nav:-mx-6 nav:px-6">
            <ol className="flex min-w-max items-start gap-3" aria-label={`Tasks by ${groupBy === "due" ? "due date" : groupBy}`}>
              {columns.columns.map((col) => {
                const items = byColumn.get(col.id) ?? [];
                const target = Boolean(draggedTask && col.droppable && columns.columnOf(draggedTask) !== col.id);
                return (
                  <li
                    key={col.id || "unassigned"}
                    aria-label={col.label}
                    onDragOver={(e) => {
                      if (!target || !e.dataTransfer.types.includes(DRAG_TYPE)) return;
                      e.preventDefault();
                      e.dataTransfer.dropEffect = "move";
                      if (over !== col.id) setOver(col.id);
                    }}
                    onDragLeave={(e) => {
                      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver((o) => (o === col.id ? null : o));
                    }}
                    onDrop={(e) => onDrop(e, col)}
                    className={cn(
                      "flex w-[272px] shrink-0 flex-col rounded-lg border bg-well transition-colors",
                      over === col.id && target ? "border-accent bg-accent/5" : "border-line",
                      draggedTask && !col.droppable && "opacity-60",
                    )}
                  >
                    <div className="flex items-center gap-2 px-3 pt-2.5 pb-1.5">
                      {col.marker}
                      <h2 className="truncate text-sm font-semibold text-text-hi">{col.label}</h2>
                      <span className="text-xs text-text-3 tabular-nums">{items.length}</span>
                    </div>
                    <ul className="flex min-h-24 flex-col gap-2 p-2 pt-1">
                      {items.map((t) => (
                        <TaskCard
                          key={t.id}
                          task={t}
                          cal={cal}
                          canWrite={canWrite}
                          draggable={columns.canDrag(t)}
                          dragging={dragging === t.id}
                          targets={columns.columns.filter((c) => c.droppable && c.id !== col.id)}
                          onDragStart={() => setDragging(t.id)}
                          onDragEnd={() => {
                            setDragging(null);
                            setOver(null);
                          }}
                          onMove={(c) => moveTo(t, c)}
                          onToggle={() => toggleDone(t)}
                          onOpen={() => onOpen(t)}
                          when={f.smart}
                        />
                      ))}
                      {!items.length && (
                        <li className="rounded-md border border-dashed border-line-strong px-2 py-6 text-center text-xs text-text-3">
                          {canWrite && col.droppable ? "Drop a task here" : "No tasks"}
                        </li>
                      )}
                    </ul>
                  </li>
                );
              })}
            </ol>
          </div>
        </>
      )}
    </QueryState>
  );
}

/** What dropping on a due-date column changes, or null when nothing would change. */
function dueFields(bucket: DueBucket, t: TaskRow, cal: DueCalendar): Fields | null {
  if (dueBucketOf(t, cal) === bucket || bucket === "overdue") return null;
  if (bucket === "done") return { status: "done", completedAt: new Date().toISOString() };
  const dueAt = dueForBucket(bucket, t, cal);
  return dueAt === undefined ? null : { dueAt };
}

function TaskCard({
  task: t,
  cal,
  canWrite,
  draggable,
  dragging,
  targets,
  onDragStart,
  onDragEnd,
  onMove,
  onToggle,
  onOpen,
  when,
}: {
  task: TaskRow;
  cal: DueCalendar;
  canWrite: boolean;
  draggable: boolean;
  dragging: boolean;
  targets: Column[];
  onDragStart: () => void;
  onDragEnd: () => void;
  onMove: (c: Column) => void;
  onToggle: () => void;
  onOpen: () => void;
  when: (v: string) => string;
}) {
  const ws = useWorkspace();
  const done = t.status === "done";
  const overdue = t.status === "open" && t.dueAt !== null && Date.parse(t.dueAt) < cal.now;
  const TypeIcon = TYPE_ICON[t.type] ?? CheckSquare;
  const flagged = t.priority === "high" || t.priority === "urgent";
  // A click on the card body opens it; links, the checkbox and the menu keep their own clicks.
  const open = (e: MouseEvent) => {
    if ((e.target as HTMLElement).closest("a, button, [role=menu]")) return;
    onOpen();
  };
  return (
    <li
      draggable={draggable}
      onDragStart={(e) => {
        e.dataTransfer.setData(DRAG_TYPE, t.id);
        e.dataTransfer.effectAllowed = "move";
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      onClick={open}
      className={cn(
        "group cursor-pointer rounded-lg border border-line bg-panel p-3 shadow-card transition-[opacity,border-color] hover:border-line-strong",
        draggable && "cursor-grab active:cursor-grabbing",
        dragging && "opacity-40",
      )}
    >
      <div className="flex items-start gap-2">
        <span className="pt-0.5">
          <Checkbox
            checked={done}
            disabled={!canWrite || t.status === "canceled"}
            onCheckedChange={onToggle}
            aria-label={done ? `Reopen “${t.title}”` : `Complete “${t.title}”`}
          />
        </span>
        <button
          type="button"
          onClick={onOpen}
          className={cn("min-w-0 flex-1 text-left text-sm font-medium hover:text-accent-hi", done ? "text-text-3 line-through" : "text-text")}
        >
          <span className="line-clamp-2 break-words">{t.title}</span>
        </button>
        {flagged && (
          <span title={`${labelOf(t.priority)} priority`} className="pt-0.5">
            <Flag aria-label={`${labelOf(t.priority)} priority`} className="size-3.5" style={{ color: `var(--tint-${PRIORITY_TINT[t.priority]})` }} />
          </span>
        )}
        {canWrite && draggable && targets.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <IconButton
                size="sm"
                label={`Move “${t.title}” to…`}
                icon={<ArrowRightLeft />}
                className="-mt-1 -mr-1.5 text-text-3 opacity-70 group-hover:opacity-100 data-[state=open]:opacity-100"
              />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>Move to</DropdownMenuLabel>
              {targets.map((c) => (
                <DropdownMenuItem key={c.id || "unassigned"} icon={c.marker} disabled={!c.fieldsFor(t)} onSelect={() => onMove(c)}>
                  {c.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      {(t.contact || t.deal) && (
        <div className="mt-2 flex flex-col gap-1 pl-6 text-xs text-text-2">
          {t.contact && (
            <Link href={ws.href(`/contacts/${t.contact.id}`)} draggable={false} className="flex min-w-0 items-center gap-1 hover:text-text">
              <User aria-hidden className="size-3.5 shrink-0 text-text-3" />
              <span className="truncate">{t.contact.fullName || t.contact.email || t.contact.phone || "Unnamed contact"}</span>
            </Link>
          )}
          {t.deal && (
            <Link href={ws.href(`/deals/${t.deal.id}`)} draggable={false} className="flex min-w-0 items-center gap-1 hover:text-text">
              <Handshake aria-hidden className="size-3.5 shrink-0 text-text-3" />
              <span className="truncate">{t.deal.name}</span>
            </Link>
          )}
        </div>
      )}
      <div className="mt-2.5 flex items-center justify-between gap-2 border-t border-line pt-2 text-2xs text-text-3">
        <span className="flex min-w-0 items-center gap-2">
          <span className="flex items-center gap-1" title={labelOf(t.type)}>
            <TypeIcon aria-hidden className="size-3 shrink-0" />
            <span className="sr-only">{labelOf(t.type)}</span>
          </span>
          {done && t.completedAt ? (
            <span className="truncate">Done {when(t.completedAt)}</span>
          ) : t.dueAt ? (
            <span className={cn("flex items-center gap-1 truncate", overdue && "font-medium text-bad-ink")}>
              {overdue ? <AlarmClock aria-hidden className="size-3 shrink-0" /> : <Clock aria-hidden className="size-3 shrink-0" />}
              {when(t.dueAt)}
            </span>
          ) : (
            <span>No due date</span>
          )}
        </span>
        {t.assignee ? (
          <span className="flex min-w-0 items-center gap-1" title={t.assignee.name}>
            <span className="truncate">{t.assignee.name}</span>
            <Avatar name={t.assignee.name} size="xs" />
          </span>
        ) : (
          <span>Unassigned</span>
        )}
      </div>
    </li>
  );
}
