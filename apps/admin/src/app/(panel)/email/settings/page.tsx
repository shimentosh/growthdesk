import type { Metadata } from "next";
import { EmailSettings } from "@/features/email/EmailSettings";

export const metadata: Metadata = { title: "Email settings" };

export default function Page() {
  return <EmailSettings />;
}
