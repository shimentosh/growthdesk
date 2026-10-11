import type { Metadata } from "next";
import { LegalPage, legalTitle } from "@/components/site/LegalPage";

export async function generateMetadata(): Promise<Metadata> {
  return { title: await legalTitle("privacy", "Privacy Policy") };
}

export default function PrivacyPage() {
  return <LegalPage slug="privacy" />;
}
