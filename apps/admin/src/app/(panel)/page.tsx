import type { Metadata } from "next";
import { Dashboard } from "@/features/overview/Dashboard";

export const metadata: Metadata = { title: "Dashboard" };

export default function Page() {
  return <Dashboard />;
}
