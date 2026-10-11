"use client";

import { useMemo, useState, type FormEvent } from "react";
import { CalendarClock, Gauge, Hand, Info, Mail } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { Checkbox } from "@/components/ui/Checkbox";
import { Field, FormError } from "@/components/ui/Field";
import { Input, NativeSelect, Textarea } from "@/components/ui/Input";
import { Switch } from "@/components/ui/Switch";
import { MemberPicker } from "@/components/pickers/Pickers";
import { timeZones, utcToZonedInput, zonedInputToUtc } from "@/lib/format";
import { useFormat, useWorkspace } from "@/lib/session";
import type { CampaignDetail, CampaignSchedule, CampaignSettings } from "@/lib/types/campaigns";
import { lockedReason, useCampaignPatch } from "./common";

const DAYS = [
  { value: 1, label: "Mon" },
  { value: 2, label: "Tue" },
  { value: 3, label: "Wed" },
  { value: 4, label: "Thu" },
  { value: 5, label: "Fri" },
  { value: 6, label: "Sat" },
  { value: 0, label: "Sun" },
];

/** Name, description and owner — editable in any state. */
export function CampaignDetailsForm({ campaign }: { campaign: CampaignDetail }) {
  const ws = useWorkspace();
  const canWrite = ws.can("campaigns.write");
  const initial = { name: campaign.name, description: campaign.description, ownerId: campaign.ownerId };
  const [draft, setDraft] = useState(initial);
  const save = useCampaignPatch(campaign.id, "Details saved");
  const dirty = JSON.stringify(initial) !== JSON.stringify(draft);
  const fields = save.error?.fields ?? {};
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate({ name: draft.name.trim(), description: draft.description.trim(), ownerId: draft.ownerId });
  };
  return (
    <Card>
      <CardHeader icon={<Info />} title="Details" />
      <CardBody>
        <form onSubmit={submit} noValidate>
          <fieldset disabled={!canWrite} className="grid gap-4 sm:grid-cols-2">
            {save.error && !save.error.isPlanLimit && !Object.keys(fields).length && <FormError error={save.error.message} className="sm:col-span-2" />}
            <Field label="Name" required error={fields.name}>
              <Input value={draft.name} maxLength={120} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
            </Field>
            <Field label="Owner" error={fields.ownerId} hint="Gets the completion notice; tasks and notifications fall back to them.">
              <MemberPicker
                value={draft.ownerId}
                valueLabel={campaign.owner?.name || campaign.owner?.email}
                disabled={!canWrite}
                placeholder="No owner"
                onChange={(id) => setDraft({ ...draft, ownerId: id })}
              />
            </Field>
            <Field label="Description" error={fields.description} className="sm:col-span-2">
              <Textarea rows={2} maxLength={1000} value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
            </Field>
            {canWrite && (
              <div className="flex justify-end gap-2 sm:col-span-2">
                <Button type="submit" variant="primary" disabled={!dirty} loading={save.isPending}>
                  Save details
                </Button>
              </div>
            )}
          </fieldset>
        </form>
      </CardBody>
    </Card>
  );
}

type Draft = { schedule: CampaignSchedule; settings: CampaignSettings; startAt: string };

