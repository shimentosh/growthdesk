import type { Metadata } from "next";
import { EmailPreferences } from "./EmailPreferences";

export const metadata: Metadata = { title: "Email preferences", robots: { index: false, follow: false } };

/**
 * The preferences link in product emails we send to our own users (broadcasts
 * and onboarding drips): /email-preferences/:token. Kept apart from the
 * customer campaign /unsubscribe page on purpose.
 */
export default async function EmailPreferencesPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <EmailPreferences token={token} />;
}
