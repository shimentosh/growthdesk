import type { Metadata } from "next";
import { ManageBooking } from "@/components/booking/PublicBooking";

export const metadata: Metadata = { title: "Your booking", robots: { index: false, follow: false } };

/** The link in a booking confirmation: /book/manage/:token (see, reschedule or cancel). */
export default async function ManageBookingPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <ManageBooking token={token} />;
}
