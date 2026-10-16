"use client";

import { useEffect, useMemo, useState } from "react";
import { CalendarRange, Clock, ListChecks, MapPin, Plus, Trash2, UserRound, Users, X } from "lucide-react";
import {
  BOOKING_LOCATION_LABELS,
  BOOKING_LOCATION_TYPES,
  DEFAULT_BOOKING_AVAILABILITY,
  slugifyBooking,
  type BookingHoursT,
  type BookingLocationType,
  type BookingPageInputT,
  type BookingQuestionT,
  type BookingQuestionType,
} from "@growthdesk/shared";
import { MemberPicker, useMembers } from "@/components/pickers/Pickers";
import { Button, IconButton } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Checkbox";
import { Drawer } from "@/components/ui/Drawer";
import { Field, FormError } from "@/components/ui/Field";
import { EntityTile } from "@/components/ui/icons";
import { Input, NativeSelect, Textarea } from "@/components/ui/Input";
import { Switch } from "@/components/ui/Switch";
import { fieldsOf, messageOf } from "@/lib/api";
import { cn } from "@/lib/cn";
import { timeZones } from "@/lib/format";
import { useApiMutation } from "@/lib/query";
import { useMe, useWorkspace } from "@/lib/session";
import type { BookingPage } from "@/lib/types/booking";

/*
 * Create / edit a booking page: what it's called and where it lives
 * (/book/<slug>), who takes the meetings, when (weekly hours in the page's
 * zone), how long, where, and what to ask. Saved with one button; the API
 * validates everything again (BookingPageInput).
 */

type Draft = Omit<BookingPageInputT, "questions"> & { questions: BookingQuestionT[] };

const DAYS = [
  { day: 1, label: "Monday" },
  { day: 2, label: "Tuesday" },
  { day: 3, label: "Wednesday" },
  { day: 4, label: "Thursday" },
  { day: 5, label: "Friday" },
  { day: 6, label: "Saturday" },
  { day: 0, label: "Sunday" },
];
const minutes = (values: number[], unit: (n: number) => string) => values.map((n) => ({ value: String(n), label: unit(n) }));
const asDuration = (n: number) => (n < 60 ? `${n} min` : n % 60 === 0 ? `${n / 60} h` : `${Math.floor(n / 60)} h ${n % 60} min`);
const DURATIONS = minutes([15, 20, 30, 45, 60, 90, 120], asDuration);
const STEPS = minutes([10, 15, 20, 30, 45, 60], (n) => `Every ${asDuration(n)}`);
const BUFFERS = minutes([0, 5, 10, 15, 30, 45, 60], (n) => (n ? asDuration(n) : "None"));
const NOTICE = minutes([0, 30, 60, 120, 240, 720, 1440, 2880], (n) => (n ? asDuration(n).replace("24 h", "1 day").replace("48 h", "2 days") : "None"));
const QUESTION_TYPES: { value: BookingQuestionType; label: string }[] = [
  { value: "text", label: "Short answer" },
  { value: "textarea", label: "Long answer" },
  { value: "phone", label: "Phone number" },
  { value: "consent", label: "Consent to be called (checkbox)" },
];
const CONSENT_LABEL = "I agree to be called (including by an AI assistant) about this meeting and related services at the number above.";

