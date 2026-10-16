import type { Metadata } from "next";
import { PublicQuote } from "@/components/quotes/PublicQuote";

export const metadata: Metadata = { title: "Quote", robots: { index: false, follow: false }, referrer: "no-referrer" };

/**
 * The link in a quote email (or copied from the quote editor): /q/:token. A
 * page of its own rather than one in the (public) group, whose marketing frame
 * (sign-in, pricing) has no place on a seller's document; the buyer sees the
 * seller's name, the quote, and nothing of ours but a "Sent with" line.
 */
export default async function QuotePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <PublicQuote token={token} />;
}
