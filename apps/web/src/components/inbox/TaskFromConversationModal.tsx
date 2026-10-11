"use client";

import { useState, type FormEvent } from "react";
import { labelOf, PRIORITIES, TASK_TYPES } from "@growthdesk/shared";
import { MemberPicker } from "@/components/pickers/Pickers";
import { fieldErrors, formLevelError, useOpenKey } from "@/components/pipeline/utils";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Dialog";
import { Field, FormError } from "@/components/ui/Field";
import { Input, NativeSelect, Textarea } from "@/components/ui/Input";
import { zonedInputToUtc } from "@/lib/format";
import { useApiMutation } from "@/lib/query";
import { useMe, useWorkspace } from "@/lib/session";
import type { ConversationDetail } from "@/lib/types/inbox";

const FIELDS = ["type", "title", "description", "priority", "dueAt", "assigneeId"] as const;

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  conversation: ConversationDetail;
};

/** A follow-up task linked to the conversation, its contact, deal and campaign (POST /inbox/conversations/:id/tasks). */
export function TaskFromConversationModal(props: Props) {
  const key = useOpenKey(props.open);
  return <Inner key={key} {...props} />;
}

function Inner({ open, onOpenChange, conversation: c }: Props) {
  const ws = useWorkspace();
  const me = useMe();
  const tz = ws.timezone;
  const canAssign = ws.can("tasks.assign");
  const [type, setType] = useState("custom");
  const [title, setTitle] = useState("");
  const [priority, setPriority] = useState("medium");
  const [dueAt, setDueAt] = useState("");
  const [description, setDescription] = useState("");
  const [assigneeId, setAssigneeId] = useState<string | null | undefined>(undefined);
  const assigneeValue = assigneeId === undefined ? (me.data?.user.id ?? null) : assigneeId;

  const create = useApiMutation<{ id: string }, Record<string, unknown>>({
    path: ws.path(`/inbox/conversations/${c.id}/tasks`),
    invalidate: [ws.key("inbox", "detail", c.id), ws.key("tasks"), ws.key("contacts")],
    success: "Task created",
    errorToast: false,
    onSuccess: () => onOpenChange(false),
  });
  const errors = fieldErrors(create.error);
  // The API's own default title.
  const fallbackTitle = `Follow up with ${c.displayName || c.handle || "this conversation"}`;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate({
      type,
      priority,
      ...(title.trim() ? { title: title.trim() } : {}),
      ...(description.trim() ? { description: description.trim() } : {}),
      dueAt: dueAt ? zonedInputToUtc(dueAt, tz) : null,
      ...(canAssign ? { assigneeId: assigneeValue } : {}),
    });
  };

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Create follow-up task"
      description="Linked to this conversation and, when there is one, its contact and deal."
      dismissOnOutside={false}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" type="submit" form="conversation-task-form" loading={create.isPending}>
            Create task
          </Button>
        </>
      }
    >
      <form id="conversation-task-form" onSubmit={submit} className="flex flex-col gap-4">
        <FormError error={formLevelError(create.error, FIELDS)} />
        <Field label="Title" error={errors.title} hint="Leave blank to use the suggestion.">
          <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={300} placeholder={fallbackTitle} autoFocus />
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
          {canAssign && (
            <Field label="Assignee" error={errors.assigneeId}>
              <MemberPicker value={assigneeValue} onChange={(id) => setAssigneeId(id)} placeholder="Unassigned" />
            </Field>
          )}
        </div>
        <Field label="Notes" error={errors.description}>
          <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} maxLength={5000} />
        </Field>
      </form>
    </Modal>
  );
}
