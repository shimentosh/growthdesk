"use client";

import Link from "next/link";
import { Suspense, useState } from "react";
import { Ban, Bot, CalendarCheck, CalendarClock, CalendarPlus, CalendarRange, CalendarX, CircleDot, Ellipsis, Handshake, ListFilter, Mail, MapPin, Pencil, User, UserRound, Video, X } from "lucide-react";
import { labelOf, MEETING_STATUSES, type MeetingStatus } from "@growthdesk/shared";
import { Segmented, useSearchState } from "@/components/pipeline/controls";
import { MeetingModal } from "@/components/pipeline/MeetingModal";
import { useMembers } from "@/components/pickers/Pickers";
import { CalendarHeaderControl, CalendarLanding } from "@/components/booking/CalendarConnect";
import { MeetingsTabs } from "@/components/booking/MeetingsTabs";
import { Badge, StatusBadge } from "@/components/ui/Badge";
import { Button, IconButton } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Card } from "@/components/ui/Card";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/DropdownMenu";
import { EmptyState } from "@/components/ui/EmptyState";
import { QueryState } from "@/components/ui/ErrorState";
import { ENTITY, EntityTile } from "@/components/ui/icons";
import { NativeSelect } from "@/components/ui/Input";
import { Page, PageHeader } from "@/components/ui/PageHeader";
import { RequirePermission } from "@/components/ui/RequirePermission";
import { SkeletonText } from "@/components/ui/Skeleton";
import { cn } from "@/lib/cn";
import { dayKey, utcToZonedInput, zonedInputToUtc } from "@/lib/format";
import { useApiMutation, useApiQuery } from "@/lib/query";
import { useFormat, useWorkspace } from "@/lib/session";
import type { Meeting } from "@/lib/types/pipeline";
import type { BookedMeetingRow as MeetingRow } from "@/lib/types/booking";

/** GET /meetings returns at most this many rows. */
const API_LIMIT = 500;
const RANGES = [
  { value: "30", label: "Last 30 days" },
  { value: "90", label: "Last 90 days" },
  { value: "365", label: "Last 12 months" },
];

export default function MeetingsPage() {
  return (
    <Page width="capped">
      {/* The API reads meetings with either permission (any-of). */}
      <RequirePermission permission={["deals.read", "contacts.read"]}>
        <Meetings />
      </RequirePermission>
    </Page>
  );
}

const MeetingsGlyph = ENTITY.meetings.icon;

