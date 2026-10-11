import type { Metadata } from "next";
import { PlatformSettings } from "@/features/settings/Settings";

export const metadata: Metadata = { title: "General settings" };

export default function Page() {
  return <PlatformSettings />;
}
