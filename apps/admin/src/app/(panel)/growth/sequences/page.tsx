import type { Metadata } from "next";
import { Sequences } from "@/features/growth/Sequences";

export const metadata: Metadata = { title: "Onboarding sequences" };

export default function Page() {
  return <Sequences />;
}
