import type { Metadata } from "next";
import { TemplateEditor } from "@/features/email/TemplateEditor";

export const metadata: Metadata = { title: "Email template" };

export default function Page() {
  return <TemplateEditor />;
}
