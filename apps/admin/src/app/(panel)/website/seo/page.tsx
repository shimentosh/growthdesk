import type { Metadata } from "next";
import { WebsiteSeo } from "@/features/website/Seo";
import { websiteAppUrl } from "@/features/website/app-url";

export const metadata: Metadata = { title: "SEO & analytics" };

export default async function Page() {
  return <WebsiteSeo appUrl={await websiteAppUrl()} />;
}
