"use client";

import { CalendarDays, CalendarRange } from "lucide-react";
import { NavTabs } from "@/components/ui/Tabs";
import { useWorkspace } from "@/lib/session";

/** Meetings | Booking pages, above both lists. Booking pages only for people who can manage them. */
export function MeetingsTabs() {
  const ws = useWorkspace();
  if (!ws.can("booking.manage")) return null;
  return (
    <NavTabs
      aria-label="Meetings"
      className="mb-4"
      items={[
        { href: ws.href("/meetings"), label: "Meetings", icon: <CalendarDays />, exact: true },
        { href: ws.href("/meetings/booking-pages"), label: "Booking pages", icon: <CalendarRange /> },
      ]}
    />
  );
}
