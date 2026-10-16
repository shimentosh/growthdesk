"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { QueryKey } from "@tanstack/react-query";
import { useQueryClient } from "@tanstack/react-query";
import {
  AlarmClock,
  CalendarClock,
  CalendarDays,
  CheckCheck,
  CheckSquare,
  CircleUserRound,
  Clock,
  Columns3,
  Ellipsis,
  Group,
  Handshake,
  List,
  ListChecks,
  ListFilter,
  ListTodo,
  MessageSquareReply,
  Pencil,
  Plus,
  Trash2,
  User,
  UserRound,
  Users,
  X,
  type LucideIcon,
} from "lucide-react";
import { labelOf, TASK_TYPES, type Channel } from "@growthdesk/shared";
import { Segmented, useSearchState } from "@/components/pipeline/controls";
import { TaskDrawer } from "@/components/pipeline/TaskDrawer";
import { useMembers } from "@/components/pickers/Pickers";
import { TaskBoard } from "@/components/tasks/TaskBoard";
import { GROUP_PREF, isTaskGroupBy, LAYOUT_PREF, readPref, TYPE_ICON, writePref, type TaskGroupBy, type TaskLayout } from "@/components/tasks/taskMeta";
import { Avatar } from "@/components/ui/Avatar";
import { Badge, statusTone } from "@/components/ui/Badge";
import { Button, IconButton } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Card } from "@/components/ui/Card";
import { Checkbox } from "@/components/ui/Checkbox";
import { ConfirmDialog } from "@/components/ui/Dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/DropdownMenu";
import { EmptyState } from "@/components/ui/EmptyState";
import { QueryState } from "@/components/ui/ErrorState";
import { IconTile, type Tint } from "@/components/ui/IconTile";
import { CHANNEL, ENTITY, EntityTile } from "@/components/ui/icons";
import { NativeSelect } from "@/components/ui/Input";
import { Page, PageHeader } from "@/components/ui/PageHeader";
import { Pagination } from "@/components/ui/Pagination";
import { RequirePermission } from "@/components/ui/RequirePermission";
import { SkeletonText } from "@/components/ui/Skeleton";
import { cn } from "@/lib/cn";
import { useApiMutation, useApiQuery } from "@/lib/query";
import { useFormat, useWorkspace } from "@/lib/session";
import type { Paged } from "@/lib/types";
import type { TaskRow, TaskView } from "@/lib/types/pipeline";

const PAGE_SIZE = 50;

/** What each view lists — mirrors the filters in TasksService.list(). */
const VIEWS: {
  value: TaskView;
  label: string;
  /** Short line under the count on the view card. */
  hint: string;
  icon: LucideIcon;
  tint: Tint;
  description: string;
  empty: string;
}[] = [
  {
    value: "today",
    label: "Today",
    hint: "Due today",
    icon: CalendarDays,
    tint: "blue",
    description: "Open tasks due today.",
    empty: "Nothing due today.",
  },
  {
    value: "overdue",
    label: "Overdue",
    hint: "Past due",
    icon: AlarmClock,
    tint: "red",
    description: "Open tasks past their due time.",
    empty: "Nothing overdue.",
  },
  {
    value: "upcoming",
    label: "Upcoming",
    hint: "Later or no date",
    icon: CalendarClock,
    tint: "indigo",
    description: "Open tasks due after today, or with no due date.",
    empty: "Nothing coming up.",
  },
  {
    value: "mine",
    label: "Mine",
    hint: "Assigned to you",
    icon: UserRound,
    tint: "purple",
    description: "Open tasks assigned to you.",
    empty: "No open tasks assigned to you.",
  },
  {
    value: "team",
    label: "Team",
    hint: "Everyone else",
    icon: Users,
    tint: "teal",
    description: "Open tasks assigned to other people.",
    empty: "No open tasks assigned to teammates.",
  },
  {
    value: "completed",
    label: "Completed",
    hint: "Done",
    icon: CheckCheck,
    tint: "green",
    description: "Done tasks, most recently completed first.",
    empty: "No completed tasks yet.",
  },
  {
    value: "all",
    label: "All",
    hint: "Open and done",
    icon: ListTodo,
    tint: "gray",
    description: "Every task, open or not.",
    empty: "No tasks yet.",
  },
];

