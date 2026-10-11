import type { Metadata } from "next";
import { WebsiteBranding } from "@/features/website/Branding";
import { websiteAppUrl } from "@/features/website/app-url";

export const metadata: Metadata = { title: "Branding" };

export default async function Page() {
  return <WebsiteBranding appUrl={await websiteAppUrl()} />;
}
