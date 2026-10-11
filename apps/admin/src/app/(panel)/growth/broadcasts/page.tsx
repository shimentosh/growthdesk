import type { Metadata } from "next";
import { Broadcasts } from "@/features/growth/Broadcasts";

export const metadata: Metadata = { title: "Broadcasts" };

export default function Page() {
  return <Broadcasts />;
}
