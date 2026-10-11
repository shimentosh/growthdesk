import type { Metadata } from "next";
import { WebsiteLanding } from "@/features/website/Landing";
import { websiteAppUrl } from "@/features/website/app-url";

export const metadata: Metadata = { title: "Landing page" };

export default async function Page() {
  return <WebsiteLanding appUrl={await websiteAppUrl()} />;
}
