"use client";

import { useState, type FormEvent } from "react";
import { CalendarPlus } from "lucide-react";
import { EntityTile } from "@/components/ui/icons";
import { labelOf, MEETING_STATUSES } from "@growthdesk/shared";
import { ContactPicker, MemberPicker } from "@/components/pickers/Pickers";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Dialog";
import { Field, FormError } from "@/components/ui/Field";
import { Input, NativeSelect, Textarea } from "@/components/ui/Input";
import { KeyValueList } from "@/components/ui/KeyValue";
import { utcToZonedInput, zonedInputToUtc } from "@/lib/format";
import { useApiMutation } from "@/lib/query";
import { useWorkspace } from "@/lib/session";
import type { Meeting, MeetingRow } from "@/lib/types/pipeline";
import { DealPicker } from "./DealPicker";
import { fieldErrors, formLevelError, useOpenKey } from "./utils";

const FIELDS = ["title", "startsAt", "endsAt", "location", "contactId", "dealId", "ownerId", "status", "notes"] as const;

export type MeetingDefaults = {
  contactId?: string | null;
  contactLabel?: string | null;
  dealId?: string | null;
  dealLabel?: string | null;
};

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Edit this meeting; omit to record a new one. */
  meeting?: MeetingRow | null;
  defaults?: MeetingDefaults;
  /** Shown in edit mode for the owner, which the meeting row carries only as an id. */
  ownerName?: string | null;
};

/**
 * Record or edit a meeting (MeetingInput). The API's update changes title,
 * time, place, status and notes only, so in edit mode the contact, deal and
 * owner are shown read-only.
 */
export function MeetingModal(props: Props) {
  const key = useOpenKey(props.open);
  return <MeetingDialog key={key} {...props} />;
}

function MeetingDialog({ open, onOpenChange, meeting, defaults, ownerName }: Props) {
  const ws = useWorkspace();
  const tz = ws.timezone;
  const editing = Boolean(meeting);

  const [title, setTitle] = useState(meeting?.title ?? "");
  // Wall-clock times in the workspace zone; converted exactly (DST-aware) on save.
  const [startsAt, setStartsAt] = useState(utcToZonedInput(meeting?.startsAt, tz));
  const [endsAt, setEndsAt] = useState(utcToZonedInput(meeting?.endsAt, tz));
  const [location, setLocation] = useState(meeting?.location ?? "");
  const [status, setStatus] = useState<string>(meeting?.status ?? "scheduled");
  const [notes, setNotes] = useState(meeting?.notes ?? "");
  const [contactId, setContactId] = useState<string | null>(defaults?.contactId ?? null);
  const [dealId, setDealId] = useState<string | null>(defaults?.dealId ?? null);
  const [ownerId, setOwnerId] = useState<string | null>(null);

  const save = useApiMutation<Meeting, Record<string, unknown>>({
    method: editing ? "PATCH" : "POST",
    path: editing ? ws.path(`/meetings/${meeting!.id}`) : ws.path("/meetings"),
    // The home dashboard's meeting list comes from the tasks summary; deal records list their meetings.
    invalidate: [ws.key("meetings"), ws.key("tasks", "summary"), ws.key("deals")],
    success: editing ? "Meeting saved" : "Meeting recorded",
    errorToast: false,
    onSuccess: () => onOpenChange(false),
  });
  const errors = fieldErrors(save.error);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const common = {
      title,
      startsAt: startsAt ? zonedInputToUtc(startsAt, tz) : undefined,
      endsAt: endsAt ? zonedInputToUtc(endsAt, tz) : null,
      location,
      notes,
    };
    save.mutate(editing ? { ...common, status } : { ...common, contactId, dealId, ...(ownerId ? { ownerId } : {}) });
  };

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={editing ? "Edit meeting" : "Record a meeting"}
      icon={<EntityTile of="meetings" size="md" />}
      size="lg"
      dismissOnOutside={false}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" type="submit" form="meeting-form" icon={editing ? undefined : <CalendarPlus />} loading={save.isPending}>
            {editing ? "Save" : "Record meeting"}
          </Button>
        </>
      }
    >
      <form id="meeting-form" onSubmit={submit} className="flex flex-col gap-4">
        <FormError error={formLevelError(save.error, FIELDS)} />
        <Field label="Title" required error={errors.title}>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} autoFocus={!editing} placeholder="e.g. Discovery call" />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Starts" required hint={`Workspace time (${tz})`} error={errors.startsAt}>
            <Input type="datetime-local" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} required />
          </Field>
          <Field label="Ends" error={errors.endsAt}>
            <Input type="datetime-local" value={endsAt} min={startsAt || undefined} onChange={(e) => setEndsAt(e.target.value)} />
          </Field>
          <Field label="Location" hint="An address or a meeting link." error={errors.location}>
            <Input value={location} onChange={(e) => setLocation(e.target.value)} maxLength={500} />
          </Field>
          {editing ? (
            <Field label="Status" error={errors.status}>
              <NativeSelect
                value={status}
                onChange={(e) => setStatus(e.target.value)}
                options={MEETING_STATUSES.map((s) => ({
                  value: s,
                  label: labelOf(s),
                }))}
              />
            </Field>
          ) : (
            <Field label="Owner" hint={ownerId ? undefined : "Left empty, you own it."} error={errors.ownerId}>
              <MemberPicker value={ownerId} onChange={(id) => setOwnerId(id)} placeholder="Me" />
            </Field>
          )}
        </div>
        {editing && meeting ? (
          <KeyValueList
            className="rounded-md border border-line bg-well px-3 py-2.5"
            items={[
              {
                label: "Contact",
                value: meeting.contact ? meeting.contact.fullName || "Unnamed contact" : null,
              },
              { label: "Deal", value: meeting.deal?.name },
              { label: "Owner", value: ownerName },
            ]}
          />
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Contact" hint="Campaigns set to stop on a booked meeting stop for this contact." error={errors.contactId}>
              <ContactPicker value={contactId} valueLabel={defaults?.contactLabel} onChange={(id) => setContactId(id)} />
            </Field>
            <Field label="Deal" error={errors.dealId}>
              <DealPicker value={dealId} valueLabel={defaults?.dealLabel} onChange={(id) => setDealId(id)} />
            </Field>
          </div>
        )}
        <Field label="Notes" error={errors.notes}>
          <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={4} maxLength={5000} />
        </Field>
      </form>
    </Modal>
  );
}
