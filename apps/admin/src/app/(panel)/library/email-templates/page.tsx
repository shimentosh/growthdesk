import type { Metadata } from "next";
import { EmailDesignLibrary } from "@/features/library/EmailDesignLibrary";

export const metadata: Metadata = { title: "Email templates" };

export default function Page() {
  return <EmailDesignLibrary />;
}