const draftOf = (p: BookingPage | null, timezone: string, me: string | null): Draft =>
  p
    ? {
        title: p.title,
        slug: p.slug,
        description: p.description,
        durationMinutes: p.durationMinutes,
        assignment: p.assignment,
        hostUserIds: p.hostUserIds,
        availability: p.availability.hours.length ? p.availability : { ...DEFAULT_BOOKING_AVAILABILITY(p.availability.timezone) },
        bufferBeforeMinutes: p.bufferBeforeMinutes,
        bufferAfterMinutes: p.bufferAfterMinutes,
        minNoticeMinutes: p.minNoticeMinutes,
        maxDaysAhead: p.maxDaysAhead,
        slotStepMinutes: p.slotStepMinutes,
        locationType: p.locationType,
        locationDetail: p.locationDetail,
        questions: p.questions,
        confirmationMessage: p.confirmationMessage,
        active: p.active,
      }
    : {
        title: "",
        slug: "",
        description: "",
        durationMinutes: 30,
        assignment: "single",
        hostUserIds: me ? [me] : [],
        availability: DEFAULT_BOOKING_AVAILABILITY(timezone),
        bufferBeforeMinutes: 0,
        bufferAfterMinutes: 0,
        minNoticeMinutes: 240,
        maxDaysAhead: 30,
        slotStepMinutes: 30,
        locationType: "google_meet",
        locationDetail: "",
        questions: [],
        confirmationMessage: "",
        active: true,
      };

const newId = (taken: string[]) => {
  for (let i = 1; ; i++) if (!taken.includes(`q${i}`)) return `q${i}`;
};

