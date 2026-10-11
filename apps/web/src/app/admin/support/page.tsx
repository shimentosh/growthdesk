"use client";

import { Suspense } from "react";
import { Support } from "@/components/platform/Support";

/** Suspense: the page reads its filters from the URL with useSearchParams. */
export default function AdminSupportPage() {
  return (
    <Suspense fallback={null}>
      <Support />
    </Suspense>
  );
}
