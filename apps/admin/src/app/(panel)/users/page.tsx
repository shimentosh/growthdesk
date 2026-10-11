import type { Metadata } from "next";
import { Suspense } from "react";
import { UsersList } from "@/features/users/Users";

export const metadata: Metadata = { title: "Users" };

/** Suspense: the page reads its filters from the URL with useSearchParams. */
export default function Page() {
  return (
    <Suspense fallback={null}>
      <UsersList />
    </Suspense>
  );
}
