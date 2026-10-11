"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Dialog";
import { Field, FormError } from "@/components/ui/Field";
import { EntityTile } from "@/components/ui/icons";
import { Input } from "@/components/ui/Input";
import { useMarketing } from "@/components/marketing/common";
import { useApiMutation } from "@/lib/query";
import type { EmailDesign } from "@/lib/types/marketing";

/** Name it, create it with the starter blocks, and go straight to the editor. */
export function NewDesignModal({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const mk = useMarketing();
  const router = useRouter();
  const [name, setName] = useState("");
  const create = useApiMutation<EmailDesign, { name: string }>({
    path: mk.path("/designs"),
    invalidate: [mk.key("designs")],
    errorToast: false,
    onSuccess: (d) => router.push(mk.href(`/designs/${d.id}`)),
  });
  const change = (o: boolean) => {
    if (create.isPending) return;
    if (!o) {
      setName("");
      create.reset();
    }
    onOpenChange(o);
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (name.trim()) create.mutate({ name: name.trim() });
  };
  return (
    <Modal
      open={open}
      onOpenChange={change}
      size="sm"
      icon={<EntityTile of="designs" size="md" />}
      title="New email design"
      description="It starts with a heading, a paragraph and a button."
      footer={
        <>
          <Button onClick={() => change(false)} disabled={create.isPending}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="new-design-form" loading={create.isPending} disabled={!name.trim()}>
            Create and edit
          </Button>
        </>
      }
    >
      <form id="new-design-form" onSubmit={submit} noValidate className="flex flex-col gap-3">
        {create.error && !create.error.isPlanLimit && !create.error.fields.name && <FormError error={create.error.message} />}
        <Field label="Name" required error={create.error?.fields.name}>
          <Input autoFocus value={name} maxLength={120} onChange={(e) => setName(e.target.value)} placeholder="Monthly newsletter" />
        </Field>
      </form>
    </Modal>
  );
}
