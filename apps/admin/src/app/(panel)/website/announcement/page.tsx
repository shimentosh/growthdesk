import type { Metadata } from "next";
import { WebsiteAnnouncement } from "@/features/website/Announcement";
import { websiteAppUrl } from "@/features/website/app-url";

export const metadata: Metadata = { title: "Announcement" };

export default async function Page() {
  return <WebsiteAnnouncement appUrl={await websiteAppUrl()} />;
}
