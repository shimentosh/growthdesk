"use client";

import { Suspense } from "react";
import { BillingAccountsList } from "@/components/platform/BillingAccounts";

/** Suspense: the page reads its filters from the URL with useSearchParams. */
export default function AdminBillingPage() {
  return (
    <Suspense fallback={null}>
      <BillingAccountsList />
    </Suspense>
  );
}
