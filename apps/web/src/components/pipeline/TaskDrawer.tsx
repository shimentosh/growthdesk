"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { MessageSquareReply, Trash2 } from "lucide-react";
import { labelOf, PRIORITIES, TASK_STATUSES, TASK_TYPES, type Channel } from "@growthdesk/shared";
import { ContactPicker, MemberPicker } from "@/components/pickers/Pickers";
import { Button } from "@/components/ui/Button";
import { Drawer } from "@/components/ui/Drawer";
import { CHANNEL, EntityTile } from "@/components/ui/icons";
import { Field, FormError } from "@/components/ui/Field";
import { Input, NativeSelect, Textarea } from "@/components/ui/Input";
import { utcToZonedInput, zonedInputToUtc } from "@/lib/format";
import { useApiMutation } from "@/lib/query";
import { useMe, useWorkspace } from "@/lib/session";
import type { TaskRow } from "@/lib/types/pipeline";
import { DealPicker } from "./DealPicker";
import { fieldErrors, formLevelError, useOpenKey } from "./utils";

const FIELDS = ["type", "title", "description", "priority", "dueAt", "remindAt", "assigneeId", "contactId", "dealId", "status"] as const;

export type TaskDefaults = {
  contactId?: string | null;
  contactLabel?: string | null;
  dealId?: string | null;
  dealLabel?: string | null;
};

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Edit this task; omit to create one. */
  task?: TaskRow | null;
  /** Prefill links when creating (e.g. from a deal). */
  defaults?: TaskDefaults;
  /** Shows a Delete button in edit mode (the caller confirms and deletes). */
  onDelete?: (task: TaskRow) => void;
};

/** Create or edit a task (TaskInput) in a side sheet. Every opening starts from the task as saved. */
export function TaskDrawer(props: Props) {
  const key = useOpenKey(props.open);
  return <TaskDrawerInner key={key} {...props} />;
}

