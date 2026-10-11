"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Callout } from "@/components/ui/Callout";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Dialog";
import { Field, FormError } from "@/components/ui/Field";
import { useApiMutation, useApiQuery } from "@/lib/query";
import { useWorkspace } from "@/lib/session";
import type { Deal, DealDetail, Pipeline } from "@/lib/types/pipeline";
import { DealPicker } from "./DealPicker";
import { NewDealModal } from "./NewDealModal";
import { useOpenKey } from "./utils";

/** The contact a deal is being created for or linked to. */
export type DealContact = { id: string; label: string; company?: { id: string; name: string } | null };

/**
 * State and dialogs behind "New deal" and "Link to existing deal" for one
 * contact. The caller renders the triggers (a button, a menu item) and calls
 * `openNew()` / `openLink()`; `dialogs` must be rendered somewhere on the page.
 * `canWrite` is false without deals.write (hide the triggers then).
 */
export function useContactDealActions(contact: DealContact | null) {
  const ws = useWorkspace();
  const router = useRouter();
  const canWrite = ws.can("deals.write") && ws.can("deals.read") && Boolean(contact);
  const [newOpen, setNewOpen] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  const pipelines = useApiQuery<Pipeline[]>(ws.key("pipelines"), canWrite ? ws.path("/pipelines") : null);
  const pipelineList = pipelines.data ?? [];

  const dialogs = canWrite && contact ? (
    <>
      {pipelines.data && (
        <NewDealModal
          open={newOpen}
          onOpenChange={setNewOpen}
          pipelines={pipelineList}
          contact={contact}
          onCreated={(d: DealDetail) => router.push(ws.href(`/deals/${d.id}`))}
        />
      )}
      <LinkDealModal open={linkOpen} onOpenChange={setLinkOpen} contact={contact} />
    </>
  ) : null;

  return {
    canWrite,
    /** No pipeline yet: a deal cannot be created until one exists. */
    noPipeline: pipelines.isSuccess && pipelineList.length === 0,
    pipelinesLoading: pipelines.isPending && canWrite,
    openNew: () => setNewOpen(true),
    openLink: () => setLinkOpen(true),
    dialogs,
  };
}

/** PATCH /deals/:id { contactId }: a deal has one contact, so this replaces any contact it had. */
function LinkDealModal(props: { open: boolean; onOpenChange: (open: boolean) => void; contact: DealContact }) {
  const key = useOpenKey(props.open);
  return <LinkDealDialog key={key} {...props} />;
}

function LinkDealDialog({ open, onOpenChange, contact }: { open: boolean; onOpenChange: (open: boolean) => void; contact: DealContact }) {
  const ws = useWorkspace();
  const [deal, setDeal] = useState<Deal | null>(null);
  const [error, setError] = useState<string | null>(null);
  const link = useApiMutation<DealDetail, { dealId: string; body: Record<string, unknown> }>({
    method: "PATCH",
    path: ({ dealId }) => ws.path(`/deals/${dealId}`),
    body: ({ body }) => body,
    invalidate: [ws.key("deals"), ws.key("contacts"), ws.key("companies"), ws.key("inbox")],
    success: (d) => `“${d.name}” linked to ${contact.label}`,
    errorToast: false,
    onSuccess: () => onOpenChange(false),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!deal) {
      setError("Choose a deal.");
      return;
    }
    link.mutate({
      dealId: deal.id,
      // Fill the company from the contact only when the deal has none.
      body: { contactId: contact.id, ...(!deal.company && contact.company ? { companyId: contact.company.id } : {}) },
    });
  };

  const replaces = deal?.contact && deal.contact.id !== contact.id ? deal.contact : null;
  const already = deal?.contact?.id === contact.id;

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Link to an existing deal"
      description={`The deal's contact becomes ${contact.label}.`}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" type="submit" form="link-deal" loading={link.isPending} disabled={already}>
            Link deal
          </Button>
        </>
      }
    >
      <form id="link-deal" onSubmit={submit} className="flex flex-col gap-4">
        <FormError error={link.error ? (link.error.fields.contactId ?? link.error.message) : null} />
        <Field label="Deal" required error={error}>
          <DealPicker
            value={deal?.id ?? null}
            valueLabel={deal?.name}
            onChange={(_id, d) => {
              setError(null);
              setDeal(d);
            }}
          />
        </Field>
        {replaces && (
          <Callout tone="warn">
            This deal is linked to {replaces.fullName || replaces.email || "another contact"}. A deal has one contact, so linking it here replaces them.
          </Callout>
        )}
        {already && <Callout tone="info">This deal is already linked to {contact.label}.</Callout>}
      </form>
    </Modal>
  );
}
