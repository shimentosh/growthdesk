import type { Metadata } from "next";
import { Unsubscribe } from "./Unsubscribe";

export const metadata: Metadata = { title: "Unsubscribe", robots: { index: false, follow: false } };

/** The "Unsubscribe" link in a sent email (/api/t/u/:token) redirects here: /unsubscribe/:token */
export default async function UnsubscribePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <Unsubscribe token={token} />;
}
