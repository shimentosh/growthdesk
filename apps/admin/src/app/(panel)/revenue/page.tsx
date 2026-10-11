import type { Metadata } from "next";
import { Suspense } from "react";
import { Revenue } from "@/features/revenue/Revenue";

export const metadata: Metadata = { title: "Revenue & MRR" };

/** Suspense: the page keeps its range and currency in the URL (useSearchParams). */
export default function Page() {
  return (
    <Suspense fallback={null}>
      <Revenue />
    </Suspense>
  );
}
