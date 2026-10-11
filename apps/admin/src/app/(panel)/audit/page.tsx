import type { Metadata } from "next";
import { Suspense } from "react";
import { AuditLog } from "@/features/audit/AuditLog";

export const metadata: Metadata = { title: "Audit log" };

/** Suspense: the page reads its filters from the URL with useSearchParams. */
export default function Page() {
  return (
    <Suspense fallback={null}>
      <AuditLog />
    </Suspense>
  );
}
