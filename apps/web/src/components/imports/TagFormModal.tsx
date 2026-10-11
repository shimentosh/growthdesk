"use client";

import { useState, type FormEvent } from "react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Dialog";
import { Field, FormError } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { cn } from "@/lib/cn";
import { useApiMutation } from "@/lib/query";
import { useWorkspace } from "@/lib/session";
import type { TagCreated, TagRow } from "@/lib/types/crm-settings";
import { TAG_COLORS, tagTone } from "./labels";

type TagBody = { name: string; color: string };

/** Create a tag, or rename / recolour one (`tag` given). Mount it when opening so it starts fresh. */
export function TagFormModal({ tag, onClose }: { tag: TagRow | null; onClose: () => void }) {
  const ws = useWorkspace();
  const [name, setName] = useState(tag?.name ?? "");
  const [color, setColor] = useState(tag?.color ?? "gray");

  const save = useApiMutation<TagCreated | { updated: true }, TagBody>({
    method: tag ? "PATCH" : "POST",
    path: tag ? ws.path(`/tags/${tag.id}`) : ws.path("/tags"),
    invalidate: [ws.key("tags")],
    success: tag ? "Tag saved" : "Tag created",
    errorToast: false,
    onSuccess: onClose,
  });

  const fields = save.error?.fields ?? {};
  // A duplicate name answers 409 without a field; it belongs under the name.
  const nameError = fields.name ?? (save.error?.status === 409 ? save.error.message : undefined);
  const formError = save.isError && !nameError && !fields.color ? save.error.message : undefined;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate({ name: name.trim(), color });
  };

  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      size="sm"
      title={tag ? "Edit tag" : "New tag"}
      description={tag ? "Renaming changes the tag everywhere it is used." : undefined}
      footer={
        <>
          <Button onClick={onClose} disabled={save.isPending}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="tag-form" loading={save.isPending} disabled={!name.trim()}>
            {tag ? "Save" : "Create tag"}
          </Button>
        </>
      }
    >
      <form id="tag-form" onSubmit={submit} className="flex flex-col gap-4">
        <Field label="Name" required error={nameError}>
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={50} autoFocus placeholder="e.g. Hot lead" />
        </Field>
        <Field label="Colour" error={fields.color}>
          <div role="radiogroup" aria-label="Colour" className="flex flex-wrap gap-1.5">
            {TAG_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                role="radio"
                aria-checked={color === c}
                onClick={() => setColor(c)}
                className={cn("rounded-sm p-0.5 transition-shadow", color === c ? "ring-2 ring-accent" : "hover:ring-1 hover:ring-line-strong")}
              >
                <Badge tone={tagTone(c)}>{c.charAt(0).toUpperCase() + c.slice(1)}</Badge>
              </button>
            ))}
          </div>
        </Field>
        <div className="flex items-center gap-2 text-xs text-text-3">
          Preview
          <Badge tone={tagTone(color)}>{name.trim() || "Tag name"}</Badge>
        </div>
        <FormError error={formError} />
      </form>
    </Modal>
  );
}
