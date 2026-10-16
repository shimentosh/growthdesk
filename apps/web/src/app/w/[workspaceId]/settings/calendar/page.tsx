"use client";

import { Suspense, useEffect, useState } from "react";
import { CalendarDays, ChevronDown, CircleAlert, Info, Unplug } from "lucide-react";
import { CALENDAR_PROVIDER_LABELS, type CalendarProvider } from "@growthdesk/shared";
import { CalendarLanding, ProviderGlyph, useCalendarStart, useMyCalendars } from "@/components/booking/CalendarConnect";
import { CopyValue } from "@/components/integrations/Copy";
import { StatusBadge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Card } from "@/components/ui/Card";
import { Checkbox } from "@/components/ui/Checkbox";
import { ConfirmDialog } from "@/components/ui/Dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/DropdownMenu";
import { EmptyState } from "@/components/ui/EmptyState";
import { QueryState } from "@/components/ui/ErrorState";
import { Field } from "@/components/ui/Field";
import { EntityTile } from "@/components/ui/icons";
import { NativeSelect } from "@/components/ui/Input";
import { PageHeader, Section } from "@/components/ui/PageHeader";
import { SkeletonText } from "@/components/ui/Skeleton";
import { del } from "@/lib/api";
import { useApiMutation, useApiQuery, useInvalidate } from "@/lib/query";
import { useFormat, useWorkspace } from "@/lib/session";
import type { CalendarConnection, MyCalendars, ProviderCalendar } from "@/lib/types/booking";

/*
 * Settings → You → Calendar. Personal: each teammate connects their own
 * Google or Microsoft calendar. Booking pages hide the busy times of the
 * calendars ticked here and write booked meetings (with the attendee invited
 * and a Meet / Teams link) to the chosen one. Sign-in uses the
 * installation's Google / Microsoft OAuth clients; when one is missing, the
 * page says what a platform admin has to add.
 */

const PROVIDERS: CalendarProvider[] = ["google", "microsoft"];

