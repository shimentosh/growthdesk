import type { Metadata } from "next";
import { Registration } from "@/features/registration/Registration";

export const metadata: Metadata = { title: "Registration" };

export default function Page() {
  return <Registration />;
}
