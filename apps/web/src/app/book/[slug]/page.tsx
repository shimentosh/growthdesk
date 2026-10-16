import { BookingFlow } from "@/components/booking/PublicBooking";

/** A workspace's public booking page: /book/:slug */
export default async function BookingPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return <BookingFlow slug={slug} />;
}