/** The send window, start date and sending rules (ScheduleInput / CampaignSettingsInput). Editable while draft or paused. */
export function CampaignScheduleForm({ campaign }: { campaign: CampaignDetail }) {
  const ws = useWorkspace();
  const f = useFormat();
  const zones = useMemo(() => timeZones(), []);
  const initial: Draft = { schedule: campaign.schedule, settings: campaign.settings, startAt: utcToZonedInput(campaign.startAt, f.timeZone) };
  const [draft, setDraft] = useState<Draft>(initial);
  const save = useCampaignPatch(campaign.id, "Schedule saved");
  const locked = lockedReason(campaign.status);
  const disabled = Boolean(locked) || !ws.can("campaigns.write");
  const dirty = JSON.stringify(initial) !== JSON.stringify(draft);
  const fields = save.error?.fields ?? {};
  const sch = draft.schedule;
  const set = draft.settings;
  const setSchedule = (patch: Partial<CampaignSchedule>) => setDraft((d) => ({ ...d, schedule: { ...d.schedule, ...patch } }));
  const setSettings = (patch: Partial<CampaignSettings>) => setDraft((d) => ({ ...d, settings: { ...d.settings, ...patch } }));
  const anyTime = sch.to <= sch.from;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const startAt = draft.startAt ? zonedInputToUtc(draft.startAt, f.timeZone) : null;
    save.mutate({ schedule: draft.schedule, settings: draft.settings, ...(campaign.status === "draft" ? { startAt } : {}) });
  };
  const err = (k: string) => fields[k];

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-4">
      {locked && <Callout tone="info">{locked}</Callout>}
      {save.error && !save.error.isPlanLimit && <FormError error={save.error.message} />}
      <fieldset disabled={disabled} className="flex min-w-0 flex-col gap-4">
        <Card>
          <CardHeader icon={<CalendarClock />} title="Send window" description="Steps only run inside this window; anything due outside it waits for the next opening." />
          <CardBody className="grid gap-4 sm:grid-cols-2">
            <Field label="Time zone" error={err("schedule.timezone")}>
              <NativeSelect value={sch.timezone} onChange={(e) => setSchedule({ timezone: e.target.value })} options={zones.map((z) => ({ value: z, label: z }))} />
            </Field>
            <Field label="Hours" error={err("schedule.from") ?? err("schedule.to")} hint={anyTime ? "The end is not after the start, so any time of day counts." : undefined}>
              <div className="flex items-center gap-2">
                <Input type="time" aria-label="From" value={sch.from} onChange={(e) => setSchedule({ from: e.target.value })} />
                <span className="text-text-3">to</span>
                <Input type="time" aria-label="To" value={sch.to} onChange={(e) => setSchedule({ to: e.target.value })} />
              </div>
            </Field>
            <Field label="Days" error={err("schedule.days")} className="sm:col-span-2">
              <div className="flex flex-wrap gap-x-4 gap-y-2">
                {DAYS.map((d) => (
                  <Checkbox
                    key={d.value}
                    label={d.label}
                    disabled={disabled}
                    checked={sch.days.includes(d.value)}
                    onCheckedChange={(c) => setSchedule({ days: c ? [...sch.days, d.value].sort() : sch.days.filter((x) => x !== d.value) })}
                  />
                ))}
              </div>
            </Field>
            {campaign.status === "draft" && (
              <Field
                label="Start"
                error={err("startAt")}
                hint={`Optional, in ${f.timeZone}. A launch before this enrolls the audience and schedules the campaign; the first steps wait until then.`}
              >
                <Input type="datetime-local" value={draft.startAt} onChange={(e) => setDraft({ ...draft, startAt: e.target.value })} />
              </Field>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader icon={<Gauge />} title="Pace" />
          <CardBody className="grid gap-4 sm:grid-cols-2">
            <Field label="New contacts per day" error={err("settings.dailyNewLimit")} hint="Starts are spread so at most this many contacts begin the sequence each day.">
              <Input type="number" min={1} max={5000} value={set.dailyNewLimit} onChange={(e) => setSettings({ dailyNewLimit: Number(e.target.value) })} />
            </Field>
            <Field label="Seconds between starts" error={err("settings.gapSeconds")} hint="Gap between consecutive contacts' first steps. Each mailbox's own minimum delay also applies.">
              <Input type="number" min={0} max={3600} value={set.gapSeconds} onChange={(e) => setSettings({ gapSeconds: Number(e.target.value) })} />
            </Field>
          </CardBody>
        </Card>

        <Card>
          <CardHeader icon={<Hand />} title="Stop a contact's sequence when" />
          <CardBody className="flex flex-col gap-3">
            <Switch checked={set.stopOnReply} disabled={disabled} onCheckedChange={(v) => setSettings({ stopOnReply: v })} label="They reply" />
            <Switch
              checked={set.stopOnAutoReply}
              disabled={disabled || !set.stopOnReply}
              onCheckedChange={(v) => setSettings({ stopOnAutoReply: v })}
              label="An auto-reply arrives"
              description="Out-of-office and other automatic answers count as a reply."
            />
            <Switch checked={set.stopOnMeeting} disabled={disabled} onCheckedChange={(v) => setSettings({ stopOnMeeting: v })} label="A meeting is booked with them" />
            <Switch checked={set.stopOnDealWon} disabled={disabled} onCheckedChange={(v) => setSettings({ stopOnDealWon: v })} label="A deal with them is won" />
          </CardBody>
        </Card>

        <Card>
          <CardHeader icon={<Mail />} title="Email" />
          <CardBody className="flex flex-col gap-3">
            <Switch checked={set.trackOpens} disabled={disabled} onCheckedChange={(v) => setSettings({ trackOpens: v })} label="Track opens" description="Adds a tracking pixel. Many mail apps block or pre-load it, so opens are approximate." />
            <Switch checked={set.trackClicks} disabled={disabled} onCheckedChange={(v) => setSettings({ trackClicks: v })} label="Track link clicks" description="Links are rewritten through this app's tracking address." />
            <Switch checked={set.unsubscribeLink} disabled={disabled} onCheckedChange={(v) => setSettings({ unsubscribeLink: v })} label="Include an unsubscribe link" />
          </CardBody>
        </Card>
      </fieldset>
      {!disabled && (
        <div className="flex items-center justify-end gap-2">
          {dirty && (
            <Button
              onClick={() => {
                setDraft(initial);
                save.reset();
              }}
              disabled={save.isPending}
            >
              Discard
            </Button>
          )}
          <Button type="submit" variant="primary" disabled={!dirty} loading={save.isPending}>
            Save schedule
          </Button>
        </div>
      )}
    </form>
  );
}
