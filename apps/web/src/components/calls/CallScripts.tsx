"use client";

import { useState, type FormEvent } from "react";
import { FileText, Pencil, Plus, Trash2 } from "lucide-react";
import { STANDARD_VARIABLES } from "@growthdesk/shared";
import { fieldErrors, formLevelError, useOpenKey } from "@/components/pipeline/utils";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { ConfirmDialog, Modal } from "@/components/ui/Dialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { QueryState } from "@/components/ui/ErrorState";
import { Field, FormError } from "@/components/ui/Field";
import { IconBadge } from "@/components/ui/IconTile";
import { Input, Textarea } from "@/components/ui/Input";
import { SkeletonText } from "@/components/ui/Skeleton";
import { useApiMutation } from "@/lib/query";
import { useFormat, useWorkspace } from "@/lib/session";
import type { CallScript } from "@/lib/types/calls";
import { useCallScripts } from "./callHooks";

/** The variables a script can use: a contact's own fields and the caller's name (no links — a script is read aloud). */
const SCRIPT_VARIABLES = STANDARD_VARIABLES.filter((v) => v.key !== "unsubscribe_url" && v.key !== "sender_email");

/** The workspace's call scripts: what reps read from while on a call. */
export function CallScriptsPanel() {
  const ws = useWorkspace();
  const f = useFormat();
  const scripts = useCallScripts();
  const canWrite = ws.can("calls.make");
  const [editing, setEditing] = useState<CallScript | "new" | null>(null);
  const [deleting, setDeleting] = useState<CallScript | null>(null);
  const remove = useApiMutation<unknown, CallScript>({
    method: "DELETE",
    path: (s) => ws.path(`/call-scripts/${s.id}`),
    invalidate: [ws.key("calls", "scripts")],
    success: "Script deleted",
    errorToast: false,
  });

  return (
    <div className="flex flex-col gap-4">
      {canWrite && (scripts.data?.length ?? 0) > 0 && (
        <div>
          <Button icon={<Plus />} onClick={() => setEditing("new")}>
            New script
          </Button>
        </div>
      )}
      <QueryState
        query={scripts}
        loading={
          <Card className="p-4">
            <SkeletonText lines={4} />
          </Card>
        }
        isEmpty={(d) => d.length === 0}
        empty={
          <Card>
            <EmptyState
              icon={<FileText />}
              tint="teal"
              title="No call scripts yet"
              description="A script is the talk track a rep reads from on a call. Tokens like {{first_name}} are filled in from the contact being called."
              action={
                canWrite ? (
                  <Button icon={<Plus />} onClick={() => setEditing("new")}>
                    New script
                  </Button>
                ) : undefined
              }
            />
          </Card>
        }
      >
        {(rows) => (
          <div className="grid gap-4 lg:grid-cols-2">
            {rows.map((s) => (
              <Card key={s.id} className="flex flex-col gap-2 p-4">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex min-w-0 items-start gap-2.5">
                    <IconBadge icon={<FileText />} tint="teal" />
                    <div className="min-w-0">
                      <h3 className="truncate text-sm font-semibold text-text-hi">{s.name}</h3>
                      <p className="text-xs text-text-3">Updated {f.relative(s.updatedAt)}</p>
                    </div>
                  </div>
                  {canWrite && (
                    <div className="flex shrink-0 gap-1">
                      <Button size="sm" variant="ghost" icon={<Pencil />} onClick={() => setEditing(s)}>
                        Edit
                      </Button>
                      <Button size="sm" variant="ghost" icon={<Trash2 />} onClick={() => setDeleting(s)}>
                        Delete
                      </Button>
                    </div>
                  )}
                </div>
                <p className="line-clamp-6 text-sm whitespace-pre-wrap text-text-2">{s.body}</p>
              </Card>
            ))}
          </div>
        )}
      </QueryState>

      <ScriptModal open={editing !== null} onOpenChange={(o) => !o && setEditing(null)} script={editing === "new" ? null : editing} />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={deleting ? `Delete “${deleting.name}”?` : "Delete script?"}
        description="Reps can no longer pick it. Calls that used it are kept."
        onConfirm={() => (deleting ? remove.mutateAsync(deleting) : undefined)}
      />
    </div>
  );
}

function ScriptModal(props: { open: boolean; onOpenChange: (open: boolean) => void; script: CallScript | null }) {
  const key = useOpenKey(props.open);
  return <ScriptModalInner key={key} {...props} />;
}

function ScriptModalInner({ open, onOpenChange, script }: { open: boolean; onOpenChange: (open: boolean) => void; script: CallScript | null }) {
  const ws = useWorkspace();
  const [name, setName] = useState(script?.name ?? "");
  const [body, setBody] = useState(script?.body ?? "");
  const save = useApiMutation<CallScript, { name: string; body: string }>({
    method: script ? "PATCH" : "POST",
    path: script ? ws.path(`/call-scripts/${script.id}`) : ws.path("/call-scripts"),
    invalidate: [ws.key("calls", "scripts")],
    success: script ? "Script saved" : "Script created",
    errorToast: false,
    onSuccess: () => onOpenChange(false),
  });
  const errors = fieldErrors(save.error);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate({ name, body });
  };
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      dismissOnOutside={false}
      size="lg"
      title={script ? "Edit script" : "New call script"}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" type="submit" form="script-form" loading={save.isPending}>
            {script ? "Save" : "Create script"}
          </Button>
        </>
      }
    >
      <form id="script-form" onSubmit={submit} className="flex flex-col gap-3">
        <FormError error={formLevelError(save.error, ["name", "body"])} />
        <Field label="Name" required error={errors.name}>
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} autoFocus />
        </Field>
        <Field
          label="Script"
          required
          error={errors.body}
          hint={`Variables: ${SCRIPT_VARIABLES.map((v) => `{{${v.key}}}`).join(" ")} {{custom.<field>}}. A fallback goes after a pipe: {{first_name|there}}.`}
        >
          <Textarea value={body} onChange={(e) => setBody(e.target.value)} rows={14} maxLength={20000} />
        </Field>
      </form>
    </Modal>
  );
}
