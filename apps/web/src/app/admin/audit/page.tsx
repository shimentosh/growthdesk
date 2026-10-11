"use client";

import { Suspense } from "react";
import { AuditLog } from "@/components/platform/Logs";

/** Suspense: the page reads its filters from the URL with useSearchParams. */
export default function AdminAuditPage() {
  return (
    <Suspense fallback={null}>
      <AuditLog />
    </Suspense>
  );
}
