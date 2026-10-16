"use client";

import { useEffect, useState } from "react";
import { CalendarClock, CalendarRange, CircleAlert, Clock, Ellipsis, ExternalLink, Link2, MapPin, Pencil, Plus, Power, Trash2, Users } from "lucide-react";
import { BOOKING_LOCATION_LABELS } from "@growthdesk/shared";
import { BookingPageEditor } from "@/components/booking/BookingPageEditor";
import { MeetingsTabs } from "@/components/booking/MeetingsTabs";
import { copyText, CopyValue } from "@/components/integrations/Copy";
import { Badge } from "@/components/ui/Badge";
import { Button, IconButton } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { ConfirmDialog } from "@/components/ui/Dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/DropdownMenu";
import { EmptyState } from "@/components/ui/EmptyState";
import { QueryState } from "@/components/ui/ErrorState";
import { EntityTile } from "@/components/ui/icons";
import { Page, PageHeader } from "@/components/ui/PageHeader";
import { RequirePermission } from "@/components/ui/RequirePermission";
import { SkeletonText } from "@/components/ui/Skeleton";
import { del } from "@/lib/api";
import { useApiMutation, useApiQuery, useInvalidate } from "@/lib/query";
import { useWorkspace } from "@/lib/session";
import type { BookingPage } from "@/lib/types/booking";

/*
 * Meetings → Booking pages (booking.manage): public /book/<slug> pages where
 * prospects pick a free time with one of the hosts. Each card shows the
 * public link to copy, the hosts (and whether their calendar is connected —
 * without one, bookings still arrive but nothing is added to a calendar and
 * calendar busy times are not checked), and the upcoming bookings.
 */

const DAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function hoursSummary(p: BookingPage) {
  const days = [...new Set(p.availability.hours.map((h) => h.day))].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));
  if (!days.length) return "No hours set";
  const first = p.availability.hours.find((h) => h.day === days[0])!;
  const same = p.availability.hours.every((h) => h.from === first.from && h.to === first.to);
  const label = days.length === 5 && days.join() === "1,2,3,4,5" ? "Mon–Fri" : days.length === 7 ? "Every day" : days.map((d) => DAY_SHORT[d]).join(", ");
  return same ? `${label} ${first.from}–${first.to}` : label;
}

