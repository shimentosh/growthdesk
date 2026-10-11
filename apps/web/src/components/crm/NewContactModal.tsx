"use client";

import { useState, type FormEvent } from "react";
import { ArrowUpRight } from "lucide-react";
import { CONTACT_STATUSES, PRIORITIES, labelOf, type ContactInputT, type ContactStatus, type Priority } from "@growthdesk/shared";
import { CompanyPicker, MemberPicker } from "@/components/pickers/Pickers";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Modal } from "@/components/ui/Dialog";
import { Field, FormError } from "@/components/ui/Field";
import { Input, NativeSelect } from "@/components/ui/Input";
import type { ApiError } from "@/lib/api";
import { useApiMutation } from "@/lib/query";
import { useWorkspace } from "@/lib/session";
import type { ContactDetail } from "@/lib/types/crm";
import { TagEditor } from "./Tags";

type Draft = {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  jobTitle: string;
  companyId: string | null;
  companyLabel: string | null;
  companyName: string;
  ownerId: string | null;
  status: ContactStatus;
  priority: Priority;
  tags: string[];
};

const empty = (companyId: string | null, companyLabel: string | null): Draft => ({
  firstName: "",
  lastName: "",
  email: "",
  phone: "",
  jobTitle: "",
  companyId,
  companyLabel,
  companyName: "",
  ownerId: null,
  status: "new",
  priority: "medium",
  tags: [],
});

/**
 * The 409 the API answers when the email or phone already belongs to someone
 * carries that contact's id in `details.contactId` — a link, not a field error.
 */
export function conflictId(error: ApiError | null, key: "contactId" | "companyId"): string | null {
  const id = error && error.status === 409 ? error.details[key] : null;
  return typeof id === "string" ? id : null;
}

/** POST /contacts. `company` presets the company (from a company record). */
export function NewContactModal({
  open,
  onOpenChange,
  company,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  company?: { id: string; name: string };
  onCreated?: (contact: ContactDetail) => void;
}) {
  const ws = useWorkspace();
  const [draft, setDraft] = useState<Draft>(() => empty(company?.id ?? null, company?.name ?? null));
  const [newCompany, setNewCompany] = useState(false);
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((d) => ({ ...d, [key]: value }));

  const create = useApiMutation<ContactDetail, ContactInputT>({
    path: ws.path("/contacts"),
    invalidate: [ws.key("contacts"), ws.key("companies"), ws.key("tags")],
    success: "Contact created",
    errorToast: false,
    onSuccess: (contact) => {
      setDraft(empty(company?.id ?? null, company?.name ?? null));
      setNewCompany(false);
      onOpenChange(false);
      onCreated?.(contact);
    },
  });

  const error = create.error;
  const existingId = conflictId(error, "contactId");
  const fields = error && !existingId ? error.fields : {};
  const formError = error && !existingId && !Object.keys(fields).length ? error.message : null;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const body: ContactInputT = {
      firstName: draft.firstName.trim() || undefined,
      lastName: draft.lastName.trim() || undefined,
      email: draft.email.trim() || undefined,
      phone: draft.phone.trim() || undefined,
      jobTitle: draft.jobTitle.trim() || undefined,
      ownerId: draft.ownerId ?? undefined,
      status: draft.status,
      priority: draft.priority,
      tags: draft.tags.length ? draft.tags : undefined,
    };
    if (newCompany) body.companyName = draft.companyName.trim() || undefined;
    else if (draft.companyId) body.companyId = draft.companyId;
    create.mutate(body);
  };

  const change = (next: boolean) => {
    if (!next) create.reset();
    onOpenChange(next);
  };

  return (
    <Modal
      open={open}
      onOpenChange={change}
      title="New contact"
      description="A name, an email address or a phone number is enough to start."
      dismissOnOutside={false}
      footer={
        <>
          <Button onClick={() => change(false)}>Cancel</Button>
          <Button variant="primary" type="submit" form="new-contact" loading={create.isPending}>
            Create contact
          </Button>
        </>
      }
    >
      <form id="new-contact" onSubmit={submit} noValidate className="flex flex-col gap-3">
        <FormError error={formError} />
        {existingId && (
          <Callout
            tone="warn"
            title="This contact is already in the CRM"
            action={
              <Button size="sm" icon={<ArrowUpRight />} href={ws.href(`/contacts/${existingId}`)}>
                Open it
              </Button>
            }
          >
            {error?.message}
          </Callout>
        )}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="First name" error={fields.firstName}>
            <Input autoFocus value={draft.firstName} onChange={(e) => set("firstName", e.target.value)} />
          </Field>
          <Field label="Last name" error={fields.lastName}>
            <Input value={draft.lastName} onChange={(e) => set("lastName", e.target.value)} />
          </Field>
          <Field label="Email" error={fields.email}>
            <Input type="email" autoComplete="off" value={draft.email} onChange={(e) => set("email", e.target.value)} />
          </Field>
          <Field label="Phone" error={fields.phone} hint="Include the country code, e.g. +44…">
            <Input type="tel" autoComplete="off" value={draft.phone} onChange={(e) => set("phone", e.target.value)} />
          </Field>
          <Field label="Job title" error={fields.jobTitle}>
            <Input value={draft.jobTitle} onChange={(e) => set("jobTitle", e.target.value)} />
          </Field>
          <Field
            label="Company"
            error={fields.companyId ?? fields.companyName}
            labelAction={
              <button type="button" className="text-xs text-accent-hi hover:underline" onClick={() => setNewCompany((v) => !v)}>
                {newCompany ? "Pick existing" : "New company"}
              </button>
            }
          >
            {newCompany ? (
              <Input placeholder="Company name" value={draft.companyName} onChange={(e) => set("companyName", e.target.value)} />
            ) : (
              <CompanyPicker
                value={draft.companyId}
                valueLabel={draft.companyLabel}
                placeholder="None"
                onChange={(id, c) => setDraft((d) => ({ ...d, companyId: id, companyLabel: c?.name ?? null }))}
              />
            )}
          </Field>
          <Field label="Status" error={fields.status}>
            <NativeSelect
              value={draft.status}
              onChange={(e) => set("status", e.target.value as ContactStatus)}
              options={CONTACT_STATUSES.filter((s) => s !== "do_not_contact").map((s) => ({ value: s, label: labelOf(s) }))}
            />
          </Field>
          <Field label="Priority" error={fields.priority}>
            <NativeSelect
              value={draft.priority}
              onChange={(e) => set("priority", e.target.value as Priority)}
              options={PRIORITIES.map((p) => ({ value: p, label: labelOf(p) }))}
            />
          </Field>
          {ws.can("members.read") && (
            <Field label="Owner" error={fields.ownerId} className="sm:col-span-2">
              <MemberPicker value={draft.ownerId} placeholder="Unassigned" onChange={(id) => set("ownerId", id)} />
            </Field>
          )}
          <Field label="Tags" error={fields.tags} className="sm:col-span-2">
            <TagEditor value={draft.tags} onChange={(t) => set("tags", t)} />
          </Field>
        </div>
      </form>
    </Modal>
  );
}
