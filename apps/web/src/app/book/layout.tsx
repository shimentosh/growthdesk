import type { Metadata } from "next";
import type { ReactNode } from "react";
import { BookingFrame } from "@/components/booking/PublicBooking";

export const metadata: Metadata = { title: "Book a meeting", robots: { index: false, follow: false } };

/*
 * Booking pages (/book/<slug>) and the attendee's manage link
 * (/book/manage/<token>). Outside the (public) group on purpose: that group
 * wraps Growthdesk's own marketing shell, and these pages belong to the
 * workspace that shares them.
 */
export default function BookLayout({ children }: { children: ReactNode }) {
  return <BookingFrame>{children}</BookingFrame>;
}