function PageCard({ p, onEdit }: { p: BookingPage; onEdit: () => void }) {
  const ws = useWorkspace();
  const invalidate = useInvalidate();
  const [deleting, setDeleting] = useState(false);
  const toggle = useApiMutation<BookingPage, void>({
    method: "PATCH",
    path: ws.path(`/booking-pages/${p.id}`),
    body: () => ({ active: !p.active }),
    invalidate: [ws.key("booking-pages")],
    success: p.active ? "Booking page turned off" : "Booking page is taking bookings",
  });
  const noCalendar = p.hosts.filter((h) => h.calendar?.status !== "connected");

  return (
    <Card className="flex flex-col gap-3 p-4">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={onEdit} className="truncate text-left text-sm font-semibold text-text-hi hover:underline">
              {p.title}
            </button>
            {p.active ? (
              <Badge tone="ok" dot>
                Taking bookings
              </Badge>
            ) : (
              <Badge>Off</Badge>
            )}
          </div>
          {p.description && <p className="mt-0.5 line-clamp-2 text-xs text-text-3">{p.description}</p>}
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <IconButton size="sm" label={`Actions for “${p.title}”`} icon={<Ellipsis />} />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem icon={<Pencil />} onSelect={onEdit}>
              Edit
            </DropdownMenuItem>
            <DropdownMenuItem icon={<Link2 />} onSelect={() => void copyText(p.url, "Link copied")}>
              Copy link
            </DropdownMenuItem>
            <DropdownMenuItem icon={<ExternalLink />} onSelect={() => window.open(p.url, "_blank", "noopener")}>
              Open page
            </DropdownMenuItem>
            <DropdownMenuItem icon={<Power />} onSelect={() => toggle.mutate()}>
              {p.active ? "Turn off" : "Turn on"}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem danger icon={<Trash2 />} onSelect={() => setDeleting(true)}>
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <CopyValue value={p.url} label="Copy link" copied="Link copied" />

      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-text-3">
        <span className="inline-flex items-center gap-1">
          <Clock aria-hidden className="size-3" />
          {p.durationMinutes} min
        </span>
        <span className="inline-flex items-center gap-1">
          <CalendarRange aria-hidden className="size-3" />
          {hoursSummary(p)} ({p.availability.timezone})
        </span>
        <span className="inline-flex items-center gap-1">
          <MapPin aria-hidden className="size-3" />
          {BOOKING_LOCATION_LABELS[p.locationType]}
        </span>
        <span className="inline-flex items-center gap-1">
          <Users aria-hidden className="size-3" />
          {p.hosts.map((h) => h.name || h.email).join(", ")}
          {p.hosts.length > 1 && p.assignment === "round_robin" ? " (round robin)" : ""}
        </span>
        <span className="inline-flex items-center gap-1">
          <CalendarClock aria-hidden className="size-3" />
          {p.upcomingBookings === 1 ? "1 upcoming booking" : `${p.upcomingBookings} upcoming bookings`}
        </span>
      </div>

      {noCalendar.length > 0 && (
        <p className="flex items-start gap-1.5 text-xs text-warn-ink">
          <CircleAlert aria-hidden className="mt-px size-3.5 shrink-0" />
          <span>
            {noCalendar.map((h) => h.name || h.email).join(", ")} {noCalendar.length === 1 ? "has" : "have"} no calendar connected: their busy times aren&apos;t checked and bookings aren&apos;t added to a calendar.
            Each host connects one under Settings → Calendar.
          </span>
        </p>
      )}

      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={`Delete “${p.title}”?`}
        description="The link stops working at once. Meetings already booked through it stay on the calendar and in Meetings."
        onConfirm={async () => {
          await del(ws.path(`/booking-pages/${p.id}`));
          await invalidate(ws.key("booking-pages"));
        }}
      />
    </Card>
  );
}

function BookingPages() {
  const ws = useWorkspace();
  const pages = useApiQuery<BookingPage[]>(ws.key("booking-pages", "list"), ws.path("/booking-pages"));
  const [editing, setEditing] = useState<BookingPage | null>(null);
  const [creating, setCreating] = useState(false);
  const [origin, setOrigin] = useState("");
  useEffect(() => setOrigin(window.location.origin), []);
  const newButton = (
    <Button variant="primary" icon={<Plus />} onClick={() => setCreating(true)}>
      New booking page
    </Button>
  );

  return (
    <>
      <PageHeader
        icon={<EntityTile of="meetings" />}
        title="Booking pages"
        description="Share a link; prospects pick a time you're free, and the meeting lands in your calendar and in Growthdesk with the contact attached."
        actions={pages.data && pages.data.length > 0 ? newButton : undefined}
      />
      <MeetingsTabs />
      <QueryState
        query={pages}
        loading={
          <Card className="p-4">
            <SkeletonText lines={5} />
          </Card>
        }
        isEmpty={(d) => d.length === 0}
        empty={
          <Card>
            <EmptyState
              icon={<CalendarRange />}
              tint="red"
              title="No booking pages yet"
              description="Create a page for each kind of meeting — an intro call, a demo — choose who hosts it and when, and share its link in emails and on your site."
              action={newButton}
            />
          </Card>
        }
      >
        {(rows) => (
          <div className="grid gap-4 lg:grid-cols-2">
            {rows.map((p) => (
              <PageCard key={p.id} p={p} onEdit={() => setEditing(p)} />
            ))}
          </div>
        )}
      </QueryState>
      <BookingPageEditor open={creating} onOpenChange={setCreating} page={null} origin={origin} />
      <BookingPageEditor open={editing !== null} onOpenChange={(o) => !o && setEditing(null)} page={editing} origin={origin} />
    </>
  );
}

export default function BookingPagesPage() {
  return (
    <Page width="capped">
      <RequirePermission permission="booking.manage">
        <BookingPages />
      </RequirePermission>
    </Page>
  );
}
