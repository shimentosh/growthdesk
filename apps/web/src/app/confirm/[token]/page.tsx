import type { Metadata } from "next";
import { ConfirmSubscription } from "@/components/marketing/setup/ConfirmSubscription";

export const metadata: Metadata = { title: "Confirm your subscription", robots: { index: false, follow: false } };

/** The link in a double opt-in email: /confirm/:token */
export default async function ConfirmPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <ConfirmSubscription token={token} />;
}
