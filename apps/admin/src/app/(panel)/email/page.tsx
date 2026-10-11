import type { Metadata } from "next";
import { EmailLog } from "@/features/email/EmailLog";

export const metadata: Metadata = { title: "Delivery log" };

export default function Page() {
  return <EmailLog />;
}
