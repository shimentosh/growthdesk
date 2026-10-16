"use client";

import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, CalendarCheck, CalendarDays, ChevronLeft, ChevronRight, Clock, Download, Globe, MapPin, Phone, Video } from "lucide-react";
import { BOOKING_LOCATION_LABELS, zonedTime, type PublicBooking, type PublicBookingPage, type PublicBookingSlots } from "@growthdesk/shared";
import { Button, IconButton } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Card } from "@/components/ui/Card";
import { Checkbox } from "@/components/ui/Checkbox";
import { Field, FormError } from "@/components/ui/Field";
import { Input, NativeSelect, Textarea } from "@/components/ui/Input";
import { LoadingBlock, Spinner } from "@/components/ui/Skeleton";
import { ApiError, fieldsOf, get, messageOf, post } from "@/lib/api";
import { cn } from "@/lib/cn";
import { browserTimeZone, timeZones } from "@/lib/format";

/*
 * The public booking page (/book/<slug>) and the attendee's manage page
 * (/book/manage/<token>). The visitor is a prospect, not a Growthdesk user:
 * nothing here signs in or links into the app, and every call passes
 * noAuthRedirect. Slots come from the API as instants grouped by the
 * visitor's own days; the zone is detected from the browser and can be
 * changed. Colours are the app's tokens, so light and dark both work.
 */

