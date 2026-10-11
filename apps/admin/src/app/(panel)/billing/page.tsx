import type { Metadata } from "next";
import { Suspense } from "react";
import { BillingAccountsList } from "@/features/billing/BillingAccounts";

export const metadata: Metadata = { title: "Billing accounts" };

/** Suspense: the page reads its filters from the URL with useSearchParams. */
export default function Page() {
  return (
    <Suspense fallback={null}>
      <BillingAccountsList />
    </Suspense>
  );
}
