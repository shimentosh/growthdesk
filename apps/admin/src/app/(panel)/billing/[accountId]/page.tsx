import type { Metadata } from "next";
import { BillingAccountDetail } from "@/features/billing/BillingAccountDetail";

export const metadata: Metadata = { title: "Billing account" };

export default function Page() {
  return <BillingAccountDetail />;
}
