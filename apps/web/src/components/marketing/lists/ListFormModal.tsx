"use client";

import { useState, type FormEvent } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Dialog";
import { Field, FormError } from "@/components/ui/Field";
import { EntityTile } from "@/components/ui/icons";
import { Input, Textarea } from "@/components/ui/Input";
import { Switch } from "@/components/ui/Switch";
import { useApiMutation } from "@/lib/query";
import type { MarketingList } from "@/lib/types/marketing";
import { useMarketing } from "../common";

type Body = { name: string; description: string; doubleOptIn: boolean };

/**
 * Create a list (POST marketing/lists) or rename and describe one (PATCH
 * marketing/lists/:id). Mount it with a `key` that changes per opening so the
 * fields start from the saved values.
 */
export function ListFormModal({
  open,
  onOpenChange,
  list,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Edit this list; without it, a new one is created. */
  list?: MarketingList;
  onSaved?: (list: MarketingList) => void;
}) {
  const mk = useMarketing();
  const [name, setName] = useState(list?.name ?? "");
  const [description, setDescription] = useState(list?.description ?? "");
  const [doubleOptIn, setDoubleOptIn] = useState(list?.doubleOptIn ?? false);
  const save = useApiMutation<MarketingList, Body>({
    method: list ? "PATCH" : "POST",
    path: mk.path(list ? `/lists/${list.id}` : "/lists"),
    invalidate: [mk.key("lists")],
    success: list ? "List saved" : "List created",
    errorToast: false,
    onSuccess: (saved) => {
      onOpenChange(false);
      onSaved?.(saved);
    },
  });
  const change = (next: boolean) => {
    if (!next && save.isPending) return;
    if (!next) {
      setName(list?.name ?? "");
      setDescription(list?.description ?? "");
      setDoubleOptIn(list?.doubleOptIn ?? false);
      save.reset();
    }
    onOpenChange(next);
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate({ name: name.trim(), description: description.trim(), doubleOptIn });
  };
  const fields = save.error?.fields ?? {};

  return (
    <Modal
      open={open}
      onOpenChange={change}
      icon={<EntityTile of="lists" size="md" />}
      title={list ? "Edit list" : "New list"}
      description={list ? "Subscribers see the name and description when they choose their lists." : "People join it from the list page, the Contacts table or a contact's page."}
      footer={
        <>
          <Button onClick={() => change(false)} disabled={save.isPending}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="list-form" icon={list ? undefined : <Plus />} loading={save.isPending} disabled={!name.trim()}>
            {list ? "Save" : "Create list"}
          </Button>
        </>
      }
    >
      <form id="list-form" onSubmit={submit} noValidate className="flex flex-col gap-4">
        {save.error && !save.error.isPlanLimit && !Object.keys(fields).length && <FormError error={save.error.message} />}
        <Field label="Name" required error={fields.name}>
          <Input value={name} maxLength={120} autoFocus onChange={(e) => setName(e.target.value)} placeholder="Monthly newsletter" />
        </Field>
        <Field label="Description" error={fields.description} hint="What subscribers get and how often. They see it on their email preferences page.">
          <Textarea value={description} maxLength={500} rows={3} onChange={(e) => setDescription(e.target.value)} placeholder="Product news and tips, once a month." />
        </Field>
        <Field error={fields.doubleOptIn}>
          <Switch
            checked={doubleOptIn}
            onCheckedChange={setDoubleOptIn}
            label="Require confirmation (double opt-in)"
            description={
              list?.doubleOptIn && !doubleOptIn
                ? "People already waiting stay pending until they confirm; nobody new is asked."
                : "People added without recorded consent are emailed a link and join only once they confirm. Needs a connected email service and a verified sending domain."
            }
          />
        </Field>
      </form>
    </Modal>
  );
}
