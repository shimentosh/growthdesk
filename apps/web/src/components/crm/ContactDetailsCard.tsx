"use client";

import Link from "next/link";
import { useState, type FormEvent, type ReactNode } from "react";
import { IdCard, Pencil } from "lucide-react";
import {
  CONSENT_STATUSES,
  CONTACT_STATUSES,
  PRIORITIES,
  QUALIFICATIONS,
  labelOf,
  type ConsentStatus,
  type ContactInputT,
  type ContactStatus,
  type Priority,
  type Qualification,
} from "@growthdesk/shared";
import { StatusBadge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, CardBody, CardFooter, CardHeader } from "@/components/ui/Card";
import { Checkbox } from "@/components/ui/Checkbox";
import { Field, FormError } from "@/components/ui/Field";
import { Input, NativeSelect } from "@/components/ui/Input";
import { KeyValueList } from "@/components/ui/KeyValue";
import type { ApiError } from "@/lib/api";
import { utcToZonedInput, zonedInputToUtc } from "@/lib/format";
import { useFormat, useWorkspace } from "@/lib/session";
import type { ContactDetail } from "@/lib/types/crm";
import { conflictId } from "./NewContactModal";

type Draft = {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  jobTitle: string;
  website: string;
  linkedinUrl: string;
  city: string;
  country: string;
  timezone: string;
  leadSource: string;
  status: ContactStatus;
  qualification: Qualification;
  priority: Priority;
  score: string;
  nextActionAt: string;
  nextActionNote: string;
  consentStatus: ConsentStatus;
  consentSource: string;
  doNotContact: boolean;
};

const draftFrom = (c: ContactDetail, timeZone: string): Draft => ({
  firstName: c.firstName,
  lastName: c.lastName,
  email: c.email ?? "",
  phone: c.phone ?? "",
  jobTitle: c.jobTitle,
  website: c.website,
  linkedinUrl: c.linkedinUrl,
  city: c.city,
  country: c.country,
  timezone: c.timezone,
  leadSource: c.leadSource,
  status: c.status,
  qualification: c.qualification,
  priority: c.priority,
  score: c.score === null ? "" : String(c.score),
  nextActionAt: utcToZonedInput(c.nextActionAt, timeZone),
  nextActionNote: c.nextActionNote,
  consentStatus: c.consentStatus,
  consentSource: c.consentSource,
  doNotContact: c.doNotContact,
});

/** Only what changed, converted to the API's types — so an untouched email or DNC flag is never re-sent. */
function diff(initial: Draft, next: Draft, timeZone: string): ContactInputT {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(next) as (keyof Draft)[]) {
    const v = next[key];
    if (v === initial[key]) continue;
    if (key === "email" || key === "phone") out[key] = typeof v === "string" && v.trim() ? v.trim() : null;
    else if (key === "score") out.score = v === "" ? null : Number(v);
    else if (key === "nextActionAt") out.nextActionAt = v ? zonedInputToUtc(String(v), timeZone) : null;
    else out[key] = typeof v === "string" ? v.trim() : v;
  }
  return out as ContactInputT;
}