function TaskDrawerInner({ open, onOpenChange, task, defaults, onDelete }: Props) {
  const ws = useWorkspace();
  const me = useMe();
  const tz = ws.timezone;
  const canAssign = ws.can("tasks.assign");
  const editing = Boolean(task);

  const [type, setType] = useState<string>(task?.type ?? "custom");
  const [title, setTitle] = useState(task?.title ?? "");
  const [description, setDescription] = useState(task?.description ?? "");
  const [priority, setPriority] = useState<string>(task?.priority ?? "medium");
  // datetime-local values are wall-clock times in the workspace zone, converted exactly (DST-aware) on save.
  const [dueAt, setDueAt] = useState(utcToZonedInput(task?.dueAt, tz));
  const [remindAt, setRemindAt] = useState(utcToZonedInput(task?.remindAt, tz));
  const [status, setStatus] = useState<string>(task?.status ?? "open");
  const [contactId, setContactId] = useState<string | null>(task ? task.contactId : (defaults?.contactId ?? null));
  const [dealId, setDealId] = useState<string | null>(task ? task.dealId : (defaults?.dealId ?? null));
  const [assigneeId, setAssigneeId] = useState<string | null | undefined>(task ? task.assigneeId : undefined);
  // A new task is the creator's unless they pick someone else (the API's default too).
  const assigneeValue = assigneeId === undefined ? (me.data?.user.id ?? null) : assigneeId;

  const save = useApiMutation<TaskRow, Record<string, unknown>>({
    method: editing ? "PATCH" : "POST",
    path: editing ? ws.path(`/tasks/${task!.id}`) : ws.path("/tasks"),
    // A deal record lists its tasks, so deals refresh too.
    invalidate: (t) => (t.dealId || task?.dealId ? [ws.key("tasks"), ws.key("deals")] : [ws.key("tasks")]),
    success: editing ? "Task saved" : "Task created",
    errorToast: false,
    onSuccess: () => onOpenChange(false),
  });
  const errors = fieldErrors(save.error);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate({
      type,
      title,
      description,
      priority,
      dueAt: dueAt ? zonedInputToUtc(dueAt, tz) : null,
      remindAt: remindAt ? zonedInputToUtc(remindAt, tz) : null,
      contactId,
      dealId,
      ...(editing ? { status } : {}),
      // Only a role that may assign sends an assignee; otherwise the API keeps it (or makes it the creator's).
      ...(canAssign ? { assigneeId: assigneeValue } : {}),
    });
  };

  const ChannelIcon = task?.conversation ? (CHANNEL[task.conversation.channel as Channel]?.icon ?? MessageSquareReply) : null;

  return (
    <Drawer
      open={open}
      onOpenChange={onOpenChange}
      title={editing ? "Edit task" : "New task"}
      icon={<EntityTile of="tasks" size="md" />}
      width="md"
      footer={
        <>
          {editing && onDelete && task && (
            <Button variant="danger" icon={<Trash2 />} className="mr-auto" onClick={() => onDelete(task)}>
              Delete
            </Button>
          )}
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" type="submit" form="task-form" loading={save.isPending}>
            {editing ? "Save" : "Create task"}
          </Button>
        </>
      }
    >
      <form id="task-form" onSubmit={submit} className="flex flex-col gap-4">
        <FormError error={formLevelError(save.error, FIELDS)} />
        {task?.conversation && (
          <div className="flex items-start gap-2 rounded-md bg-well px-3 py-2 text-xs text-text-3">
            {ChannelIcon && <ChannelIcon aria-hidden className="mt-px size-3.5 shrink-0" />}
            <p>
              From a {labelOf(task.conversation.channel)} conversation
              {task.conversation.subject ? `: ${task.conversation.subject}` : ""}
              {ws.can("inbox.read") && (
                <>
                  {" · "}
                  <Link href={ws.href(`/inbox?c=${task.conversation.id}`)} className="text-accent-hi hover:underline">
                    Open in inbox
                  </Link>
                </>
              )}
            </p>
          </div>
        )}
        <Field label="Title" required error={errors.title}>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={300} autoFocus={!editing} />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Type" error={errors.type}>
            <NativeSelect value={type} onChange={(e) => setType(e.target.value)} options={TASK_TYPES.map((t) => ({ value: t, label: labelOf(t) }))} />
          </Field>
          <Field label="Priority" error={errors.priority}>
            <NativeSelect value={priority} onChange={(e) => setPriority(e.target.value)} options={PRIORITIES.map((p) => ({ value: p, label: labelOf(p) }))} />
          </Field>
          <Field label="Due" hint={`Workspace time (${tz})`} error={errors.dueAt}>
            <Input type="datetime-local" value={dueAt} onChange={(e) => setDueAt(e.target.value)} />
          </Field>
          <Field label="Reminder" hint="Notifies the assignee at this time." error={errors.remindAt}>
            <Input type="datetime-local" value={remindAt} onChange={(e) => setRemindAt(e.target.value)} />
          </Field>
          {editing && (
            <Field label="Status" error={errors.status}>
              <NativeSelect
                value={status}
                onChange={(e) => setStatus(e.target.value)}
                options={TASK_STATUSES.map((s) => ({
                  value: s,
                  label: labelOf(s),
                }))}
              />
            </Field>
          )}
          {canAssign && (
            <Field label="Assignee" error={errors.assigneeId}>
              <MemberPicker value={assigneeValue} valueLabel={task?.assignee?.name} onChange={(id) => setAssigneeId(id)} placeholder="Unassigned" />
            </Field>
          )}
        </div>
        <Field label="Contact" error={errors.contactId}>
          <ContactPicker value={contactId} valueLabel={task?.contact?.fullName || task?.contact?.email || defaults?.contactLabel} onChange={(id) => setContactId(id)} />
        </Field>
        <Field label="Deal" error={errors.dealId}>
          <DealPicker value={dealId} valueLabel={task?.deal?.name ?? defaults?.dealLabel} onChange={(id) => setDealId(id)} />
        </Field>
        <Field label="Notes" error={errors.description}>
          <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={4} maxLength={5000} />
        </Field>
      </form>
    </Drawer>
  );
}
