import type { Metadata } from "next";
import { Suspense } from "react";
import { Support } from "@/features/support/Support";

export const metadata: Metadata = { title: "Support" };

/** Suspense: the page reads its filters from the URL with useSearchParams. */
export default function Page() {
  return (
    <Suspense fallback={null}>
      <Support />
    </Suspense>
  );
}
