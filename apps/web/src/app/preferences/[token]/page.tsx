import type { Metadata } from "next";
import { Preferences } from "@/components/marketing/setup/Preferences";

export const metadata: Metadata = { title: "Email preferences", robots: { index: false, follow: false } };

/** The "Preferences" / "Unsubscribe" link in a marketing email (/api/m/u/:token) redirects here: /preferences/:token */
export default async function PreferencesPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <Preferences token={token} />;
}
