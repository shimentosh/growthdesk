"use client";

import { useState, type FormEvent } from "react";
import { ArrowUpRight, Plus } from "lucide-react";
import {
  CONTACT_STATUSES,
  PRIORITIES,
  QUALIFICATIONS,
  labelOf,
  type ContactInputT,
  type ContactStatus,
  type LifecycleStage,
  type Priority,
  type Qualification,
} from "@growthdesk/shared";
import { ListFormModal } from "@/components/marketing/lists/ListFormModal";
import { SKIP_LABEL, useMarketing, useMarketingLists } from "@/components/marketing/common";
import { CompanyPicker, MemberPicker, contactLabel } from "@/components/pickers/Pickers";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Modal } from "@/components/ui/Dialog";
import { Field, FormError } from "@/components/ui/Field";
import { Input, NativeSelect, Textarea } from "@/components/ui/Input";
import { toast } from "@/components/ui/Toast";
import type { ApiError } from "@/lib/api";
import { useApiMutation } from "@/lib/query";
import { useWorkspace, workspaceDetailKey } from "@/lib/session";
import type { Contact, ContactDetail } from "@/lib/types/crm";
import { SKIP_REASONS, type AddMembersResult } from "@/lib/types/marketing";
import { LIST_WRITE } from "./lifecycle";
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
  qualification: Qualification;
  priority: Priority;
  tags: string[];
  /** Create only: a lead list to put the new person on. */
  listId: string;
  /** Create only: a first note (how you met, what was said). */
  note: string;
};

type Prefill = Partial<Pick<Draft, "firstName" | "lastName" | "email" | "phone">>;

const empty = (companyId: string | null, companyLabel: string | null, prefill: Prefill = {}, listId = ""): Draft => ({
  firstName: prefill.firstName ?? "",
  lastName: prefill.lastName ?? "",
  email: prefill.email ?? "",
  phone: prefill.phone ?? "",
  jobTitle: "",
  companyId,
  companyLabel,
  companyName: "",
  ownerId: null,
  status: "new",
  qualification: "unqualified",
  priority: "medium",
  tags: [],
  listId,
  note: "",
});

const draftFrom = (c: Contact): Draft => ({
  firstName: c.firstName,
  lastName: c.lastName,
  email: c.email ?? "",
  phone: c.phone ?? "",
  jobTitle: c.jobTitle,
  companyId: c.company?.id ?? null,
  companyLabel: c.company?.name ?? null,
  companyName: "",
  ownerId: c.owner?.id ?? null,
  status: c.status,
  qualification: c.qualification,
  priority: c.priority,
  tags: c.tags.map((t) => t.name),
  listId: "",
  note: "",
});

/**
 * The 409 the API answers when the email or phone already belongs to someone
 * carries that contact's id in `details.contactId` — a link, not a field error.
 */
export function conflictId(error: ApiError | null, key: "contactId" | "companyId"): string | null {
  const id = error && error.status === 409 ? error.details[key] : null;
  return typeof id === "string" ? id : null;
}

const NOUN: Record<LifecycleStage, string> = { lead: "lead", sales: "lead", contact: "contact" };

/**
 * POST /contacts. `company` presets the company (from a company record); `prefill` the name, email or phone (read once, on mount).
 * `stage` is the lifecycle stage the person starts at (Leads adds leads); `listId` preselects a lead list to put them on.
 */