export function BookingPageEditor({ open, onOpenChange, page, origin }: { open: boolean; onOpenChange: (open: boolean) => void; page: BookingPage | null; origin: string }) {
  const ws = useWorkspace();
  const members = useMembers();
  const me = useMe().data?.user.id ?? null;
  const [d, setD] = useState<Draft>(() => draftOf(page, ws.timezone, me));
  const [slugTouched, setSlugTouched] = useState(Boolean(page));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const zones = useMemo(() => timeZones(), []);

  useEffect(() => {
    if (!open) return;
    setD(draftOf(page, ws.timezone, me));
    setSlugTouched(Boolean(page));
    setErrors({});
    setError(null);
  }, [open, page, ws.timezone, me]);

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setD((x) => ({ ...x, [key]: value }));
  const save = useApiMutation<BookingPage, Draft>({
    method: page ? "PATCH" : "POST",
    path: page ? ws.path(`/booking-pages/${page.id}`) : ws.path("/booking-pages"),
    invalidate: [ws.key("booking-pages")],
    success: page ? "Booking page saved" : "Booking page created",
    errorToast: false,
    onSuccess: () => onOpenChange(false),
    onError: (e) => {
      setErrors(fieldsOf(e));
      setError(messageOf(e));
    },
  });

  const memberName = (id: string) => {
    const m = members.data?.members.find((x) => x.userId === id);
    return m ? m.name || m.email : page?.hosts.find((h) => h.userId === id)?.name || "Teammate";
  };
  const hostCalendar = (id: string) => page?.hosts.find((h) => h.userId === id)?.calendar ?? null;

  const hours = d.availability.hours;
  const setHours = (next: BookingHoursT[]) => set("availability", { ...d.availability, hours: next });
  const consentTaken = d.questions.some((q) => q.type === "consent");
  const phoneTaken = d.questions.some((q) => q.type === "phone");
  const addQuestion = (type: BookingQuestionType) =>
    set("questions", [...d.questions, { id: newId(d.questions.map((q) => q.id)), label: type === "consent" ? CONSENT_LABEL : type === "phone" ? "Phone number" : "", type, required: type === "phone" && consentTaken }]);

  return (
    <Drawer
      open={open}
      onOpenChange={onOpenChange}
      width="lg"
      dismissOnOutside={false}
      icon={<EntityTile of="meetings" size="md" />}
      title={page ? "Edit booking page" : "New booking page"}
      footer={
        <div className="flex items-center justify-between gap-2">
          <Switch checked={d.active} onCheckedChange={(v) => set("active", v)} label="Taking bookings" />
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button variant="primary" loading={save.isPending} onClick={() => save.mutate(d)}>
              {page ? "Save" : "Create page"}
            </Button>
          </div>
        </div>
      }
    >
      <div className="flex flex-col gap-6">
        <FormError error={error} />

        <section className="flex flex-col gap-3">
          <Field label="Title" required error={errors.title}>
            <Input
              value={d.title}
              placeholder="30-minute intro call"
              maxLength={200}
              onChange={(e) => {
                const title = e.target.value;
                setD((x) => ({ ...x, title, ...(slugTouched ? {} : { slug: slugifyBooking(title) }) }));
              }}
            />
          </Field>
          <Field label="Link" required error={errors.slug} hint="Lowercase letters, digits and dashes. Changing it breaks links already shared.">
            <div className="flex min-w-0 items-stretch overflow-hidden rounded-sm border border-line bg-field focus-within:ring-2 focus-within:ring-accent-ring">
              <span className="hidden shrink-0 items-center border-r border-line bg-s-2 px-2.5 text-xs text-text-3 sm:flex">{origin.replace(/^https?:\/\//, "")}/book/</span>
              <input
                className="min-w-0 flex-1 bg-transparent px-2.5 py-1.5 text-sm text-text outline-none"
                value={d.slug}
                maxLength={60}
                aria-label="Link"
                onChange={(e) => {
                  setSlugTouched(true);
                  set("slug", e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-"));
                }}
              />
            </div>
          </Field>
          <Field label="Description" hint="Shown on the page, above the calendar.">
            <Textarea rows={3} value={d.description} maxLength={2000} onChange={(e) => set("description", e.target.value)} />
          </Field>
        </section>

        <section className="flex flex-col gap-3">
          <h3 className="flex items-center gap-1.5 text-sm font-semibold text-text-hi">
            <Clock aria-hidden className="size-4 text-text-3" />
            Length and timing
          </h3>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Duration">
              <NativeSelect value={String(d.durationMinutes)} onChange={(e) => set("durationMinutes", Number(e.target.value))} options={DURATIONS} />
            </Field>
            <Field label="Start times" hint="How often a slot starts within your hours.">
              <NativeSelect value={String(d.slotStepMinutes)} onChange={(e) => set("slotStepMinutes", Number(e.target.value))} options={STEPS} />
            </Field>
            <Field label="Buffer before">
              <NativeSelect value={String(d.bufferBeforeMinutes)} onChange={(e) => set("bufferBeforeMinutes", Number(e.target.value))} options={BUFFERS} />
            </Field>
            <Field label="Buffer after">
              <NativeSelect value={String(d.bufferAfterMinutes)} onChange={(e) => set("bufferAfterMinutes", Number(e.target.value))} options={BUFFERS} />
            </Field>
            <Field label="Minimum notice" hint="No bookings sooner than this from now.">
              <NativeSelect value={String(d.minNoticeMinutes)} onChange={(e) => set("minNoticeMinutes", Number(e.target.value))} options={NOTICE} />
            </Field>
            <Field label="Bookable up to (days ahead)" error={errors.maxDaysAhead}>
              <Input type="number" min={1} max={365} value={d.maxDaysAhead} onChange={(e) => set("maxDaysAhead", Math.max(1, Math.min(365, Number(e.target.value) || 1)))} />
            </Field>
          </div>
        </section>

        <section className="flex flex-col gap-3">
          <h3 className="flex items-center gap-1.5 text-sm font-semibold text-text-hi">
            <CalendarRange aria-hidden className="size-4 text-text-3" />
            Weekly hours
          </h3>
          <Field label="Time zone" hint="The hours below are in this zone; visitors see slots in their own.">
            <NativeSelect value={d.availability.timezone} onChange={(e) => set("availability", { ...d.availability, timezone: e.target.value })} options={zones.map((z) => ({ value: z, label: z }))} />
          </Field>
          {errors["availability.hours"] && <FormError error={errors["availability.hours"]} />}
          <ul className="divide-y divide-line rounded-md border border-line">
            {DAYS.map(({ day, label }) => {
              const rows = hours.map((h, i) => ({ h, i })).filter((x) => x.h.day === day);
              const on = rows.length > 0;
              return (
                <li key={day} className="flex flex-col gap-2 px-3 py-2.5 sm:flex-row sm:items-start">
                  <div className="w-32 shrink-0 pt-1">
                    <Checkbox
                      checked={on}
                      label={label}
                      onCheckedChange={(v) => setHours(v ? [...hours, { day, from: "09:00", to: "17:00" }] : hours.filter((h) => h.day !== day))}
                    />
                  </div>
                  <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                    {!on && <span className="pt-1 text-xs text-text-3">Unavailable</span>}
                    {rows.map(({ h, i }, n) => (
                      <div key={i} className="flex items-center gap-1.5">
                        <Input type="time" size="sm" className="w-28" value={h.from} aria-label={`${label} from`} onChange={(e) => setHours(hours.map((x, j) => (j === i ? { ...x, from: e.target.value } : x)))} />
                        <span className="text-xs text-text-3">–</span>
                        <Input type="time" size="sm" className="w-28" value={h.to === "24:00" ? "23:59" : h.to} aria-label={`${label} until`} onChange={(e) => setHours(hours.map((x, j) => (j === i ? { ...x, to: e.target.value } : x)))} />
                        <IconButton size="sm" label="Remove these hours" icon={<X />} onClick={() => setHours(hours.filter((_, j) => j !== i))} />
                        {n === rows.length - 1 && (
                          <IconButton
                            size="sm"
                            label="Add hours on this day"
                            icon={<Plus />}
                            onClick={() => setHours([...hours, { day, from: "18:00", to: "20:00" }])}
                          />
                        )}
                      </div>
                    ))}
                  </div>
                </li>
              );
            })}
          </ul>
        </section>

        <section className="flex flex-col gap-3">
          <h3 className="flex items-center gap-1.5 text-sm font-semibold text-text-hi">
            <Users aria-hidden className="size-4 text-text-3" />
            Hosts
          </h3>
          {errors.hostUserIds && <FormError error={errors.hostUserIds} />}
          <ul className="flex flex-col gap-1.5">
            {d.hostUserIds.map((id) => {
              const cal = hostCalendar(id);
              return (
                <li key={id} className="flex items-center gap-2 rounded-sm border border-line px-2.5 py-1.5 text-sm">
                  <UserRound aria-hidden className="size-4 text-text-3" />
                  <span className="min-w-0 flex-1 truncate text-text">{memberName(id)}</span>
                  {page && (
                    <span className={cn("text-2xs", cal?.status === "connected" ? "text-ok-ink" : "text-warn-ink")}>{cal?.status === "connected" ? `Calendar: ${cal.email}` : "No calendar connected"}</span>
                  )}
                  <IconButton size="sm" label="Remove host" icon={<X />} disabled={d.hostUserIds.length === 1} onClick={() => set("hostUserIds", d.hostUserIds.filter((x) => x !== id))} />
                </li>
              );
            })}
          </ul>
          <MemberPicker value={null} placeholder="Add a host" clearable={false} onChange={(id) => id && !d.hostUserIds.includes(id) && set("hostUserIds", [...d.hostUserIds, id])} />
          {d.hostUserIds.length > 1 && (
            <Field label="Who takes each booking">
              <NativeSelect
                value={d.assignment}
                onChange={(e) => set("assignment", e.target.value as Draft["assignment"])}
                options={[
                  { value: "round_robin", label: "Round robin — the next free host in this order" },
                  { value: "single", label: `Only the first host (${memberName(d.hostUserIds[0]!)})` },
                ]}
              />
            </Field>
          )}
          <p className="text-xs text-text-3">Each host&apos;s connected calendar (Settings → Calendar) hides their busy times; booked meetings are added to it with a video link.</p>
        </section>

        <section className="flex flex-col gap-3">
          <h3 className="flex items-center gap-1.5 text-sm font-semibold text-text-hi">
            <MapPin aria-hidden className="size-4 text-text-3" />
            Location
          </h3>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Where" hint={d.locationType === "google_meet" ? "Needs the host's Google calendar connected." : d.locationType === "teams" ? "Needs the host's Microsoft calendar connected." : undefined}>
              <NativeSelect value={d.locationType} onChange={(e) => set("locationType", e.target.value as BookingLocationType)} options={BOOKING_LOCATION_TYPES.map((t) => ({ value: t, label: BOOKING_LOCATION_LABELS[t] }))} />
            </Field>
            {(d.locationType === "in_person" || d.locationType === "custom" || d.locationType === "phone") && (
              <Field label={d.locationType === "in_person" ? "Address" : d.locationType === "phone" ? "Note (we call the number the guest gives)" : "Details or link"} error={errors.locationDetail}>
                <Input value={d.locationDetail} maxLength={500} onChange={(e) => set("locationDetail", e.target.value)} />
              </Field>
            )}
          </div>
        </section>

        <section className="flex flex-col gap-3">
          <h3 className="flex items-center gap-1.5 text-sm font-semibold text-text-hi">
            <ListChecks aria-hidden className="size-4 text-text-3" />
            Questions
          </h3>
          <p className="-mt-1 text-xs text-text-3">Name and email are always asked. A phone answer is saved on the contact; a ticked consent box records their consent to be called, which AI calling needs.</p>
          {errors.questions && <FormError error={errors.questions} />}
          {d.questions.map((q, i) => (
            <div key={q.id} className="flex flex-col gap-2 rounded-md border border-line p-3">
              <div className="flex items-start gap-2">
                <Field label={`Question ${i + 1}`} className="flex-1" error={errors[`questions.${i}.label`]}>
                  {q.type === "consent" ? (
                    <Textarea rows={2} value={q.label} maxLength={300} onChange={(e) => set("questions", d.questions.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} />
                  ) : (
                    <Input value={q.label} maxLength={300} placeholder="What would you like to talk about?" onChange={(e) => set("questions", d.questions.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} />
                  )}
                </Field>
                <IconButton className="mt-6" size="sm" label="Remove question" icon={<Trash2 />} onClick={() => set("questions", d.questions.filter((_, j) => j !== i))} />
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <NativeSelect
                  aria-label="Answer type"
                  className="w-auto min-w-48"
                  size="sm"
                  value={q.type}
                  onChange={(e) => set("questions", d.questions.map((x, j) => (j === i ? { ...x, type: e.target.value as BookingQuestionType } : x)))}
                  options={QUESTION_TYPES.map((t) => ({ ...t, disabled: t.value !== q.type && ((t.value === "consent" && consentTaken) || (t.value === "phone" && phoneTaken)) }))}
                />
                <Checkbox checked={q.required} label="Required" onCheckedChange={(v) => set("questions", d.questions.map((x, j) => (j === i ? { ...x, required: v } : x)))} />
              </div>
            </div>
          ))}
          <div className="flex flex-wrap gap-2">
            <Button size="sm" icon={<Plus />} disabled={d.questions.length >= 12} onClick={() => addQuestion("text")}>
              Add question
            </Button>
            {!phoneTaken && (
              <Button size="sm" variant="ghost" icon={<Plus />} disabled={d.questions.length >= 12} onClick={() => addQuestion("phone")}>
                Ask for a phone number
              </Button>
            )}
            {!consentTaken && (
              <Button size="sm" variant="ghost" icon={<Plus />} disabled={d.questions.length >= 12} onClick={() => addQuestion("consent")}>
                Consent to be called
              </Button>
            )}
          </div>
        </section>

        <Field label="After booking" hint="Shown on the confirmation screen and in the confirmation email.">
          <Textarea rows={3} value={d.confirmationMessage} maxLength={2000} onChange={(e) => set("confirmationMessage", e.target.value)} />
        </Field>
      </div>
    </Drawer>
  );
}
