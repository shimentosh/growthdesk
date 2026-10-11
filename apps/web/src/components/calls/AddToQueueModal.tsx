"use client";

import { useState, type FormEvent } from "react";
import { X } from "lucide-react";
import { ContactPicker, contactLabel } from "@/components/pickers/Pickers";
import { fieldErrors, formLevelError, useOpenKey } from "@/components/pipeline/utils";
import { Button, IconButton } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Dialog";
import { Field, FormError } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { toast } from "@/components/ui/Toast";
import { zonedInputToUtc } from "@/lib/format";
import { useApiMutation } from "@/lib/query";
import { useWorkspace } from "@/lib/session";
import type { ContactSummary } from "@/lib/types";
import type { CallQueueAddResult } from "@/lib/types/calls";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Start with these contacts chosen (e.g. from a contact record). */
  initial?: Pick<ContactSummary, "id" | "fullName" | "firstName" | "lastName" | "email" | "phone">[];
};

/**
 * Puts contacts on your own call list — one call task each. Contacts who
 * cannot be called, or are already on your list, are skipped and named.
 */
export function AddToQueueModal(props: Props) {
  const key = useOpenKey(props.open);
  return <Inner key={key} {...props} />;
}

function Inner({ open, onOpenChange, initial }: Props) {
  const ws = useWorkspace();
  const [chosen, setChosen] = useState(initial ?? []);
  const [dueAt, setDueAt] = useState("");
  const [note, setNote] = useState("");
  const [skipped, setSkipped] = useState<{ label: string; reason: string }[]>([]);

  const add = useApiMutation<CallQueueAddResult, Record<string, unknown>>({
    path: ws.path("/calls/queue"),
    invalidate: [ws.key("calls"), ws.key("tasks"), ws.key("contacts")],
    errorToast: false,
    onSuccess: (r) => {
      if (r.added) toast.success(r.added === 1 ? "Added to your call list" : `${r.added} contacts added to your call list`);
      if (!r.skipped.length) {
        onOpenChange(false);
        return;
      }
      const label = (id: string) => {
        const c = chosen.find((x) => x.id === id);
        return c ? contactLabel(c) : "A contact";
      };
      setSkipped(r.skipped.map((s) => ({ label: label(s.contactId), reason: s.reason })));
      setChosen([]);
    },
  });
  const errors = fieldErrors(add.error);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setSkipped([]);
    add.mutate({
      contactIds: chosen.map((c) => c.id),
      dueAt: dueAt ? zonedInputToUtc(dueAt, ws.timezone) : null,
      note: note.trim() || undefined,
    });
  };

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      dismissOnOutside={false}
      title="Add to call list"
      description="Each contact becomes a call task assigned to you. You work through the list yourself — nothing is dialled automatically."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>{skipped.length ? "Done" : "Cancel"}</Button>
          <Button variant="primary" type="submit" form="queue-add" loading={add.isPending} disabled={!chosen.length}>
            Add {chosen.length > 1 ? `${chosen.length} contacts` : ""}
          </Button>
        </>
      }
    >
      <form id="queue-add" onSubmit={submit} className="flex flex-col gap-3">
        <FormError error={formLevelError(add.error, ["contactIds", "dueAt", "note"])} />
        <Field label="Contacts" error={errors.contactIds}>
          <ContactPicker
            value={null}
            clearable={false}
            placeholder="Find a contact to add"
            onChange={(_, c) => {
              if (c && !chosen.some((x) => x.id === c.id)) setChosen((list) => [...list, c]);
            }}
          />
        </Field>
        {chosen.length > 0 && (
          <ul className="flex flex-col divide-y divide-line rounded-md border border-line">
            {chosen.map((c) => (
              <li key={c.id} className="flex items-center justify-between gap-2 px-3 py-1.5 text-sm">
                <span className="min-w-0 truncate">
                  {contactLabel(c)}
                  <span className="ml-2 text-xs text-text-3">{c.phone || "No phone"}</span>
                </span>
                <IconButton size="sm" label={`Remove ${contactLabel(c)}`} icon={<X />} onClick={() => setChosen((list) => list.filter((x) => x.id !== c.id))} />
              </li>
            ))}
          </ul>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Due" hint={`Optional. Workspace time (${ws.timezone}).`} error={errors.dueAt}>
            <Input type="datetime-local" value={dueAt} onChange={(e) => setDueAt(e.target.value)} />
          </Field>
          <Field label="Note" hint="Optional. Shown on each task." error={errors.note}>
            <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} />
          </Field>
        </div>
        {skipped.length > 0 && (
          <div className="rounded-md border border-warn-edge bg-warn-wash px-3 py-2 text-sm">
            <div className="font-medium text-warn-ink">Not added</div>
            <ul className="mt-1 flex flex-col gap-0.5 text-xs text-text-2">
              {skipped.map((s, i) => (
                <li key={i}>
                  {s.label}: {s.reason}
                </li>
              ))}
            </ul>
          </div>
        )}
      </form>
    </Modal>
  );
}
