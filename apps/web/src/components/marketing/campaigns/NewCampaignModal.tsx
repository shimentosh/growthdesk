"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Dialog";
import { Field, FormError } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { useMarketing } from "@/components/marketing/common";
import { useApiMutation } from "@/lib/query";
import type { MarketingCampaign } from "@/lib/types/marketing";

/**
 * Name a campaign; the API fills in the sender from the company profile, the
 * first verified domain and a starter design. Opens the new draft.
 */
export function NewCampaignModal({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const mk = useMarketing();
  const router = useRouter();
  const [name, setName] = useState("");
  const create = useApiMutation<MarketingCampaign, { name: string }>({
    path: mk.path("/campaigns"),
    invalidate: [mk.key("campaigns")],
    success: "Campaign created",
    errorToast: false,
    onSuccess: (c) => {
      onOpenChange(false);
      setName("");
      router.push(mk.href(`/campaigns/${c.id}`));
    },
  });
  const change = (next: boolean) => {
    if (!next) {
      setName("");
      create.reset();
    }
    onOpenChange(next);
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate({ name: name.trim() });
  };
  const fields = create.error?.fields ?? {};

  return (
    <Modal
      open={open}
      onOpenChange={change}
      title="New email campaign"
      description="It starts as a draft with a starter design. Write the email, choose the lists, then send a test before sending it for real."
      footer={
        <>
          <Button onClick={() => change(false)} disabled={create.isPending}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="new-mk-campaign" loading={create.isPending} disabled={!name.trim()}>
            Create campaign
          </Button>
        </>
      }
    >
      <form id="new-mk-campaign" onSubmit={submit} noValidate className="flex flex-col gap-4">
        {create.error && !create.error.isPlanLimit && !Object.keys(fields).length && <FormError error={create.error.message} />}
        <Field label="Name" required error={fields.name} hint="Only your team sees this. Recipients see the subject line.">
          <Input value={name} maxLength={120} autoFocus onChange={(e) => setName(e.target.value)} placeholder="November newsletter" />
        </Field>
      </form>
    </Modal>
  );
}