function Meetings() {
  const ws = useWorkspace();
  const f = useFormat();
  const search = useSearchState();
  const members = useMembers();
  const canWrite = ws.can(["deals.write", "contacts.write"]);
  const when = search.get("when") === "past" ? "past" : "upcoming";
  const range = RANGES.some((r) => r.value === search.get("range")) ? search.get("range") : "30";
  const status = search.get("status");
  const [editing, setEditing] = useState<MeetingRow | null>(null);
  const [creating, setCreating] = useState(false);

  // The start of today in the workspace zone — stable all day, so the query key does not churn.
  const today = zonedInputToUtc(utcToZonedInput(new Date(), ws.timezone, "date"), ws.timezone) ?? new Date().toISOString();
  const query =
    when === "upcoming"
      ? { from: today }
      : {
          from: new Date(new Date(today).getTime() - Number(range) * 86_400_000).toISOString(),
          to: today,
        };
  const meetings = useApiQuery<MeetingRow[]>(ws.key("meetings"), ws.path("/meetings"), { query });

  const setStatus = useApiMutation<Meeting, { id: string; status: MeetingStatus }>({
    method: "PATCH",
    path: (v) => ws.path(`/meetings/${v.id}`),
    body: (v) => ({ status: v.status }),
    invalidate: [ws.key("meetings"), ws.key("tasks", "summary"), ws.key("deals")],
    success: (_, v) => `Marked ${labelOf(v.status).toLowerCase()}`,
  });

  const ownerName = (id: string | null) => {
    if (!id) return null;
    const m = members.data?.members.find((x) => x.userId === id);
    return m ? m.name || m.email : null;
  };

  return (
    <>
      <PageHeader
        icon={<EntityTile of="meetings" />}
        title="Meetings"
        description={`Times in ${ws.timezone}.`}
        actions={
          <>
            <CalendarHeaderControl />
            {canWrite && (
              <Button variant="primary" icon={<CalendarPlus />} onClick={() => setCreating(true)}>
                Record meeting
              </Button>
            )}
          </>
        }
      />
      <Suspense fallback={null}>
        <CalendarLanding />
      </Suspense>
      <MeetingsTabs />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Segmented
          aria-label="Period"
          value={when}
          onChange={(v) => search.set({ when: v === "upcoming" ? null : v })}
          options={[
            { value: "upcoming", label: "Upcoming", icon: <CalendarClock /> },
            { value: "past", label: "Past", icon: <CalendarCheck /> },
          ]}
        />
        {when === "past" && (
          <NativeSelect
            aria-label="Range"
            icon={<CalendarClock />}
            className="w-auto min-w-40"
            value={range}
            onChange={(e) =>
              search.set({
                range: e.target.value === "30" ? null : e.target.value,
              })
            }
            options={RANGES}
          />
        )}
        <NativeSelect
          aria-label="Status"
          icon={<CircleDot />}
          className="w-auto min-w-36"
          value={status}
          onChange={(e) => search.set({ status: e.target.value || null })}
          options={[{ value: "", label: "Any status" }, ...MEETING_STATUSES.map((s) => ({ value: s, label: labelOf(s) }))]}
        />
        {(status || (when === "past" && range !== "30")) && (
          <Button variant="ghost" size="sm" icon={<X />} onClick={() => search.set({ status: null, range: null })}>
            Clear filters
          </Button>
        )}
      </div>

      <QueryState query={meetings} loading={<SkeletonText lines={6} />}>
        {(rows) => {
          const filtered = rows.filter((m) => !status || m.status === status);
          // The API answers oldest first; the past reads better newest first.
          const ordered = when === "past" ? [...filtered].reverse() : filtered;
          const groups = new Map<string, MeetingRow[]>();
          for (const m of ordered) {
            const k = dayKey(m.startsAt, ws.timezone);
            groups.set(k, [...(groups.get(k) ?? []), m]);
          }
          const todayKey = dayKey(new Date(), ws.timezone);
          const tomorrowKey = dayKey(new Date(Date.now() + 86_400_000), ws.timezone);
          const yesterdayKey = dayKey(new Date(Date.now() - 86_400_000), ws.timezone);
          const dayTitle = (k: string, sample: string) => (k === todayKey ? "Today" : k === tomorrowKey ? "Tomorrow" : k === yesterdayKey ? "Yesterday" : f.date(sample, "long"));

          return (
            <>
              {rows.length >= API_LIMIT && (
                <Callout tone="warn" className="mb-4">
                  {when === "past"
                    ? `This range holds more than ${API_LIMIT} meetings; only the earliest ${API_LIMIT} are shown. Pick a shorter range.`
                    : `Only the next ${API_LIMIT} meetings are shown.`}
                </Callout>
              )}
              {ordered.length === 0 ? (
                <Card>
                  <EmptyState
                    icon={status ? <ListFilter /> : <MeetingsGlyph />}
                    tint={status ? undefined : ENTITY.meetings.tint}
                    title={status ? `No ${labelOf(status).toLowerCase()} meetings here` : when === "upcoming" ? "No upcoming meetings" : "No meetings in this period"}
                    description={when === "upcoming" && !status ? "Meetings recorded for your contacts and deals show up here." : undefined}
                    action={
                      canWrite && when === "upcoming" ? (
                        <Button icon={<CalendarPlus />} onClick={() => setCreating(true)}>
                          Record meeting
                        </Button>
                      ) : undefined
                    }
                  />
                </Card>
              ) : (
                <div className="flex flex-col gap-5">
                  {[...groups.entries()].map(([k, items]) => (
                    <section key={k} aria-label={dayTitle(k, items[0]!.startsAt)}>
                      <h2 className="mb-2 text-xs font-semibold text-text-2">
                        {dayTitle(k, items[0]!.startsAt)}
                        <span className="ml-1.5 font-normal text-text-3">{items.length}</span>
                      </h2>
                      <Card>
                        <ul className="divide-y divide-line">
                          {items.map((m) => (
                            <MeetingItem
                              key={m.id}
                              meeting={m}
                              owner={ownerName(m.ownerId)}
                              canWrite={canWrite}
                              onEdit={() => setEditing(m)}
                              onStatus={(s) => setStatus.mutate({ id: m.id, status: s })}
                            />
                          ))}
                        </ul>
                      </Card>
                    </section>
                  ))}
                </div>
              )}
            </>
          );
        }}
      </QueryState>

      <MeetingModal open={creating} onOpenChange={setCreating} />
      <MeetingModal open={editing !== null} onOpenChange={(o) => !o && setEditing(null)} meeting={editing} ownerName={editing ? ownerName(editing.ownerId) : null} />
    </>
  );
}

