import type { ReactNode } from "react";
import { PublicShell } from "@/components/site/PublicShell";
import { getSite } from "@/lib/site";

/** The public marketing pages (/pricing, /terms, /privacy). "/" renders the same shell from app/page.tsx. */
export default async function PublicLayout({ children }: { children: ReactNode }) {
  const site = await getSite();
  return <PublicShell site={site}>{children}</PublicShell>;
}
