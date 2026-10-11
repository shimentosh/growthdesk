import type { Metadata } from "next";
import { SequenceEditor } from "@/features/growth/SequenceEditor";

export const metadata: Metadata = { title: "Sequence" };

export default function Page() {
  return <SequenceEditor />;
}
