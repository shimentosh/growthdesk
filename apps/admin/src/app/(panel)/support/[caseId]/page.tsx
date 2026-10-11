import type { Metadata } from "next";
import { SupportCase } from "@/features/support/SupportCase";

export const metadata: Metadata = { title: "Support case" };

export default function Page() {
  return <SupportCase />;
}
