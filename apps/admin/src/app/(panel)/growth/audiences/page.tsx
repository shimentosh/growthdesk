import type { Metadata } from "next";
import { Audiences } from "@/features/growth/Audiences";

export const metadata: Metadata = { title: "Audiences" };

export default function Page() {
  return <Audiences />;
}