const NO_AUTH = { noAuthRedirect: true } as const;
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;
/** Today in `tz` as [year, month, day]. */
function todayIn(tz: string): [number, number, number] {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date()).map((x) => [x.type, x.value]));
  return [Number(p.year), Number(p.month), Number(p.day)];
}
const timeIn = (iso: string, tz: string) => new Intl.DateTimeFormat(undefined, { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(new Date(iso));
const longDate = (iso: string, tz: string) => new Intl.DateTimeFormat(undefined, { timeZone: tz, weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(new Date(iso));
const dateLabel = (key: string) => new Intl.DateTimeFormat(undefined, { timeZone: "UTC", weekday: "long", day: "numeric", month: "long" }).format(new Date(`${key}T12:00:00Z`));
const monthLabel = (y: number, m: number) => new Intl.DateTimeFormat(undefined, { timeZone: "UTC", month: "long", year: "numeric" }).format(new Date(Date.UTC(y, m - 1, 15)));

/** The frame: the page's own content on the app's deep ground, a quiet credit underneath. */
export function BookingFrame({ children }: { children: ReactNode }) {
  return (
    <main className="flex min-h-dvh flex-col items-center bg-bg-deep px-3 py-6 sm:px-4 sm:py-12">
      <div className="w-full max-w-4xl">{children}</div>
      <p className="mt-6 text-2xs text-text-3">Scheduling by Growthdesk</p>
    </main>
  );
}

function Detail({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-start gap-2 text-sm text-text-2">
      <span aria-hidden className="mt-0.5 text-text-3 [&_svg]:size-4">
        {icon}
      </span>
      <span className="min-w-0 break-words">{children}</span>
    </div>
  );
}

const locationIcon = (type: PublicBookingPage["locationType"]) => (type === "google_meet" || type === "teams" ? <Video /> : type === "phone" ? <Phone /> : <MapPin />);

/** The left column: who, what, how long, where. */
function PageSummary({ page, children }: { page: PublicBookingPage; children?: ReactNode }) {
  return (
    <div className="flex flex-col gap-3 border-b border-line p-5 md:w-72 md:shrink-0 md:border-r md:border-b-0 sm:p-6">
      <div>
        <div className="text-xs font-medium text-text-3">{page.hostName ? `${page.hostName} · ${page.workspaceName}` : page.workspaceName}</div>
        <h1 className="mt-1 text-xl font-semibold tracking-[-0.02em] text-text-hi">{page.title}</h1>
      </div>
      <Detail icon={<Clock />}>{page.durationMinutes} minutes</Detail>
      <Detail icon={locationIcon(page.locationType)}>
        {page.locationType === "google_meet" || page.locationType === "teams" ? `${BOOKING_LOCATION_LABELS[page.locationType]} (link sent after booking)` : page.locationType === "phone" ? "Phone call — we'll call you" : page.locationDetail || BOOKING_LOCATION_LABELS[page.locationType]}
      </Detail>
      {page.description && <p className="text-sm whitespace-pre-wrap text-text-2">{page.description}</p>}
      {children}
    </div>
  );
}

/**
 * Month grid and the chosen day's times. Asks for one visible month at a
 * time; days without a free slot are disabled.
 */
export function SlotPicker({ slug, maxDaysAhead, tz, onTz, onPick }: { slug: string; maxDaysAhead: number; tz: string; onTz: (tz: string) => void; onPick: (iso: string) => void }) {
  const [today] = useState(() => todayIn(tz));
  const [cursor, setCursor] = useState<[number, number]>(() => [today[0], today[1]]);
  const [day, setDay] = useState<string | null>(null);
  const zones = useMemo(() => timeZones(), []);
  const [y, m] = cursor;
  const from = zonedTime(y, m, 1, 0, 0, tz).toISOString();
  const to = zonedTime(y, m + 1, 1, 0, 0, tz).toISOString();
  const slots = useQuery<PublicBookingSlots, ApiError>({
    queryKey: ["booking", slug, "slots", from, to, tz],
    queryFn: ({ signal }) => get<PublicBookingSlots>(`/public/booking/${encodeURIComponent(slug)}/slots`, { signal, query: { from, to, timezone: tz }, ...NO_AUTH }),
    retry: false,
  });
  const byDay = useMemo(() => new Map((slots.data?.days ?? []).map((d) => [d.date, d.slots])), [slots.data]);

  // The first day with times, when the month loads and nothing (or a day of another month) is chosen.
  useEffect(() => {
    if (!slots.data) return;
    if (day && byDay.has(day)) return;
    setDay(slots.data.days[0]?.date ?? null);
  }, [slots.data, byDay, day]);

  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const lead = (new Date(Date.UTC(y, m - 1, 1)).getUTCDay() + 6) % 7;
  const atStart = y === today[0] && m === today[1];
  const last = new Date(Date.now() + maxDaysAhead * 86_400_000);
  const atEnd = y * 12 + m >= last.getUTCFullYear() * 12 + last.getUTCMonth() + 1;
  const move = (delta: number) => {
    const next = new Date(Date.UTC(y, m - 1 + delta, 1));
    setCursor([next.getUTCFullYear(), next.getUTCMonth() + 1]);
    setDay(null);
  };
  const times = day ? (byDay.get(day) ?? []) : [];

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-4 p-5 sm:p-6 lg:flex-row">
      <div className="min-w-0 flex-1">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-text-hi">{monthLabel(y, m)}</h2>
          <div className="flex items-center gap-1">
            {slots.isFetching && <Spinner size="sm" label="Loading times" />}
            <IconButton size="sm" label="Previous month" icon={<ChevronLeft />} disabled={atStart} onClick={() => move(-1)} />
            <IconButton size="sm" label="Next month" icon={<ChevronRight />} disabled={atEnd} onClick={() => move(1)} />
          </div>
        </div>
        <div className="grid grid-cols-7 gap-1 text-center" role="grid" aria-label={monthLabel(y, m)}>
          {WEEKDAYS.map((w) => (
            <div key={w} className="pb-1 text-2xs font-medium text-text-3">
              {w}
            </div>
          ))}
          {Array.from({ length: lead }, (_, i) => (
            <div key={`x${i}`} />
          ))}
          {Array.from({ length: daysInMonth }, (_, i) => {
            const key = ymd(y, m, i + 1);
            const open = byDay.has(key);
            const chosen = key === day;
            return (
              <button
                key={key}
                type="button"
                disabled={!open}
                aria-pressed={chosen}
                aria-label={`${dateLabel(key)}${open ? "" : " (no times)"}`}
                onClick={() => setDay(key)}
                className={cn(
                  "mx-auto flex aspect-square w-full max-w-11 items-center justify-center rounded-full text-sm tabular-nums transition-colors",
                  open ? "bg-accent-soft font-semibold text-accent-ink hover:bg-accent hover:text-on-accent" : "text-text-3",
                  chosen && "bg-accent text-on-accent hover:bg-accent",
                  key === ymd(...today) && !chosen && "ring-1 ring-line-strong",
                )}
              >
                {i + 1}
              </button>
            );
          })}
        </div>
        <div className="mt-4">
          <NativeSelect aria-label="Time zone" icon={<Globe />} size="sm" value={tz} onChange={(e) => onTz(e.target.value)} options={zones.map((z) => ({ value: z, label: z.replace(/_/g, " ") }))} />
        </div>
        {slots.isError && (
          <Callout tone="bad" className="mt-3">
            {slots.error.message}
          </Callout>
        )}
        {slots.data && slots.data.days.length === 0 && !slots.isFetching && (
          <p className="mt-3 text-sm text-text-3">{atEnd ? "No times left that can be booked." : "No free times this month."}</p>
        )}
      </div>
      <div className="flex flex-col gap-2 lg:w-48">
        {day && <h3 className="text-sm font-medium text-text-hi">{dateLabel(day)}</h3>}
        <div className="grid max-h-80 grid-cols-2 gap-2 overflow-y-auto pr-1 sm:grid-cols-3 lg:grid-cols-1">
          {times.map((iso) => (
            <button
              key={iso}
              type="button"
              onClick={() => onPick(iso)}
              className="rounded-md border border-accent/40 px-3 py-2 text-sm font-semibold text-accent-ink tabular-nums transition-colors hover:border-accent hover:bg-accent hover:text-on-accent"
            >
              {timeIn(iso, tz)}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function usePage(slug: string) {
  return useQuery<PublicBookingPage, ApiError>({
    queryKey: ["booking", slug, "page"],
    queryFn: ({ signal }) => get<PublicBookingPage>(`/public/booking/${encodeURIComponent(slug)}`, { signal, ...NO_AUTH }),
    retry: false,
  });
}

function Unavailable({ error, onRetry }: { error: ApiError; onRetry: () => void }) {
  return (
    <Card className="mx-auto max-w-md p-6 text-center">
      <CalendarDays aria-hidden className="mx-auto mb-3 size-8 text-text-3" />
      <h1 className="text-lg font-semibold text-text-hi">{error.isNotFound ? "This booking page isn't available" : "The page couldn't be loaded"}</h1>
      <p className="mt-1 text-sm text-text-3">{error.isNotFound ? "The link may be mistyped, or the page has been turned off." : error.message}</p>
      {!error.isNotFound && (
        <Button className="mt-4" variant="primary" onClick={onRetry}>
          Try again
        </Button>
      )}
    </Card>
  );
}

/** What was booked: the time in the attendee's zone, the video link, add-to-calendar and the manage link. */
function Confirmation({ booking, title }: { booking: PublicBooking; title: ReactNode }) {
  const tz = booking.timezone || browserTimeZone();
  const canceled = booking.status === "canceled";
  return (
    <div className="flex flex-col items-center gap-4 p-6 text-center sm:p-10">
      <div className={cn("flex size-12 items-center justify-center rounded-full", canceled ? "bg-s-3 text-text-3" : "bg-ok-soft text-ok-ink")}>
        <CalendarCheck aria-hidden className="size-6" />
      </div>
      <div>
        <h1 className="text-xl font-semibold tracking-[-0.02em] text-text-hi">{title}</h1>
        <p className="mt-1 text-sm text-text-3">{canceled ? "Nothing more to do." : `A confirmation was sent to ${booking.attendeeEmail}.`}</p>
      </div>
      <div className="flex w-full max-w-sm flex-col gap-2 rounded-lg border border-line p-4 text-left">
        <div className="text-sm font-semibold text-text-hi">{booking.title}</div>
        <Detail icon={<CalendarDays />}>
          <span className={cn(canceled && "line-through")}>
            {longDate(booking.startsAt, tz)}, {timeIn(booking.startsAt, tz)}
            {booking.endsAt ? ` – ${timeIn(booking.endsAt, tz)}` : ""}
          </span>
        </Detail>
        <Detail icon={<Globe />}>{tz.replace(/_/g, " ")}</Detail>
        {booking.hostName && <Detail icon={<Clock />}>With {booking.hostName}</Detail>}
        {!canceled && booking.conferenceUrl && (
          <Detail icon={<Video />}>
            <a href={booking.conferenceUrl} target="_blank" rel="noreferrer noopener" className="break-all text-accent-ink hover:underline">
              {booking.conferenceUrl}
            </a>
          </Detail>
        )}
        {!canceled && !booking.conferenceUrl && booking.location && <Detail icon={<MapPin />}>{booking.location}</Detail>}
      </div>
      {!canceled && booking.confirmationMessage && <p className="max-w-sm text-sm whitespace-pre-wrap text-text-2">{booking.confirmationMessage}</p>}
      {!canceled && (
        <div className="flex flex-wrap justify-center gap-2">
          <a href={`/api/public/booking/manage/${encodeURIComponent(booking.manageToken)}/ics`} className="inline-flex h-8 items-center gap-1.5 rounded-sm border border-line-strong px-3 text-sm font-medium text-text hover:bg-hover">
            <Download aria-hidden className="size-4" />
            Add to calendar
          </a>
          <a href={`/book/manage/${encodeURIComponent(booking.manageToken)}`} className="inline-flex h-8 items-center rounded-sm px-3 text-sm font-medium text-accent-ink hover:underline">
            Reschedule or cancel
          </a>
        </div>
      )}
    </div>
  );
}

/** /book/<slug> */
export function BookingFlow({ slug }: { slug: string }) {
  const page = usePage(slug);
  const [tz, setTz] = useState("UTC");
  useEffect(() => setTz(browserTimeZone()), []);
  const [slot, setSlot] = useState<string | null>(null);
  const [done, setDone] = useState<PublicBooking | null>(null);

  if (page.isPending) return <LoadingBlock label="Opening the booking page…" />;
  if (page.isError) return <Unavailable error={page.error} onRetry={() => void page.refetch()} />;
  const p = page.data;

  return (
    <Card className="overflow-hidden">
      {done ? (
        <Confirmation booking={done} title="You're booked" />
      ) : (
        <div className="flex flex-col md:flex-row">
          <PageSummary page={p}>
            {slot && (
              <Detail icon={<CalendarCheck />}>
                <span className="font-medium text-text-hi">
                  {longDate(slot, tz)}, {timeIn(slot, tz)}
                </span>
              </Detail>
            )}
          </PageSummary>
          {slot ? (
            <BookingForm page={p} slug={slug} slot={slot} tz={tz} onBack={() => setSlot(null)} onBooked={setDone} />
          ) : (
            <SlotPicker key={tz} slug={slug} maxDaysAhead={p.maxDaysAhead} tz={tz} onTz={setTz} onPick={setSlot} />
          )}
        </div>
      )}
    </Card>
  );
}

function BookingForm({ page, slug, slot, tz, onBack, onBooked }: { page: PublicBookingPage; slug: string; slot: string; tz: string; onBack: () => void; onBooked: (b: PublicBooking) => void }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [taken, setTaken] = useState(false);
  const phoneQ = page.questions.find((q) => q.type === "phone");
  const consentQ = page.questions.find((q) => q.type === "consent");

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setFields({});
    try {
      const booked = await post<PublicBooking>(
        `/public/booking/${encodeURIComponent(slug)}/book`,
        { name, email, phone: phoneQ ? answers[phoneQ.id] || undefined : undefined, timezone: tz, start: slot, answers: { ...answers, ...(consentQ ? { [consentQ.id]: consent } : {}) }, consent: consentQ ? consent : undefined },
        NO_AUTH,
      );
      onBooked(booked);
    } catch (err) {
      setError(messageOf(err));
      setFields(fieldsOf(err));
      setTaken(err instanceof ApiError && err.status === 409);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex min-w-0 flex-1 flex-col gap-4 p-5 sm:p-6">
      <button type="button" onClick={onBack} className="inline-flex w-fit items-center gap-1 text-xs font-medium text-accent-ink hover:underline">
        <ArrowLeft aria-hidden className="size-3.5" />
        Pick another time
      </button>
      <h2 className="text-base font-semibold text-text-hi">Your details</h2>
      {taken ? (
        <Callout tone="warn" title="That time was just taken" action={<Button size="sm" onClick={onBack}>Choose another</Button>}>
          {error}
        </Callout>
      ) : (
        <FormError error={error} />
      )}
      <Field label="Name" required error={fields.name}>
        <Input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" required maxLength={200} />
      </Field>
      <Field label="Email" required error={fields.email}>
        <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required maxLength={254} />
      </Field>
      {page.questions
        .filter((q) => q.type !== "consent")
        .map((q) => (
          <Field key={q.id} label={q.label} required={q.required || (q.type === "phone" && consent)} error={fields[`answers.${q.id}`] ?? (q.type === "phone" ? fields.phone : undefined)}>
            {q.type === "textarea" ? (
              <Textarea rows={3} value={answers[q.id] ?? ""} maxLength={2000} required={q.required} onChange={(e) => setAnswers((a) => ({ ...a, [q.id]: e.target.value }))} />
            ) : (
              <Input
                type={q.type === "phone" ? "tel" : "text"}
                autoComplete={q.type === "phone" ? "tel" : undefined}
                value={answers[q.id] ?? ""}
                maxLength={q.type === "phone" ? 40 : 2000}
                required={q.required || (q.type === "phone" && consent)}
                onChange={(e) => setAnswers((a) => ({ ...a, [q.id]: e.target.value }))}
              />
            )}
          </Field>
        ))}
      {consentQ && (
        <div className="flex flex-col gap-1">
          <Checkbox checked={consent} onCheckedChange={setConsent} label={consentQ.label} />
          {fields.consent && <p className="text-xs text-bad-ink">{fields.consent}</p>}
        </div>
      )}
      <Button type="submit" variant="primary" loading={busy} className="w-full sm:w-auto sm:self-start">
        Book {timeIn(slot, tz)}
      </Button>
      <p className="text-2xs text-text-3">Your details go to {page.workspaceName} to arrange this meeting.</p>
    </form>
  );
}

/** /book/manage/<token>: see, reschedule or cancel. */
export function ManageBooking({ token }: { token: string }) {
  const booking = useQuery<PublicBooking, ApiError>({
    queryKey: ["booking", "manage", token],
    queryFn: ({ signal }) => get<PublicBooking>(`/public/booking/manage/${encodeURIComponent(token)}`, { signal, ...NO_AUTH }),
    retry: false,
  });
  const [mode, setMode] = useState<"view" | "reschedule" | "cancel">("view");
  const [tz, setTz] = useState("UTC");
  const [reason, setReason] = useState("");
  const [pick, setPick] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [changed, setChanged] = useState<{ booking: PublicBooking; what: "rescheduled" | "canceled" } | null>(null);
  useEffect(() => setTz(booking.data?.timezone || browserTimeZone()), [booking.data?.timezone]);

  if (booking.isPending) return <LoadingBlock label="Opening your booking…" />;
  if (booking.isError) {
    return (
      <Card className="mx-auto max-w-md p-6 text-center">
        <h1 className="text-lg font-semibold text-text-hi">{booking.error.isNotFound ? "This link can't be used" : "Couldn't open the booking"}</h1>
        <p className="mt-1 text-sm text-text-3">{booking.error.isNotFound ? "The booking may have been removed. Reply to your invitation to reach the organiser." : booking.error.message}</p>
      </Card>
    );
  }
  const b = changed?.booking ?? booking.data;

  const act = async (fn: () => Promise<PublicBooking>, what: "rescheduled" | "canceled") => {
    setBusy(true);
    setError(null);
    try {
      setChanged({ booking: await fn(), what });
      setMode("view");
      setPick(null);
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  };

  if (changed || b.status !== "scheduled" || mode === "view") {
    const title = changed?.what === "canceled" || b.status === "canceled" ? "Meeting canceled" : changed?.what === "rescheduled" ? "Meeting rescheduled" : b.status === "scheduled" ? "Your booking" : "This meeting has passed";
    const open = b.status === "scheduled" && new Date(b.startsAt).getTime() > Date.now();
    return (
      <Card className="mx-auto max-w-lg overflow-hidden">
        <Confirmation booking={b} title={title} />
        {open && (
          <div className="flex flex-wrap justify-center gap-2 border-t border-line p-4">
            {b.page && (
              <Button onClick={() => (setChanged(null), setMode("reschedule"))} icon={<CalendarDays />}>
                Reschedule
              </Button>
            )}
            <Button variant="danger" onClick={() => (setChanged(null), setMode("cancel"))}>
              Cancel meeting
            </Button>
          </div>
        )}
        {b.status === "canceled" && b.page && (
          <div className="border-t border-line p-4 text-center">
            <a href={`/book/${b.page.slug}`} className="text-sm font-medium text-accent-ink hover:underline">
              Book a new time
            </a>
          </div>
        )}
      </Card>
    );
  }

  if (mode === "cancel") {
    return (
      <Card className="mx-auto flex max-w-lg flex-col gap-4 p-6">
        <h1 className="text-lg font-semibold text-text-hi">Cancel this meeting?</h1>
        <p className="text-sm text-text-2">
          {b.title} — {longDate(b.startsAt, tz)}, {timeIn(b.startsAt, tz)}
        </p>
        <Field label="Reason (optional)" hint={b.hostName ? `Shared with ${b.hostName}.` : undefined}>
          <Textarea rows={3} value={reason} maxLength={1000} onChange={(e) => setReason(e.target.value)} />
        </Field>
        <FormError error={error} />
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="ghost" onClick={() => setMode("view")}>
            Keep it
          </Button>
          <Button variant="danger" loading={busy} onClick={() => void act(() => post<PublicBooking>(`/public/booking/manage/${encodeURIComponent(token)}/cancel`, { reason }, NO_AUTH), "canceled")}>
            Cancel meeting
          </Button>
        </div>
      </Card>
    );
  }

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-col md:flex-row">
        <div className="flex flex-col gap-3 border-b border-line p-5 md:w-72 md:shrink-0 md:border-r md:border-b-0 sm:p-6">
          <button type="button" onClick={() => setMode("view")} className="inline-flex w-fit items-center gap-1 text-xs font-medium text-accent-ink hover:underline">
            <ArrowLeft aria-hidden className="size-3.5" />
            Back
          </button>
          <h1 className="text-xl font-semibold tracking-[-0.02em] text-text-hi">Reschedule</h1>
          <Detail icon={<CalendarDays />}>
            <span className="line-through">
              {longDate(b.startsAt, tz)}, {timeIn(b.startsAt, tz)}
            </span>
          </Detail>
          {pick && (
            <>
              <Detail icon={<CalendarCheck />}>
                <span className="font-medium text-text-hi">
                  {longDate(pick, tz)}, {timeIn(pick, tz)}
                </span>
              </Detail>
              <FormError error={error} />
              <Button variant="primary" loading={busy} onClick={() => void act(() => post<PublicBooking>(`/public/booking/manage/${encodeURIComponent(token)}/reschedule`, { start: pick }, NO_AUTH), "rescheduled")}>
                Confirm new time
              </Button>
            </>
          )}
        </div>
        <SlotPicker key={tz} slug={b.page!.slug} maxDaysAhead={b.page!.maxDaysAhead} tz={tz} onTz={setTz} onPick={(iso) => (setError(null), setPick(iso))} />
      </div>
    </Card>
  );
}
