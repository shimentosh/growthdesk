"use client";

import { Suspense } from "react";
import { BillingSettings } from "@/components/admin/BillingSettings";

/** Suspense: the page reads ?checkout= (the payment provider's return) with useSearchParams. */
export default function BillingSettingsPage() {
  return (
    <Suspense>
      <BillingSettings />
    </Suspense>
  );
}
