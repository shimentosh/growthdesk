"use client";

import { useState, type FormEvent } from "react";
import { ArrowUpRight } from "lucide-react";
import type { z } from "zod";
import type { CompanyInput } from "@growthdesk/shared";
import { MemberPicker } from "@/components/pickers/Pickers";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Modal } from "@/components/ui/Dialog";
import { Field, FormError } from "@/components/ui/Field";
import { Input, Textarea } from "@/components/ui/Input";
import type { ApiError } from "@/lib/api";
import { useApiMutation } from "@/lib/query";
import { useWorkspace } from "@/lib/session";
import type { CompanyDetail } from "@/lib/types/crm";
import { conflictId } from "./NewContactModal";
import { TagEditor } from "./Tags";

export type CompanyInputT = z.infer<typeof CompanyInput>;

export type CompanyDraft = {
  name: string;
  domain: string;
  website: string;
  industry: string;
  size: string;
  phone: string;
  country: string;
  region: string;
  city: string;
  description: string;
  ownerId: string | null;
  ownerLabel: string | null;
  tags: string[];
};

export const emptyCompany = (): CompanyDraft => ({
  name: "",
  domain: "",
  website: "",
  industry: "",
  size: "",
  phone: "",
  country: "",
  region: "",
  city: "",
  description: "",
  ownerId: null,
  ownerLabel: null,
  tags: [],
});

export const companyDraftFrom = (c: CompanyDetail): CompanyDraft => ({
  name: c.name,
  domain: c.domain ?? "",
  website: c.website,
  industry: c.industry,
  size: c.size,
  phone: c.phone,
  country: c.country,
  region: c.region,
  city: c.city,
  description: c.description,
  ownerId: c.owner?.id ?? null,
  ownerLabel: c.owner?.name ?? null,
  tags: c.tags.map((t) => t.name),
});

/** The body for POST/PATCH /companies. `domain: null` clears it; the API derives one from the website when blank. */
export function companyBody(d: CompanyDraft): CompanyInputT {
  return {
    name: d.name.trim(),
    domain: d.domain.trim() || null,
    website: d.website.trim(),
    industry: d.industry.trim(),
    size: d.size.trim(),
    phone: d.phone.trim(),
    country: d.country.trim(),
    region: d.region.trim(),
    city: d.city.trim(),
    description: d.description.trim(),
    ownerId: d.ownerId,
    tags: d.tags,
  };
}

/** The fields of a company, shared by the create modal and the record's edit card. */
export function CompanyFields({
  draft,
  onChange,
  fields,
  autoFocus,
}: {
  draft: CompanyDraft;
  onChange: (next: CompanyDraft) => void;
  fields: Record<string, string>;
  autoFocus?: boolean;
}) {
  const ws = useWorkspace();
  const set = <K extends keyof CompanyDraft>(key: K, value: CompanyDraft[K]) => onChange({ ...draft, [key]: value });
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <Field label="Name" required error={fields.name} className="sm:col-span-2">
        <Input autoFocus={autoFocus} value={draft.name} onChange={(e) => set("name", e.target.value)} />
      </Field>
      <Field label="Website" error={fields.website}>
        <Input type="url" placeholder="https://" value={draft.website} onChange={(e) => set("website", e.target.value)} />
      </Field>
      <Field label="Domain" error={fields.domain} hint="Contacts with an email at this domain link here automatically.">
        <Input placeholder="example.com" value={draft.domain} onChange={(e) => set("domain", e.target.value)} />
      </Field>
      <Field label="Industry" error={fields.industry}>
        <Input value={draft.industry} onChange={(e) => set("industry", e.target.value)} />
      </Field>
      <Field label="Size" error={fields.size}>
        <Input placeholder="e.g. 11–50" value={draft.size} onChange={(e) => set("size", e.target.value)} />
      </Field>
      <Field label="Phone" error={fields.phone}>
        <Input type="tel" value={draft.phone} onChange={(e) => set("phone", e.target.value)} />
      </Field>
      <Field label="City" error={fields.city}>
        <Input value={draft.city} onChange={(e) => set("city", e.target.value)} />
      </Field>
      <Field label="Region" error={fields.region}>
        <Input value={draft.region} onChange={(e) => set("region", e.target.value)} />
      </Field>
      <Field label="Country" error={fields.country}>
        <Input value={draft.country} onChange={(e) => set("country", e.target.value)} />
      </Field>
      {ws.can("members.read") && (
        <Field label="Owner" error={fields.ownerId} className="sm:col-span-2">
          <MemberPicker
            value={draft.ownerId}
            valueLabel={draft.ownerLabel}
            placeholder="Unassigned"
            onChange={(id, m) => onChange({ ...draft, ownerId: id, ownerLabel: m ? m.name || m.email : null })}
          />
        </Field>
      )}
      <Field label="Tags" error={fields.tags} className="sm:col-span-2">
        <TagEditor value={draft.tags} onChange={(t) => set("tags", t)} />
      </Field>
      <Field label="Description" error={fields.description} className="sm:col-span-2">
        <Textarea rows={3} value={draft.description} onChange={(e) => set("description", e.target.value)} />
      </Field>
    </div>
  );
}

/** A 409 on a company names the company that already has the domain. */
export function CompanyConflict({ error }: { error: ApiError | null }) {
  const ws = useWorkspace();
  const id = conflictId(error, "companyId");
  if (!id) return null;
  return (
    <Callout
      tone="warn"
      title="Domain already in use"
      action={
        <Button size="sm" icon={<ArrowUpRight />} href={ws.href(`/companies/${id}`)}>
          Open it
        </Button>
      }
    >
      {error?.message}
    </Callout>
  );
}

/** Field errors and the form-level message of a company save, with the conflict id taken out. */
export function companyErrors(error: ApiError | null) {
  if (!error || conflictId(error, "companyId")) return { fields: {} as Record<string, string>, message: null };
  const fields = error.fields;
  return { fields, message: Object.keys(fields).length ? null : error.message };
}

/** POST /companies. */
export function NewCompanyModal({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated?: (company: CompanyDetail) => void;
}) {
  const ws = useWorkspace();
  const [draft, setDraft] = useState<CompanyDraft>(emptyCompany);
  const create = useApiMutation<CompanyDetail, CompanyInputT>({
    path: ws.path("/companies"),
    invalidate: [ws.key("companies"), ws.key("tags")],
    success: "Company created",
    errorToast: false,
    onSuccess: (company) => {
      setDraft(emptyCompany());
      onOpenChange(false);
      onCreated?.(company);
    },
  });
  const { fields, message } = companyErrors(create.error);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    // Blanks are left out on create, so the API can fill the website from the domain.
    const body = Object.fromEntries(
      Object.entries(companyBody(draft)).filter(([, v]) => v !== "" && v !== null && !(Array.isArray(v) && !v.length)),
    ) as CompanyInputT;
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
      title="New company"
      size="lg"
      dismissOnOutside={false}
      footer={
        <>
          <Button onClick={() => change(false)}>Cancel</Button>
          <Button variant="primary" type="submit" form="new-company" loading={create.isPending}>
            Create company
          </Button>
        </>
      }
    >
      <form id="new-company" onSubmit={submit} noValidate className="flex flex-col gap-3">
        <FormError error={message} />
        <CompanyConflict error={create.error} />
        <CompanyFields draft={draft} onChange={setDraft} fields={fields} autoFocus />
      </form>
    </Modal>
  );
}
