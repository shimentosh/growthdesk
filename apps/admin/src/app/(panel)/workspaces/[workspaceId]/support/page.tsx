import type { Metadata } from "next";
import { SupportView } from "@/features/workspaces/SupportView";

export const metadata: Metadata = { title: "Support view" };

export default function Page() {
  return <SupportView />;
}
