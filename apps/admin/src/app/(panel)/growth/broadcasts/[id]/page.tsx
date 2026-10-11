import type { Metadata } from "next";
import { BroadcastEditor } from "@/features/growth/BroadcastEditor";

export const metadata: Metadata = { title: "Broadcast" };

export default function Page() {
  return <BroadcastEditor />;
}