type ToggleVars = {
  task: TaskRow;
  listKey: QueryKey;
  previous?: Paged<TaskRow>;
};

export default function TasksPage() {
  return (
    <Page width="full">
      <RequirePermission permission="tasks.read">
        <Tasks />
      </RequirePermission>
    </Page>
  );
}

function Tasks() {
  const ws = useWorkspace();
  const qc = useQueryClient();
  const search = useSearchState();
  const members = useMembers();
  const canWrite = ws.can("tasks.write");
  // Without records.view_all a person only sees their own and unassigned tasks, so "Team" would always be empty.
  const views = VIEWS.filter((v) => v.value !== "team" || ws.can("records.view_all"));
  const view = views.find((v) => v.value === search.get("view")) ?? views[0]!;
  const type = search.get("type");
  const assigneeId = search.get("assignee");
  const openTaskId = search.get("task");
  const layout: TaskLayout = search.get("layout") === "board" ? "board" : "list";
  const groupParam = search.get("group");
  const groupBy: TaskGroupBy = isTaskGroupBy(groupParam) ? groupParam : "due";
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<TaskRow | null>(null);
  const [editing, setEditing] = useState<TaskRow | null>(null);

  const listQuery = {
    view: view.value,
    type,
    assigneeId,
    page,
    pageSize: PAGE_SIZE,
  };
  const listKey: QueryKey = [...ws.key("tasks", "list"), listQuery];
  // The board loads its own (larger) page, so the list only loads in list layout.
  const list = useApiQuery<Paged<TaskRow>>(ws.key("tasks", "list"), layout === "list" ? ws.path("/tasks") : null, { query: listQuery, keepPrevious: true });

  // No layout in the URL: reopen the board (and its grouping) when that was this browser's last choice.
  useEffect(() => {
    const patch: Record<string, string> = {};
    if (!search.get("layout") && readPref(LAYOUT_PREF) === "board") patch.layout = "board";
    const savedGroup = readPref(GROUP_PREF);
    if ((patch.layout || search.get("layout") === "board") && !search.get("group") && isTaskGroupBy(savedGroup) && savedGroup !== "due") patch.group = savedGroup;
    if (Object.keys(patch).length) search.set(patch);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setLayout = (next: TaskLayout) => {
    writePref(LAYOUT_PREF, next);
    search.set({ layout: next === "board" ? "board" : null });
  };
  const setGroupBy = (next: TaskGroupBy) => {
    writePref(GROUP_PREF, next);
    search.set({ group: next === "due" ? null : next });
  };

  // ?task=<id> (notification links, the deal record) opens that task, even when it is not in the current view.
  const inList = openTaskId ? list.data?.items.find((t) => t.id === openTaskId) : undefined;
  const linked = useApiQuery<TaskRow>(ws.key("tasks", "one", openTaskId), openTaskId && !inList ? ws.path(`/tasks/${openTaskId}`) : null);
  const linkedTask = inList ?? (openTaskId ? linked.data : undefined);
  // Adopt the linked task into local state and drop the param, so the drawer does not
  // flicker when a save refetches the list without it.
  useEffect(() => {
    if (openTaskId && linkedTask) {
      setEditing(linkedTask);
      search.set({ task: null });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openTaskId, linkedTask]);

  const toggle = useApiMutation<TaskRow, ToggleVars>({
    method: "PATCH",
    path: (v) => ws.path(`/tasks/${v.task.id}`),
    body: (v) => ({ status: v.task.status === "done" ? "open" : "done" }),
    invalidate: (_, v) => (v.task.dealId ? [ws.key("tasks"), ws.key("deals", v.task.dealId)] : [ws.key("tasks")]),
    success: (_, v) => (v.task.status === "done" ? "Task reopened" : "Task completed"),
    onError: (_, v) => {
      if (v.previous) qc.setQueryData(v.listKey, v.previous);
    },
  });

  /** Optimistic: the box ticks at once and unticks if the API refuses. */
  const quickToggle = async (task: TaskRow) => {
    await qc.cancelQueries({ queryKey: listKey });
    const previous = qc.getQueryData<Paged<TaskRow>>(listKey);
    if (previous) {
      const status = task.status === "done" ? "open" : "done";
      qc.setQueryData<Paged<TaskRow>>(listKey, {
        ...previous,
        items: previous.items.map((t) => (t.id === task.id ? { ...t, status } : t)),
      });
    }
    toggle.mutate({ task, listKey, previous });
  };

  const remove = useApiMutation<unknown, TaskRow>({
    method: "DELETE",
    path: (t) => ws.path(`/tasks/${t.id}`),
    invalidate: (_, t) => (t.dealId ? [ws.key("tasks"), ws.key("deals", t.dealId)] : [ws.key("tasks")]),
    success: "Task deleted",
    errorToast: false,
    onSuccess: (_, t) => {
      setEditing((e) => (e?.id === t.id ? null : e));
    },
  });

  const setFilter = (patch: Record<string, string | null>) => {
    setPage(1);
    search.set(patch);
  };

  const assigneeOptions = [
    { value: "", label: "Anyone" },
    { value: "me", label: "Me" },
    ...(members.data?.members ?? []).map((m) => ({
      value: m.userId,
      label: m.name || m.email,
    })),
  ];
  const filtered = Boolean(type || assigneeId);

  return (
    <>
      <PageHeader
        icon={<EntityTile of="tasks" />}
        title="Tasks"
        description={`${view.description} Times in ${ws.timezone}.`}
        actions={
          canWrite ? (
            <Button variant="primary" icon={<Plus />} onClick={() => setCreating(true)}>
              New task
            </Button>
          ) : undefined
        }
      />

      <div role="group" aria-label="Task views" className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
        {views.map((v) => (
          <ViewCard
            key={v.value}
            view={v}
            active={v.value === view.value}
            filters={{ type, assigneeId }}
            current={v.value === view.value && list.data && !list.isPlaceholderData ? list.data.total : undefined}
            onSelect={() => setFilter({ view: v.value === "today" ? null : v.value })}
          />
        ))}
      </div>

      <div className="my-4 flex flex-wrap items-center gap-2">
        <NativeSelect
          aria-label="Type"
          icon={<ListChecks />}
          className="w-auto min-w-36"
          value={type}
          onChange={(e) => setFilter({ type: e.target.value || null })}
          options={[{ value: "", label: "Any type" }, ...TASK_TYPES.map((t) => ({ value: t, label: labelOf(t) }))]}
        />
        <NativeSelect
          aria-label="Assignee"
          icon={<CircleUserRound />}
          className="w-auto min-w-36"
          value={assigneeId}
          onChange={(e) => setFilter({ assignee: e.target.value || null })}
          options={assigneeOptions}
        />
        {filtered && (
          <Button variant="ghost" size="sm" icon={<X />} onClick={() => setFilter({ type: null, assignee: null })}>
            Clear filters
          </Button>
        )}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {layout === "board" && (
            <NativeSelect
              aria-label="Group by"
              icon={<Group />}
              className="w-auto min-w-40"
              value={groupBy}
              onChange={(e) => setGroupBy(isTaskGroupBy(e.target.value) ? e.target.value : "due")}
              options={[
                { value: "due", label: "Due date" },
                { value: "assignee", label: "Assignee" },
                { value: "priority", label: "Priority" },
                { value: "type", label: "Type" },
              ]}
            />
          )}
          <Segmented<TaskLayout>
            aria-label="Layout"
            value={layout}
            onChange={setLayout}
            options={[
              { value: "list", label: "List", icon: <List /> },
              { value: "board", label: "Board", icon: <Columns3 /> },
            ]}
          />
        </div>
      </div>

      {openTaskId && linked.isError && !inList && (
        <Callout
          tone="warn"
          className="mb-4"
          action={
            <Button size="sm" variant="ghost" onClick={() => search.set({ task: null })}>
              Dismiss
            </Button>
          }
        >
          {linked.error.isNotFound ? "That task no longer exists, or it is not visible to you." : linked.error.message}
        </Callout>
      )}

      {layout === "board" ? (
        <TaskBoard view={view.value} type={type} assigneeId={assigneeId} groupBy={groupBy} onOpen={setEditing} />
      ) : (
        <Card>
          <QueryState
            query={list}
            loading={<SkeletonText lines={6} className="p-4" />}
            isEmpty={(d) => d.items.length === 0}
            empty={
              <EmptyState
                compact={filtered}
                icon={filtered ? <ListFilter /> : <CheckSquare />}
                tint={filtered ? undefined : ENTITY.tasks.tint}
                title={filtered ? "No tasks match these filters" : view.empty}
                description={
                  filtered
                    ? "Try another type or assignee, or clear the filters."
                    : view.value === "completed" || view.value === "all"
                      ? undefined
                      : "Enjoy the quiet, or plan the next step for a contact."
                }
                action={
                  canWrite && !filtered ? (
                    <Button icon={<Plus />} onClick={() => setCreating(true)}>
                      New task
                    </Button>
                  ) : undefined
                }
              />
            }
          >
            {(data) => (
              <>
                <ul className="divide-y divide-line">
                  {data.items.map((t) => (
                    <TaskItem
                      key={t.id}
                      task={t}
                      canWrite={canWrite}
                      toggling={toggle.isPending && toggle.variables?.task.id === t.id}
                      onToggle={() => void quickToggle(t)}
                      onOpen={() => setEditing(t)}
                      onDelete={() => setDeleting(t)}
                    />
                  ))}
                </ul>
                {data.total > data.pageSize && (
                  <Pagination className="border-t border-line px-4 py-2" page={data.page} pageSize={data.pageSize} total={data.total} onPageChange={setPage} />
                )}
              </>
            )}
          </QueryState>
        </Card>
      )}

      <TaskDrawer open={creating} onOpenChange={setCreating} />
      <TaskDrawer open={editing !== null} onOpenChange={(o) => !o && setEditing(null)} task={editing} onDelete={canWrite ? (t) => setDeleting(t) : undefined} />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={deleting ? `Delete “${deleting.title}”?` : "Delete task?"}
        description="The task is removed for everyone. This cannot be undone."
        onConfirm={() => (deleting ? remove.mutateAsync(deleting) : undefined)}
      />
    </>
  );
}

/** One item in a row's detail line: a small glyph, then the text. */
const meta = "inline-flex items-center gap-1";

function TaskItem({
  task: t,
  canWrite,
  toggling,
  onToggle,
  onOpen,
  onDelete,
}: {
  task: TaskRow;
  canWrite: boolean;
  toggling: boolean;
  onToggle: () => void;
  onOpen: () => void;
  onDelete: () => void;
}) {
  const ws = useWorkspace();
  const f = useFormat();
  const done = t.status === "done";
  const overdue = t.status === "open" && t.dueAt !== null && new Date(t.dueAt).getTime() < Date.now();
  const TypeIcon = TYPE_ICON[t.type] ?? CheckSquare;
  const ChannelIcon = t.conversation ? (CHANNEL[t.conversation.channel as Channel]?.icon ?? MessageSquareReply) : null;
  return (
    <li className="flex items-start gap-3 px-4 py-2.5 hover:bg-hover">
      <span className="pt-0.5">
        <Checkbox
          checked={done}
          disabled={!canWrite || t.status === "canceled" || toggling}
          onCheckedChange={onToggle}
          aria-label={done ? `Reopen “${t.title}”` : `Complete “${t.title}”`}
        />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={onOpen}
            className={cn("text-left text-sm font-medium hover:text-accent-hi", done || t.status === "canceled" ? "text-text-3 line-through" : "text-text")}
          >
            {t.title}
          </button>
          {(t.priority === "high" || t.priority === "urgent") && <Badge tone={statusTone(t.priority)}>{labelOf(t.priority)}</Badge>}
          {t.status === "canceled" && <Badge>Canceled</Badge>}
          {t.source !== "manual" && (
            <Badge quiet title="Created automatically">
              {labelOf(t.source)}
            </Badge>
          )}
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-text-3">
          <span className={meta}>
            <TypeIcon aria-hidden className="size-3" />
            {labelOf(t.type)}
          </span>
          {done && t.completedAt ? (
            <span className={meta} title={f.dateTime(t.completedAt)}>
              <CheckCheck aria-hidden className="size-3" />
              Done {f.relative(t.completedAt)}
            </span>
          ) : t.dueAt ? (
            <span className={cn(meta, overdue && "font-medium text-bad-ink")} title={f.dateTime(t.dueAt)}>
              {overdue ? <AlarmClock aria-hidden className="size-3" /> : <Clock aria-hidden className="size-3" />}
              {overdue ? "Overdue · " : "Due "}
              {f.smart(t.dueAt)}
            </span>
          ) : (
            <span className={meta}>
              <Clock aria-hidden className="size-3" />
              No due date
            </span>
          )}
          {t.contact && (
            <Link href={ws.href(`/contacts/${t.contact.id}`)} className={cn(meta, "hover:text-text")}>
              <User aria-hidden className="size-3" />
              {t.contact.fullName || t.contact.email || t.contact.phone || "Unnamed contact"}
            </Link>
          )}
          {t.deal && (
            <Link href={ws.href(`/deals/${t.deal.id}`)} className={cn(meta, "hover:text-text")}>
              <Handshake aria-hidden className="size-3" />
              {t.deal.name}
            </Link>
          )}
          {t.conversation &&
            (ws.can("inbox.read") ? (
              <Link href={ws.href(`/inbox?c=${t.conversation.id}`)} className={cn(meta, "hover:text-text")}>
                {ChannelIcon && <ChannelIcon aria-hidden className="size-3" />}
                {labelOf(t.conversation.channel)}
                {t.conversation.subject ? `: ${t.conversation.subject}` : " conversation"}
              </Link>
            ) : (
              <span className={meta}>
                {ChannelIcon && <ChannelIcon aria-hidden className="size-3" />}
                {labelOf(t.conversation.channel)}
                {t.conversation.subject ? `: ${t.conversation.subject}` : " conversation"}
              </span>
            ))}
          {t.assignee ? (
            <span className={meta}>
              <Avatar size="xs" name={t.assignee.name} className="-my-0.5" />
              {t.assignee.name || "Teammate"}
            </span>
          ) : (
            <span>Unassigned</span>
          )}
        </div>
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <IconButton size="sm" label={`Actions for “${t.title}”`} icon={<Ellipsis />} />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem icon={<Pencil />} onSelect={onOpen}>
            {canWrite ? "Edit" : "View"}
          </DropdownMenuItem>
          {canWrite && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem danger icon={<Trash2 />} onSelect={onDelete}>
                Delete
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  );
}

/**
 * One task view as a card: a tinted glyph, the name, how many tasks it holds
 * (its own count query, sharing the list's key prefix so any task change
 * refreshes it) and a short line. The active view is outlined in the accent.
 */
function ViewCard({
  view,
  active,
  filters,
  current,
  onSelect,
}: {
  view: (typeof VIEWS)[number];
  active: boolean;
  filters: { type: string | null; assigneeId: string | null };
  current?: number;
  onSelect: () => void;
}) {
  const ws = useWorkspace();
  const query = { view: view.value, type: filters.type, assigneeId: filters.assigneeId, page: 1, pageSize: 1 };
  const count = useApiQuery<Paged<TaskRow>>(ws.key("tasks", "list", "count"), current === undefined ? ws.path("/tasks") : null, { query, keepPrevious: true });
  const n = current ?? count.data?.total;
  const alarm = view.value === "overdue" && Boolean(n);
  const Icon = view.icon;
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onSelect}
      className={cn(
        "group flex min-w-36 flex-1 shrink-0 flex-col gap-2.5 rounded-xl border p-3 text-left transition-all",
        "focus-visible:outline-2 focus-visible:outline-accent",
        active ? "border-accent bg-accent-soft shadow-card" : "border-line bg-panel hover:-translate-y-px hover:border-line-strong hover:shadow-card",
        alarm && !active && "border-bad-edge",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <IconTile icon={<Icon />} tint={view.tint} size="md" />
        <span className={cn("text-2xl leading-none font-semibold tabular-nums", alarm ? "text-bad-ink" : active ? "text-accent-ink" : "text-text-hi")}>
          {n === undefined ? <span className="text-text-3">·</span> : n > 999 ? "999+" : n}
        </span>
      </div>
      <div className="min-w-0">
        <div className={cn("truncate text-sm font-semibold", active ? "text-text-hi" : "text-text")}>{view.label}</div>
        <div className="truncate text-xs text-text-3">{view.hint}</div>
      </div>
    </button>
  );
}