function MeetingItem({
  meeting: m,
  owner,
  canWrite,
  onEdit,
  onStatus,
}: {
  meeting: MeetingRow;
  owner: string | null;
  canWrite: boolean;
  onEdit: () => void;
  onStatus: (status: MeetingStatus) => void;
}) {
  const ws = useWorkspace();
  const f = useFormat();
  const isLink = /^https?:\/\//i.test(m.location);
  const bar = m.status === "completed" ? "border-tint-green" : m.status === "scheduled" ? "border-tint-red" : "border-tint-gray";
  return (
    <li className="flex items-start gap-3 px-4 py-3">
      {/* A calendar-style bar beside the time: red while scheduled, green once held, grey if it did not happen. */}
      <div className={cn("w-24 shrink-0 rounded-[1px] border-l-[3px] py-0.5 pl-2.5 text-xs text-text-2 tabular-nums", bar)}>
        <div className="font-medium text-text">{f.time(m.startsAt)}</div>
        {m.endsAt && <div className="text-text-3">{f.time(m.endsAt)}</div>}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-text">{m.title}</span>
          <StatusBadge value={m.status} />
          <SourceBadge meeting={m} />
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-text-3">
          {m.contact && (
            <Link href={ws.href(`/contacts/${m.contact.id}`)} className="inline-flex items-center gap-1 hover:text-text">
              <User aria-hidden className="size-3" />
              {m.contact.fullName || "Unnamed contact"}
            </Link>
          )}
          {m.deal && (
            <Link href={ws.href(`/deals/${m.deal.id}`)} className="inline-flex items-center gap-1 hover:text-text">
              <Handshake aria-hidden className="size-3" />
              {m.deal.name}
            </Link>
          )}
          {m.attendeeEmail && !m.contact && (
            <span className="inline-flex items-center gap-1" title="Booked by">
              <Mail aria-hidden className="size-3" />
              {m.attendeeName ? `${m.attendeeName} · ${m.attendeeEmail}` : m.attendeeEmail}
            </span>
          )}
          {m.conferenceUrl && m.conferenceUrl !== m.location && (
            <a href={m.conferenceUrl} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 text-accent-hi hover:text-accent">
              <Video aria-hidden className="size-3 shrink-0" />
              Join video call
            </a>
          )}
          {m.location &&
            (isLink ? (
              <a href={m.location} target="_blank" rel="noreferrer noopener" className="inline-flex max-w-72 items-center gap-1 truncate text-accent-hi hover:text-accent">
                <Video aria-hidden className="size-3 shrink-0" />
                <span className="truncate">{m.location}</span>
              </a>
            ) : (
              <span className="inline-flex max-w-72 items-center gap-1">
                <MapPin aria-hidden className="size-3 shrink-0" />
                <span className="truncate">{m.location}</span>
              </span>
            ))}
          {owner && (
            <span className="inline-flex items-center gap-1" title="Owner">
              <UserRound aria-hidden className="size-3" />
              Owner: {owner}
            </span>
          )}
        </div>
        {m.notes && <p className="mt-1 line-clamp-2 text-xs whitespace-pre-wrap text-text-2">{m.notes}</p>}
        {m.answers && m.answers.length > 0 && (
          <p className="mt-1 line-clamp-2 text-xs text-text-2">{m.answers.map((a) => `${a.question}: ${typeof a.answer === "boolean" ? (a.answer ? "Yes" : "No") : a.answer}`).join(" · ")}</p>
        )}
        {m.status === "canceled" && m.cancelReason && <p className="mt-1 text-xs text-text-3">Canceled: {m.cancelReason}</p>}
      </div>
      {canWrite && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <IconButton size="sm" label={`Actions for “${m.title}”`} icon={<Ellipsis />} />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem icon={<Pencil />} onSelect={onEdit}>
              Edit
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            {m.status !== "completed" && (
              <DropdownMenuItem icon={<CalendarCheck />} onSelect={() => onStatus("completed")}>
                Mark completed
              </DropdownMenuItem>
            )}
            {m.status !== "no_show" && (
              <DropdownMenuItem icon={<CalendarX />} onSelect={() => onStatus("no_show")}>
                Mark no-show
              </DropdownMenuItem>
            )}
            {m.status !== "scheduled" && (
              <DropdownMenuItem icon={<CalendarClock />} onSelect={() => onStatus("scheduled")}>
                Back to scheduled
              </DropdownMenuItem>
            )}
            {m.status !== "canceled" && (
              <DropdownMenuItem danger icon={<Ban />} onSelect={() => onStatus("canceled")}>
                Cancel meeting
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </li>
  );
}

/** Where a meeting came from: a booking page, an AI call, or recorded by hand. */
function SourceBadge({ meeting: m }: { meeting: MeetingRow }) {
  if (m.source === "booking") {
    return (
      <Badge tone="info" quiet title={m.bookingPage ? `Booked through “${m.bookingPage.title}”` : "Booked through a booking page"}>
        <CalendarRange aria-hidden className="size-3" />
        Booked
      </Badge>
    );
  }
  if (m.source === "ai_call") {
    return (
      <Badge tone="info" quiet title="Booked by an AI call">
        <Bot aria-hidden className="size-3" />
        AI call
      </Badge>
    );
  }
  return (
    <Badge quiet title="Recorded in Growthdesk">
      Manual
    </Badge>
  );
}
