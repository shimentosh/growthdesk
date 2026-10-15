"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Dialog";
import { Field, FormError } from "@/components/ui/Field";
import { Input, NativeSelect } from "@/components/ui/Input";
import { useApiMutation, useApiQuery } from "@/lib/query";
import { useWorkspace, workspaceDetailKey } from "@/lib/session";
import type { Paged } from "@/lib/types";
import type { CampaignCreateBody, CampaignDetail } from "@/lib/types/campaigns";
import type { Sequence } from "@/lib/types/sequences";

/**
 * Name a campaign and start it blank or from a library sequence (POST
 * /campaigns with fromSequenceId copies the sequence's steps into the
 * campaign's own copy). Opens the new campaign on success.
 * `initialSequenceId` preselects a sequence ("Use in campaign" on the
 * sequences pages); it is read when the modal mounts and after each close.
 */
export function NewCampaignModal({ open, onOpenChange, initialSequenceId }: { open: boolean; onOpenChange: (open: boolean) => void; initialSequenceId?: string }) {
  const ws = useWorkspace();
  const router = useRouter();
  const [name, setName] = useState("");
  const [sequenceId, setSequenceId] = useState(initialSequenceId ?? "");
  const sequences = useApiQuery<Paged<Sequence>>(ws.key("sequences", "list", "picker"), open ? ws.path("/sequences") : null, { query: { pageSize: 200 } });
  const create = useApiMutation<CampaignDetail, CampaignCreateBody>({
    path: ws.path("/campaigns"),
    invalidate: [ws.key("campaigns"), workspaceDetailKey(ws.id)],
    success: "Campaign created",
    errorToast: false,
    onSuccess: (c) => {
      onOpenChange(false);
      router.push(ws.href(`/campaigns/${c.id}`));
    },
  });
  const change = (next: boolean) => {
    if (!next) {
      setName("");
      setSequenceId(initialSequenceId ?? "");
      create.reset();
    }
    onOpenChange(next);
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate({ name: name.trim(), ...(sequenceId ? { fromSequenceId: sequenceId } : {}) });
  };
  const fields = create.error?.fields ?? {};
  const rows = sequences.data?.items ?? [];

  return (
    <Modal
      open={open}
      onOpenChange={change}
      title="New campaign"
      description="It starts as a draft: choose the audience, mailboxes and send window, then launch it."
      footer={
        <>
          <Button onClick={() => change(false)} disabled={create.isPending}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="new-campaign" loading={create.isPending}>
            Create campaign
          </Button>
        </>
      }
    >
      <form id="new-campaign" onSubmit={submit} noValidate className="flex flex-col gap-4">
        {create.error && !create.error.isPlanLimit && !Object.keys(fields).length && <FormError error={create.error.message} />}
        <Field label="Name" required error={fields.name}>
          <Input value={name} maxLength={120} autoFocus onChange={(e) => setName(e.target.value)} placeholder="Q4 agencies outbound" />
        </Field>
        <Field
          label="Start from"
          error={fields.fromSequenceId ?? fields.steps}
          hint={sequenceId ? "The sequence's steps are copied; later edits to the sequence do not change this campaign." : "Add steps yourself after creating it."}
        >
          <NativeSelect
            value={sequenceId}
            onChange={(e) => setSequenceId(e.target.value)}
            disabled={sequences.isPending && open}
            options={[
              { value: "", label: "Blank campaign" },
              ...rows.map((s) => ({ value: s.id, label: `${s.name} (${s.stepCount} step${s.stepCount === 1 ? "" : "s"})` })),
            ]}
          />
        </Field>
        {sequences.isError && <p className="text-xs text-bad-ink">Sequences could not be loaded: {sequences.error.message}</p>}
      </form>
    </Modal>
  );
}
