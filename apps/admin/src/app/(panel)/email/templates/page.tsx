import type { Metadata } from "next";
import { Templates } from "@/features/email/Templates";

export const metadata: Metadata = { title: "Email templates" };

export default function Page() {
  return <Templates />;
}
