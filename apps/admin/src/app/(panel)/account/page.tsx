import type { Metadata } from "next";
import { AccountPage } from "@/features/account/AccountPage";

export const metadata: Metadata = { title: "Your account" };

export default function Page() {
  return <AccountPage />;
}