export function NewContactModal({
  open,
  onOpenChange,
  company,
  prefill,
  stage = "contact",
  listId,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  company?: { id: string; name: string };
  prefill?: Prefill;
  stage?: LifecycleStage;
  listId?: string;
  onCreated?: (contact: ContactDetail) => void;
}) {
  const ws = useWorkspace();
  const mk = useMarketing();
  const noun = NOUN[stage];
  const fresh = () => empty(company?.id ?? null, company?.name ?? null, prefill, listId ?? "");
  const [draft, setDraft] = useState<Draft>(fresh);
  const [newCompany, setNewCompany] = useState(false);
  const [creatingList, setCreatingList] = useState(false);
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((d) => ({ ...d, [key]: value }));

  // Joining a list is a second call; a person the list turns away still exists, so it only warns.
  const join = useApiMutation<AddMembersResult, { listId: string; contactIds: string[] }>({
    path: (v) => mk.path(`/lists/${v.listId}/members`),
    body: (v) => ({ contactIds: v.contactIds }),
    invalidate: [mk.key("lists"), mk.key("contacts"), ws.key("contacts")],
  });

  const addNote = useApiMutation<unknown, { contactId: string; body: string }>({
    path: (v) => ws.path(`/contacts/${v.contactId}/notes`),
    body: (v) => ({ body: v.body }),
    errorToast: false,
  });

  const create = useApiMutation<ContactDetail, ContactInputT>({
    path: ws.path("/contacts"),
    invalidate: [ws.key("contacts"), ws.key("companies"), ws.key("tags"), workspaceDetailKey(ws.id)],
    success: noun === "lead" ? "Lead created" : "Contact created",
    errorToast: false,
    onSuccess: async (contact) => {
      // The note and the list are follow-up calls: the person exists either way, so a failure only warns.
      const note = draft.note.trim();
      if (note && !(await addNote.mutateAsync({ contactId: contact.id, body: note }).then(() => true, () => false))) {
        toast.warn("The note could not be saved. Add it on the record page.");
      }
      if (draft.listId) {
        const r = await join.mutateAsync({ listId: draft.listId, contactIds: [contact.id] }).catch(() => null);
        const reason = r && !r.added && !r.alreadyMember ? SKIP_REASONS.find((k) => (r.skipped[k] ?? 0) > 0) : undefined;
        if (reason) toast.warn(`Not added to the list: ${SKIP_LABEL[reason]}.`);
      }
      setDraft(fresh());
      setNewCompany(false);
      onOpenChange(false);
      onCreated?.(contact);
    },
  });

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
      qualification: draft.qualification,
      lifecycleStage: stage,
      priority: draft.priority,
      tags: draft.tags.length ? draft.tags : undefined,
    };
    if (newCompany) body.companyName = draft.companyName.trim() || undefined;
    else if (draft.companyId) body.companyId = draft.companyId;
    create.mutate(body);
  };

  const change = (next: boolean) => {
    if (!next) {
      if (create.isPending || join.isPending || addNote.isPending) return;
      create.reset();
    }
    onOpenChange(next);
  };

  return (
    <Modal
      open={open}
      onOpenChange={change}
      title={`New ${noun}`}
      description="A name, an email address or a phone number is enough to start."
      dismissOnOutside={false}
      footer={
        <>
          <Button onClick={() => change(false)}>Cancel</Button>
          <Button variant="primary" type="submit" form="new-contact" loading={create.isPending || join.isPending || addNote.isPending}>
            Create {noun}
          </Button>
        </>
      }
    >
      <form id="new-contact" onSubmit={submit} noValidate className="flex flex-col gap-3">
        <ContactFields
          draft={draft}
          set={set}
          setDraft={setDraft}
          error={create.error}
          newCompany={newCompany}
          setNewCompany={setNewCompany}
          onNewList={ws.can(LIST_WRITE) ? () => setCreatingList(true) : undefined}
        />
        <Field label="Note" hint="Optional. How you met, what was discussed — it shows in Notes on the record.">
          <Textarea rows={3} maxLength={10000} value={draft.note} onChange={(e) => set("note", e.target.value)} placeholder="Met at the September trade show; interested in the Q1 pilot." />
        </Field>
      </form>
      {/* Outside the form: a submit inside the portal would otherwise bubble up to it through React. */}
      {ws.can(LIST_WRITE) && <ListFormModal key={String(creatingList)} open={creatingList} onOpenChange={setCreatingList} onSaved={(l) => set("listId", l.id)} />}
    </Modal>
  );
}

/**
 * Quick edit from a table row: the fields people change most, PATCH /contacts/:id
 * with only what changed. The record page edits everything else.
 */
