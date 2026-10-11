"use client";

import { useEffect, useState, type ReactNode } from "react";
import { useParams, usePathname, useRouter } from "next/navigation";
import { MaintenanceBanner, SupportLink } from "@/components/shell/PlatformNotices";
import { Sidebar } from "@/components/shell/Sidebar";
import { Topbar } from "@/components/shell/Topbar";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { DialogPrimitive as D } from "@/components/ui/Dialog";
import { ErrorState } from "@/components/ui/ErrorState";
import { Page } from "@/components/ui/PageHeader";
import { LoadingBlock } from "@/components/ui/Skeleton";
import { UpgradeDialogHost } from "@/components/ui/UpgradePrompt";
import { post } from "@/lib/api";
import { useWorkspaceDetailQuery, WorkspaceProvider } from "@/lib/session";

/**
 * The workspace shell: loads the workspace once (role, permissions, plan),
 * provides it to every page below through WorkspaceProvider, and frames the
 * page with the sidebar and top bar. Below the `nav` breakpoint the sidebar
 * becomes a drawer.
 */
export default function WorkspaceLayout({ children }: { children: ReactNode }) {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const pathname = usePathname();
  const router = useRouter();
  const ws = useWorkspaceDetailQuery(workspaceId);
  const [navOpen, setNavOpen] = useState(false);

  // So "/" brings them back here next time.
  useEffect(() => {
    if (ws.data) void post(`/auth/me/workspace/${ws.data.id}`).catch(() => undefined);
  }, [ws.data]);

  // A route change closes the mobile drawer.
  useEffect(() => setNavOpen(false), [pathname]);

  // The workspace requires two-factor and this account has none: off to enrol (the account page explains why).
  const needsTwoFactor = ws.error?.code === "two_factor_required";
  useEffect(() => {
    if (needsTwoFactor) router.replace("/account#two-factor");
  }, [needsTwoFactor, router]);

  if (ws.isPending) return <LoadingBlock className="min-h-dvh" label="Opening workspace…" />;
  if (needsTwoFactor) return <LoadingBlock className="min-h-dvh" label="This workspace requires two-factor authentication…" />;
  if (ws.isError) {
    return (
      <Page width="narrow" className="pt-[12vh]">
        <ErrorState error={ws.error} title={ws.error.isNotFound ? "Workspace not found" : undefined} onRetry={() => void ws.refetch()} />
      </Page>
    );
  }

  const w = ws.data;
  return (
    <WorkspaceProvider detail={w}>
      <div className="flex h-dvh overflow-hidden bg-bg">
        <aside className="hidden w-[232px] shrink-0 border-r border-line bg-sidebar nav:block">
          <Sidebar />
        </aside>

        <D.Root open={navOpen} onOpenChange={setNavOpen}>
          <D.Portal>
            <D.Overlay className="fixed inset-0 z-50 bg-scrim animate-fade-in nav:hidden" />
            <D.Content aria-describedby={undefined} className="fixed inset-y-0 left-0 z-50 w-[260px] border-r border-line-strong bg-sidebar shadow-sheet animate-slide-in-left nav:hidden">
              <D.Title className="sr-only">Navigation</D.Title>
              <Sidebar onNavigate={() => setNavOpen(false)} />
            </D.Content>
          </D.Portal>
        </D.Root>

        <div className="flex min-w-0 flex-1 flex-col">
          <Topbar onOpenNav={() => setNavOpen(true)} />
          <main className="min-h-0 flex-1 overflow-y-auto">
            <MaintenanceBanner className="px-4 pt-4 nav:px-6" />
            {w.status === "suspended" && (
              <div className="px-4 pt-4 nav:px-6">
                <Callout tone="bad" title="This workspace is suspended">
                  {w.suspendedReason || "Changes are disabled."}{" "}
                  <SupportLink subject={`Suspended workspace: ${w.name}`}>Contact support</SupportLink> to restore access.
                </Callout>
              </div>
            )}
            {w.status !== "suspended" && w.plan.access === "restricted" && (
              <div className="px-4 pt-4 nav:px-6">
                <Callout
                  tone="warn"
                  title="Your workspace is in read-only mode"
                  action={
                    w.permissions.includes("billing.read") ? (
                      <Button size="sm" variant="primary" href={`/w/${w.id}/settings/billing`}>
                        Update payment
                      </Button>
                    ) : undefined
                  }
                >
                  {w.plan.reason}
                  {!w.permissions.includes("billing.read") && " Ask the account owner to update the payment method."}
                </Callout>
              </div>
            )}
            {children}
          </main>
        </div>
      </div>
      <UpgradeDialogHost />
    </WorkspaceProvider>
  );
}
