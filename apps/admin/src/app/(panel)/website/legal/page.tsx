import type { Metadata } from "next";
import { WebsiteLegal } from "@/features/website/Legal";
import { websiteAppUrl } from "@/features/website/app-url";

export const metadata: Metadata = { title: "Legal pages" };

export default async function Page() {
  return <WebsiteLegal appUrl={await websiteAppUrl()} />;
}
