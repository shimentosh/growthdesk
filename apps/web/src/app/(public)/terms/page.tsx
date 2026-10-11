import type { Metadata } from "next";
import { LegalPage, legalTitle } from "@/components/site/LegalPage";

export async function generateMetadata(): Promise<Metadata> {
  return { title: await legalTitle("terms", "Terms of Service") };
}

export default function TermsPage() {
  return <LegalPage slug="terms" />;
}