const link = (href: string, text: string) => (
  <a href={href} target="_blank" rel="noreferrer noopener" className="break-all text-accent-hi hover:underline">
    {text}
  </a>
);
const web = (v: string) => (v ? link(/^https?:\/\//i.test(v) ? v : `https://${v}`, v.replace(/^https?:\/\//i, "")) : null);

/** The contact's own fields: read as a list, edited as a form (PATCH /contacts/:id with the changed fields). */
export function ContactDetailsCard({
  contact,
  onSave,
  saving,
  error,
  onResetError,
}: {
  contact: ContactDetail;
  onSave: (body: ContactInputT) => Promise<unknown>;
  saving: boolean;
  error: ApiError | null;
  onResetError: () => void;
}) {
  const ws = useWorkspace();
  const f = useFormat();
  const [editing, setEditing] = useState(false);
  const [initial, setInitial] = useState<Draft | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((d) => (d ? { ...d, [key]: value } : d));
  const canWrite = ws.can("contacts.write");

  const existingId = conflictId(error, "contactId");
  const fields = error && !existingId ? error.fields : {};
  const formError = error ? (existingId || !Object.keys(fields).length ? error.message : null) : null;

  const start = () => {
    const d = draftFrom(contact, f.timeZone);
    setInitial(d);
    setDraft(d);
    onResetError();
    setEditing(true);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!draft || !initial) return;
    const body = diff(initial, draft, f.timeZone);
    if (!Object.keys(body).length) {
      setEditing(false);
      return;
    }
    try {
      await onSave(body);
      setEditing(false);
    } catch {
      // Shown inline.
    }
  };

  if (editing && draft) {
    const sel = <T extends string>(values: readonly T[]) => values.map((v) => ({ value: v, label: labelOf(v) }));
    return (
      <Card>
        <CardHeader icon={<IdCard />} title="Details" />
        <form onSubmit={submit} noValidate>
          <CardBody className="flex flex-col gap-3">
            <FormError
              error={
                formError &&
                (existingId ? (
                  <>
                    {formError}{" "}
                    <Link className="font-medium underline" href={ws.href(`/contacts/${existingId}`)}>
                      Open that contact
                    </Link>
                  </>
                ) : (
                  formError
                ))
              }
            />
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="First name" error={fields.firstName}>
                <Input value={draft.firstName} onChange={(e) => set("firstName", e.target.value)} />
              </Field>
              <Field label="Last name" error={fields.lastName}>
                <Input value={draft.lastName} onChange={(e) => set("lastName", e.target.value)} />
              </Field>
              <Field label="Email" error={fields.email}>
                <Input type="email" value={draft.email} onChange={(e) => set("email", e.target.value)} />
              </Field>
              <Field label="Phone" error={fields.phone} hint="Include the country code.">
                <Input type="tel" value={draft.phone} onChange={(e) => set("phone", e.target.value)} />
              </Field>
              <Field label="Job title" error={fields.jobTitle}>
                <Input value={draft.jobTitle} onChange={(e) => set("jobTitle", e.target.value)} />
              </Field>
              <Field label="Lead source" error={fields.leadSource}>
                <Input value={draft.leadSource} onChange={(e) => set("leadSource", e.target.value)} />
              </Field>
              <Field label="Website" error={fields.website}>
                <Input type="url" value={draft.website} onChange={(e) => set("website", e.target.value)} />
              </Field>
              <Field label="LinkedIn URL" error={fields.linkedinUrl}>
                <Input type="url" value={draft.linkedinUrl} onChange={(e) => set("linkedinUrl", e.target.value)} />
              </Field>
              <Field label="City" error={fields.city}>
                <Input value={draft.city} onChange={(e) => set("city", e.target.value)} />
              </Field>
              <Field label="Country" error={fields.country}>
                <Input value={draft.country} onChange={(e) => set("country", e.target.value)} />
              </Field>
              <Field label="Time zone" error={fields.timezone} hint="IANA name, e.g. Europe/London.">
                <Input value={draft.timezone} onChange={(e) => set("timezone", e.target.value)} />
              </Field>
              <Field label="Score" error={fields.score} hint="0–100">
                <Input type="number" min={0} max={100} step={1} value={draft.score} onChange={(e) => set("score", e.target.value)} />
              </Field>
              <Field label="Status" error={fields.status}>
                <NativeSelect value={draft.status} onChange={(e) => set("status", e.target.value as ContactStatus)} options={sel(CONTACT_STATUSES)} />
              </Field>
              <Field label="Qualification" error={fields.qualification}>
                <NativeSelect
                  value={draft.qualification}
                  onChange={(e) => set("qualification", e.target.value as Qualification)}
                  options={sel(QUALIFICATIONS)}
                />
              </Field>
              <Field label="Priority" error={fields.priority}>
                <NativeSelect value={draft.priority} onChange={(e) => set("priority", e.target.value as Priority)} options={sel(PRIORITIES)} />
              </Field>
              <Field label={`Next action (${f.timeZone})`} error={fields.nextActionAt}>
                <Input type="datetime-local" value={draft.nextActionAt} onChange={(e) => set("nextActionAt", e.target.value)} />
              </Field>
              <Field label="Next action note" error={fields.nextActionNote} className="sm:col-span-2">
                <Input value={draft.nextActionNote} maxLength={500} onChange={(e) => set("nextActionNote", e.target.value)} />
              </Field>
              <Field label="Consent" error={fields.consentStatus}>
                <NativeSelect
                  value={draft.consentStatus}
                  onChange={(e) => set("consentStatus", e.target.value as ConsentStatus)}
                  options={sel(CONSENT_STATUSES)}
                />
              </Field>
              <Field label="Consent source" error={fields.consentSource}>
                <Input value={draft.consentSource} onChange={(e) => set("consentSource", e.target.value)} placeholder="e.g. Web form, 12 Oct" />
              </Field>
            </div>
            <Checkbox
              checked={draft.doNotContact}
              onCheckedChange={(c) => set("doNotContact", c)}
              label="Do not contact"
              description={
                initial?.doNotContact
                  ? "Unticking clears the flag only: the status stays as set above, and their address stays on the suppression list until it is removed there."
                  : "Sets the status to Do not contact and adds their email and phone to the workspace's suppression list."
              }
            />
          </CardBody>
          <CardFooter>
            <Button size="sm" onClick={() => setEditing(false)}>
              Cancel
            </Button>
            <Button size="sm" variant="primary" type="submit" loading={saving}>
              Save changes
            </Button>
          </CardFooter>
        </form>
      </Card>
    );
  }

  const c = contact;
  const items: { label: ReactNode; value: ReactNode; hint?: ReactNode }[] = [
    { label: "Email", value: c.email ? link(`mailto:${c.email}`, c.email) : null },
    { label: "Phone", value: c.phone ? link(`tel:${c.phone}`, c.phone) : null },
    { label: "Job title", value: c.jobTitle },
    { label: "Lead source", value: c.leadSource },
    { label: "Website", value: web(c.website) },
    { label: "LinkedIn", value: web(c.linkedinUrl) },
    { label: "Location", value: [c.city, c.country].filter(Boolean).join(", ") },
    { label: "Time zone", value: c.timezone },
    { label: "Qualification", value: <StatusBadge value={c.qualification} dot={false} /> },
    { label: "Priority", value: <StatusBadge value={c.priority} dot={false} /> },
    { label: "Score", value: c.score === null ? null : String(c.score) },
    { label: "Next action", value: c.nextActionAt ? f.dateTime(c.nextActionAt) : null, hint: c.nextActionNote || undefined },
    { label: "Consent", value: labelOf(c.consentStatus), hint: c.consentSource || undefined },
    { label: "Last contacted", value: c.lastContactedAt ? f.dateTime(c.lastContactedAt) : "Never" },
    { label: "Last replied", value: c.lastRepliedAt ? f.dateTime(c.lastRepliedAt) : null },
    { label: "Created", value: f.dateTime(c.createdAt) },
  ];

  return (
    <Card>
      <CardHeader
        icon={<IdCard />}
        title="Details"
        actions={
          canWrite ? (
            <Button size="sm" variant="ghost" icon={<Pencil />} onClick={start}>
              Edit
            </Button>
          ) : undefined
        }
      />
      <CardBody>
        <KeyValueList columns={2} items={items} />
      </CardBody>
    </Card>
  );
}