export function EditContactModal({ open, onOpenChange, contact }: { open: boolean; onOpenChange: (open: boolean) => void; contact: Contact }) {
  const ws = useWorkspace();
  const [initial] = useState<Draft>(() => draftFrom(contact));
  const [draft, setDraft] = useState<Draft>(initial);
  const [newCompany, setNewCompany] = useState(false);
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((d) => ({ ...d, [key]: value }));

  const save = useApiMutation<ContactDetail, ContactInputT>({
    method: "PATCH",
    path: ws.path(`/contacts/${contact.id}`),
    invalidate: [ws.key("contacts"), ws.key("companies"), ws.key("tags")],
    success: "Saved",
    errorToast: false,
    onSuccess: () => onOpenChange(false),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const body: ContactInputT = {};
    const text = ["firstName", "lastName", "jobTitle"] as const;
    for (const k of text) if (draft[k] !== initial[k]) body[k] = draft[k].trim();
    if (draft.email !== initial.email) body.email = draft.email.trim() || null;
    if (draft.phone !== initial.phone) body.phone = draft.phone.trim() || null;
    if (draft.status !== initial.status) body.status = draft.status;
    if (draft.qualification !== initial.qualification) body.qualification = draft.qualification;
    if (draft.priority !== initial.priority) body.priority = draft.priority;
    if (draft.ownerId !== initial.ownerId) body.ownerId = draft.ownerId;
    if (newCompany) {
      if (draft.companyName.trim()) body.companyName = draft.companyName.trim();
    } else if (draft.companyId !== initial.companyId) body.companyId = draft.companyId;
    if (draft.tags.join("\n") !== initial.tags.join("\n")) body.tags = draft.tags;
    if (!Object.keys(body).length) {
      onOpenChange(false);
      return;
    }
    save.mutate(body);
  };

  const change = (next: boolean) => {
    if (!next && save.isPending) return;
    onOpenChange(next);
  };

  return (
    <Modal
      open={open}
      onOpenChange={change}
      title={`Edit ${contactLabel(contact)}`}
      dismissOnOutside={false}
      footer={
        <>
          <Button onClick={() => change(false)}>Cancel</Button>
          <Button variant="primary" type="submit" form="edit-contact" loading={save.isPending}>
            Save
          </Button>
        </>
      }
    >
      <form id="edit-contact" onSubmit={submit} noValidate className="flex flex-col gap-3">
        <ContactFields
          draft={draft}
          set={set}
          setDraft={setDraft}
          error={save.error}
          newCompany={newCompany}
          setNewCompany={setNewCompany}
          editingId={contact.id}
          showDoNotContact={draft.status === "do_not_contact"}
        />
      </form>
    </Modal>
  );
}

function ContactFields({
  draft,
  set,
  setDraft,
  error,
  newCompany,
  setNewCompany,
  onNewList,
  editingId,
  showDoNotContact = false,
}: {
  draft: Draft;
  set: <K extends keyof Draft>(key: K, value: Draft[K]) => void;
  setDraft: (fn: (d: Draft) => Draft) => void;
  error: ApiError | null;
  newCompany: boolean;
  setNewCompany: (fn: (v: boolean) => boolean) => void;
  /** Create only: offers the lead list field, with this opening the new-list dialog. */
  onNewList?: () => void;
  /** The contact being edited: a 409 pointing at it is not a duplicate. */
  editingId?: string;
  /** Keep "Do not contact" in the status options when the contact already has it. */
  showDoNotContact?: boolean;
}) {
  const ws = useWorkspace();
  const lists = useMarketingLists();
  const found = conflictId(error, "contactId");
  const existingId = found && found !== editingId ? found : null;
  const fields = error && !existingId ? error.fields : {};
  const formError = error && !existingId && !Object.keys(fields).length ? error.message : null;
  const sel = <T extends string>(values: readonly T[]) => values.map((v) => ({ value: v, label: labelOf(v) }));

  return (
    <>
      <FormError error={formError} />
      {existingId && (
        <Callout
          tone="warn"
          title="This person is already in the CRM"
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
            options={sel(CONTACT_STATUSES.filter((s) => showDoNotContact || s !== "do_not_contact"))}
          />
        </Field>
        <Field label="Qualification" error={fields.qualification}>
          <NativeSelect value={draft.qualification} onChange={(e) => set("qualification", e.target.value as Qualification)} options={sel(QUALIFICATIONS)} />
        </Field>
        <Field label="Priority" error={fields.priority}>
          <NativeSelect value={draft.priority} onChange={(e) => set("priority", e.target.value as Priority)} options={sel(PRIORITIES)} />
        </Field>
        {ws.can("members.read") && (
          <Field label="Owner" error={fields.ownerId}>
            <MemberPicker value={draft.ownerId} placeholder="Unassigned" onChange={(id) => set("ownerId", id)} />
          </Field>
        )}
        {onNewList && (
          <Field
            label="Lead list"
            className="sm:col-span-2"
            hint="Optional. Lists group people for outreach campaigns and filtering."
            labelAction={
              <button type="button" className="inline-flex items-center gap-1 text-xs text-accent-hi hover:underline" onClick={onNewList}>
                <Plus aria-hidden className="size-3" />
                New list
              </button>
            }
          >
            <NativeSelect
              value={draft.listId}
              disabled={lists.isPending}
              onChange={(e) => set("listId", e.target.value)}
              options={[{ value: "", label: "No list" }, ...(lists.data ?? []).map((l) => ({ value: l.id, label: l.name }))]}
            />
          </Field>
        )}
        <Field label="Tags" error={fields.tags} className="sm:col-span-2">
          <TagEditor value={draft.tags} onChange={(t) => set("tags", t)} />
        </Field>
      </div>
    </>
  );
}
