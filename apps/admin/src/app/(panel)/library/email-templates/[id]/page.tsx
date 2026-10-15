import type { Metadata } from "next";
import { EmailDesignEditor } from "@/features/library/EmailDesignEditor";

export const metadata: Metadata = { title: "Email template" };

export default function Page() {
  return <EmailDesignEditor />;
}
