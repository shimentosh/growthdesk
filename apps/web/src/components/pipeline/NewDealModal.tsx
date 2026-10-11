"use client";

import { useMemo, useState, type FormEvent } from "react";
import { labelOf } from "@growthdesk/shared";
import { CompanyPicker, ContactPicker, MemberPicker } from "@/components/pickers/Pickers";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Dialog";
import { Field, FormError } from "@/components/ui/Field";
import { Input, NativeSelect, Textarea } from "@/components/ui/Input";
import { currencies } from "@/lib/format";
import { useApiMutation } from "@/lib/query";
import { useWorkspace } from "@/lib/session";
import type { DealDetail, Pipeline } from "@/lib/types/pipeline";
import { fieldErrors, formLevelError, parseAmount, useOpenKey } from "./utils";

const FIELDS = ["name", "pipelineId", "stageId", "contactId", "companyId", "ownerId", "value", "currency", "expectedCloseDate", "description"] as const;

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pipelines: Pipeline[];
  /** The pipeline the board is showing. */
  pipelineId?: string;
  /** Preselect a stage (the column's "+" button). */
  stageId?: string;
  /** Prefill the contact (and their company), e.g. "New deal" from a conversation or a contact record. */
  contact?: { id: string; label: string; company?: { id: string; name: string } | null } | null;
  onCreated?: (deal: DealDetail) => void;
};

/** POST /deals (DealInput). Every opening starts with a blank form. */
export function NewDealModal(props: Props) {
  const key = useOpenKey(props.open);
  return <NewDealDialog key={key} {...props} />;
}

function NewDealDialog({ open, onOpenChange, pipelines, pipelineId: initialPipeline, stageId: initialStage, contact, onCreated }: Props) {
  const ws = useWorkspace();
  const currencyOptions = useMemo(() => currencies().map((c) => ({ value: c.code, label: c.label })), []);
  const [name, setName] = useState("");
  const [pipelineId, setPipelineId] = useState(initialPipeline ?? pipelines[0]?.id ?? "");
  const pipeline = pipelines.find((p) => p.id === pipelineId);
  const firstOpen = (p?: Pipeline) => p?.stages.find((s) => s.kind === "open")?.id ?? "";
  const [stageId, setStageId] = useState(initialStage ?? firstOpen(pipeline));
  const [value, setValue] = useState("");
  const [currency, setCurrency] = useState(ws.currency);
  const [contactId, setContactId] = useState<string | null>(contact?.id ?? null);
  const [companyId, setCompanyId] = useState<string | null>(contact?.company?.id ?? null);
  const [companyLabel, setCompanyLabel] = useState<string | null>(contact?.company?.name ?? null);
  const [ownerId, setOwnerId] = useState<string | null>(null);
  const [closeDate, setCloseDate] = useState("");
  const [description, setDescription] = useState("");

  const create = useApiMutation<DealDetail, Record<string, unknown>>({
    path: ws.path("/deals"),
    // Contacts, companies and conversations list their deals too.
    invalidate: [ws.key("deals"), ws.key("contacts"), ws.key("companies"), ws.key("inbox")],
    success: (d) => `Deal “${d.name}” created`,
    errorToast: false,
    onSuccess: (d) => {
      onOpenChange(false);
      onCreated?.(d);
    },
  });
  const errors = fieldErrors(create.error);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate({
      name,
      pipelineId: pipelineId || undefined,
      stageId: stageId || undefined,
      value: parseAmount(value),
      currency,
      contactId,
      companyId,
      // Left empty, the API makes the creator the owner.
      ...(ownerId ? { ownerId } : {}),
      // A calendar date: "2026-10-09" is read by the API as UTC midnight, which is how it is stored.
      expectedCloseDate: closeDate || null,
      description: description || undefined,
    });
  };

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="New deal"
      size="lg"
      dismissOnOutside={false}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" type="submit" form="new-deal" loading={create.isPending}>
            Create deal
          </Button>
        </>
      }
    >
      <form id="new-deal" onSubmit={submit} className="flex flex-col gap-4">
        <FormError error={formLevelError(create.error, FIELDS)} />
        <Field label="Name" required error={errors.name}>
          <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus maxLength={200} placeholder="e.g. Acme — website redesign" />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          {pipelines.length > 1 && (
            <Field label="Pipeline" error={errors.pipelineId}>
              <NativeSelect
                value={pipelineId}
                onChange={(e) => {
                  setPipelineId(e.target.value);
                  setStageId(firstOpen(pipelines.find((p) => p.id === e.target.value)));
                }}
                options={pipelines.map((p) => ({ value: p.id, label: p.name }))}
              />
            </Field>
          )}
          <Field label="Stage" error={errors.stageId}>
            <NativeSelect
              value={stageId}
              onChange={(e) => setStageId(e.target.value)}
              options={(pipeline?.stages ?? []).map((s) => ({ value: s.id, label: s.kind === "open" ? s.name : `${s.name} (${labelOf(s.kind)})` }))}
            />
          </Field>
          <Field label="Value" error={errors.value}>
            <Input type="number" inputMode="decimal" min={0} step="0.01" value={value} onChange={(e) => setValue(e.target.value)} placeholder="0" />
          </Field>
          <Field label="Currency" error={errors.currency}>
            <NativeSelect value={currency} onChange={(e) => setCurrency(e.target.value)} options={currencyOptions} />
          </Field>
          <Field label="Contact" error={errors.contactId}>
            <ContactPicker
              value={contactId}
              valueLabel={contact && contactId === contact.id ? contact.label : undefined}
              onChange={(id, c) => {
                setContactId(id);
                // Fill the company from the contact when none is chosen yet.
                if (c?.company && !companyId) {
                  setCompanyId(c.company.id);
                  setCompanyLabel(c.company.name);
                }
              }}
            />
          </Field>
          <Field label="Company" error={errors.companyId}>
            <CompanyPicker
              value={companyId}
              valueLabel={companyLabel}
              onChange={(id, c) => {
                setCompanyId(id);
                setCompanyLabel(c?.name ?? null);
              }}
            />
          </Field>
          <Field label="Owner" hint={ownerId ? undefined : "Left empty, you own it."} error={errors.ownerId}>
            <MemberPicker value={ownerId} onChange={(id) => setOwnerId(id)} placeholder="Me" />
          </Field>
          <Field label="Expected close" error={errors.expectedCloseDate}>
            <Input type="date" value={closeDate} onChange={(e) => setCloseDate(e.target.value)} />
          </Field>
        </div>
        <Field label="Description" error={errors.description}>
          <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} maxLength={5000} />
        </Field>
      </form>
    </Modal>
  );
}
