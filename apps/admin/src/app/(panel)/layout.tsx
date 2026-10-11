import { cookies, headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import type { ReactNode } from "react";
import { AdminShell } from "@/components/shell/AdminShell";
import { Callout } from "@/components/ui/Callout";
import { PATH_HEADER, SIDEBAR_COOKIE } from "@/lib/constants";
import { customerAppUrl, environmentFor } from "@/lib/environment";
import { serverGet } from "@/lib/server-api";
import type { Me } from "@/lib/types";

/*
 * The console gate. Signed out (or an expired session) → /login; a customer
 * account → 404 (the console is not advertised). This is a courtesy: every
 * /v1/admin endpoint checks the platform role itself.
 */
export default async function PanelLayout({ children }: { children: ReactNode }) {
  const [me, jar, h] = await Promise.all([serverGet<Me>("/auth/me"), cookies(), headers()]);
  if (!me.ok) {
    if (me.status === 401) {
      const path = h.get(PATH_HEADER);
      redirect(path && path !== "/" ? `/login?next=${encodeURIComponent(path)}` : "/login");
    }
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

  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto");
  return (
    <AdminShell
      me={me.data}
      role={role}
      collapsed={jar.get(SIDEBAR_COOKIE)?.value === "collapsed"}
      environment={environmentFor(host)}
      appUrl={customerAppUrl(host, proto)}
    >
      {children}
    </AdminShell>
  );
}