function ConnectMenu({ data, variant = "primary" }: { data: MyCalendars | undefined; variant?: "primary" | "secondary" }) {
  const { start, pending } = useCalendarStart("settings");
  const none = data && !data.available.google && !data.available.microsoft;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant={variant} icon={<CalendarDays />} loading={pending !== null} disabled={!data || none}>
          Connect calendar
          <ChevronDown aria-hidden className="-mr-1 size-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-56">
        {PROVIDERS.map((p) => (
          <DropdownMenuItem key={p} icon={<ProviderGlyph provider={p} />} disabled={!data?.available[p]} onSelect={() => void start(p)}>
            {CALENDAR_PROVIDER_LABELS[p]}
            {!data?.available[p] && <span className="ml-1 text-2xs text-text-3">(not set up)</span>}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ConnectionCard({ c }: { c: CalendarConnection }) {
  const ws = useWorkspace();
  const f = useFormat();
  const invalidate = useInvalidate();
  const ok = c.status === "connected";
  const calendars = useApiQuery<ProviderCalendar[]>(ws.key("calendar", "calendars", c.id), ok ? ws.path(`/calendar/connections/${c.id}/calendars`) : null, { staleTime: 5 * 60_000 });
  const [writeTo, setWriteTo] = useState(c.calendarId);
  const [busy, setBusy] = useState<string[]>(c.busyCalendarIds.length ? c.busyCalendarIds : [c.calendarId]);
  const [confirming, setConfirming] = useState(false);
  const { start, pending } = useCalendarStart("settings");
  useEffect(() => {
    setWriteTo(c.calendarId);
    setBusy(c.busyCalendarIds.length ? c.busyCalendarIds : [c.calendarId]);
  }, [c.calendarId, c.busyCalendarIds]);

  const save = useApiMutation<CalendarConnection, void>({
    method: "PUT",
    path: ws.path(`/calendar/connections/${c.id}`),
    body: () => ({ calendarId: writeTo, busyCalendarIds: busy }),
    invalidate: [ws.key("calendar")],
    success: "Calendar settings saved",
  });
  const saved = c.busyCalendarIds.length ? c.busyCalendarIds : [c.calendarId];
  const dirty = writeTo !== c.calendarId || [...busy].sort().join() !== [...saved].sort().join();

  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-start gap-3">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-md border border-line bg-s-2">
          <ProviderGlyph provider={c.provider} className="size-5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-sm font-medium text-text-hi">{c.email}</span>
            <StatusBadge value={c.status} />
          </div>
          <div className="mt-0.5 text-xs text-text-3">
            {CALENDAR_PROVIDER_LABELS[c.provider]} · connected {f.relative(c.createdAt)}
            {c.lastSyncedAt ? ` · checked ${f.relative(c.lastSyncedAt)}` : ""}
          </div>
          {!ok && c.lastError && (
            <p className="mt-1.5 flex items-start gap-1.5 text-xs text-bad-ink">
              <CircleAlert aria-hidden className="mt-px size-3.5 shrink-0" />
              <span className="min-w-0 break-words">{c.lastError}</span>
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          {!ok && (
            <Button size="sm" variant="primary" loading={pending !== null} onClick={() => void start(c.provider)}>
              Reconnect
            </Button>
          )}
          <Button size="sm" variant="ghost" icon={<Unplug />} onClick={() => setConfirming(true)}>
            Disconnect
          </Button>
        </div>
      </div>

      {ok && (
        <div className="mt-4 border-t border-line pt-4">
          <QueryState query={calendars} loading={<SkeletonText lines={3} />}>
            {(list) => (
              <div className="grid gap-4 md:grid-cols-2">
                <Field label="Add booked meetings to" hint="Booked meetings are written here, with the attendee invited.">
                  <NativeSelect
                    value={writeTo}
                    onChange={(e) => setWriteTo(e.target.value)}
                    options={(list.some((x) => x.id === writeTo) ? list : [{ id: writeTo, name: writeTo, primary: false, writable: true }, ...list])
                      .filter((x) => x.writable)
                      .map((x) => ({ value: x.id, label: x.primary ? `${x.name} (main)` : x.name }))}
                  />
                </Field>
                <fieldset className="flex min-w-0 flex-col gap-1.5">
                  <legend className="mb-1.5 text-xs font-medium text-text-2">Check these for conflicts</legend>
                  {list.map((x) => (
                    <Checkbox
                      key={x.id}
                      checked={busy.includes(x.id)}
                      onCheckedChange={(on) => setBusy((b) => (on ? [...new Set([...b, x.id])] : b.filter((id) => id !== x.id)))}
                      label={x.primary ? `${x.name} (main)` : x.name}
                    />
                  ))}
                  <p className="text-xs text-text-3">Busy times on the ticked calendars hide those slots on your booking pages.</p>
                </fieldset>
                <div className="flex justify-end md:col-span-2">
                  <Button variant="primary" size="sm" disabled={!dirty || !busy.length} loading={save.isPending} onClick={() => save.mutate()}>
                    Save
                  </Button>
                </div>
              </div>
            )}
          </QueryState>
        </div>
      )}

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={`Disconnect ${c.email}?`}
        description="Booking pages stop checking this calendar for conflicts, and new bookings are no longer added to it. Meetings already booked stay where they are."
        confirmLabel="Disconnect"
        onConfirm={async () => {
          await del(ws.path(`/calendar/connections/${c.id}`));
          await invalidate(ws.key("calendar"), ws.key("booking-pages"));
        }}
      />
    </Card>
  );
}

export default function CalendarSettingsPage() {
  const mine = useMyCalendars();
  const data = mine.data;
  const missing = data ? PROVIDERS.filter((p) => !data.available[p]) : [];

  return (
    <>
      <PageHeader
        icon={<EntityTile of="meetings" />}
        title="Calendar"
        description="Connect your own calendar so booking pages offer only the times you're free, and booked meetings land in it with a video link and the guest invited."
        actions={data && data.connections.length > 0 ? <ConnectMenu data={data} variant="secondary" /> : undefined}
      />
      <Suspense fallback={null}>
        <CalendarLanding />
      </Suspense>
      <div className="flex flex-col gap-6">
        <QueryState
          query={mine}
          loading={
            <Card className="p-4">
              <SkeletonText lines={4} />
            </Card>
          }
          isEmpty={(d) => d.connections.length === 0}
          empty={
            <Card>
              <EmptyState
                icon={<CalendarDays />}
                tint="red"
                title="No calendar connected"
                description="Connect Google Calendar or Microsoft Outlook. Only you can see and change this connection."
                action={<ConnectMenu data={data} />}
              />
            </Card>
          }
        >
          {(d) => (
            <div className="flex flex-col gap-3">
              {d.connections.map((c) => (
                <ConnectionCard key={c.id} c={c} />
              ))}
              {d.connections.length > 1 && <p className="text-xs text-text-3">Booked meetings go to your first connected calendar; busy times are read from all of them.</p>}
            </div>
          )}
        </QueryState>

        {data && missing.length > 0 && (
          <Section icon={<Info />} title="For your platform admin" description={missing.length === 2 ? "Calendar sign-in isn't set up on this installation yet." : `${CALENDAR_PROVIDER_LABELS[missing[0]!]} sign-in isn't set up on this installation yet.`}>
            <Callout tone="info">
              <p>
                A platform admin adds the Google and Microsoft OAuth clients in the admin console under Settings → Google and Microsoft sign-in (the same ones mailbox sign-in uses), and adds these redirect URIs to each
                OAuth app, with the calendar scopes enabled:
              </p>
              <div className="mt-2 flex flex-col gap-1.5">
                {PROVIDERS.map((p) => (
                  <div key={p} className="flex flex-col gap-1">
                    <span className="text-xs font-medium text-text-2">{CALENDAR_PROVIDER_LABELS[p]}</span>
                    <CopyValue value={data.redirectUris[p]} />
                  </div>
                ))}
              </div>
            </Callout>
          </Section>
        )}
      </div>
    </>
  );
}
