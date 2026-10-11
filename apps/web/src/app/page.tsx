import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { Callout } from "@/components/ui/Callout";
import { Landing } from "@/components/site/Landing";
import { PublicShell } from "@/components/site/PublicShell";
import { serverGet } from "@/lib/server-api";
import { getSite } from "@/lib/site";
import type { Me } from "@/lib/types";

/*
 * "/" is two things:
 *   - signed in → a router: no workspace yet → /onboarding, otherwise the
 *     workspace they were last in (or their first);
 *   - signed out → the landing page (in the public site's frame), or /login
 *     when the super-admin switched the landing page off (landingEnabled).
 * A stale session cookie (the API answers 401) counts as signed out.
 */
export default async function Home() {
  const jar = await cookies();
  if (jar.has("gd_session")) {
    const me = await serverGet<Me>("/auth/me");
    if (me.ok) {
      const { workspaces, lastWorkspaceId } = me.data;
      const target = workspaces.find((w) => w.id === lastWorkspaceId) ?? workspaces[0];
      redirect(target ? `/w/${target.id}` : "/onboarding");
    }
    if (me.status !== 401) {
      return (
        <main className="grid min-h-dvh place-items-center bg-bg-deep p-4">
          <Callout tone="bad" title="Could not load your account" className="w-full max-w-sm">
            {me.message}
          </Callout>
        </main>
      );
    }
  }

  const site = await getSite();
  if (!site.landingEnabled) redirect("/login");
  return (
    <PublicShell site={site}>
      <Landing site={site} />
    </PublicShell>
  );
}
