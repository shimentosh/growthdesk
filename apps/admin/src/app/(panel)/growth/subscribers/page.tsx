import type { Metadata } from "next";
import { Subscribers } from "@/features/growth/Subscribers";

export const metadata: Metadata = { title: "Subscribers" };

export default function Page() {
  return <Subscribers />;
}
