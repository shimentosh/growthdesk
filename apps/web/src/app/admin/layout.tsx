import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import type { ReactNode } from "react";
import { PlatformShell } from "@/components/platform/PlatformShell";
import { Callout } from "@/components/ui/Callout";
import { serverGet } from "@/lib/server-api";
import type { Me } from "@/lib/types";

export const metadata: Metadata = { title: { default: "Platform admin", template: "%s · Platform admin · Growthdesk" } };

/*
 * The admin gate. Signed out → /login; a customer account → 404 (the area is
 * not advertised). This is a courtesy: every /v1/admin endpoint checks the
 * platform role itself.
 */
export default async function AdminLayout({ children }: { children: ReactNode }) {
  const me = await serverGet<Me>("/auth/me");
  if (!me.ok) {
    if (me.status === 401) redirect("/login?next=%2Fadmin");
    return (
      <main className="grid min-h-dvh place-items-center p-4">
        <Callout tone="bad" title="Could not load your account" className="w-full max-w-sm">
          {me.message}
        </Callout>
      </main>
    );
  }
  const role = me.data.user.platformRole;
  if (role === "none") notFound();
  return <PlatformShell role={role}>{children}</PlatformShell>;
}
