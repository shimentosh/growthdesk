"use client";

import type { ReactNode } from "react";
import { Wrench } from "lucide-react";
import { Callout } from "@/components/ui/Callout";
import { cn } from "@/lib/cn";
import { PLATFORM_STATUS_KEY, type PlatformStatus } from "@/lib/platform-status";
import { useApiQuery } from "@/lib/query";
import { useMe } from "@/lib/session";

/** Refreshed every minute, and whenever a write is refused with 503 (see useApiMutation). */
export function usePlatformStatus() {
  return useApiQuery<PlatformStatus>(PLATFORM_STATUS_KEY, "/status", { staleTime: 30_000, refetchInterval: 60_000 });
}

/** A warning strip while the platform is in maintenance (writes are refused for everyone but platform admins). */
export function MaintenanceBanner({ className }: { className?: string }) {
  const status = usePlatformStatus();
  const me = useMe();
  const m = status.data?.maintenance;
  if (!m) return null;
  // AccessGuard lets platform staff keep writing during maintenance.
  const staff = Boolean(me.data && me.data.user.platformRole !== "none");
  return (
    <div className={className}>
      <Callout
        tone="warn"
        title={
          <span className="inline-flex items-center gap-1.5">
            <Wrench aria-hidden className="size-3.5" />
            Maintenance in progress
          </span>
        }
      >
        {m.message} {staff ? "As platform staff, your changes still save." : "You can still look around; saving changes is paused until it is over."}
      </Callout>
    </div>
  );
}

/**
 * "Contact support" that goes somewhere: a mailto: link to the platform's
 * support address (super-admin → Website → Branding). Without one configured,
 * plain text — there is nowhere honest to link to.
 */
export function SupportLink({ children = "Contact support", subject, className }: { children?: ReactNode; subject?: string; className?: string }) {
  const status = usePlatformStatus();
  const email = status.data?.supportEmail;
  if (!email) return <span className={className}>{children}</span>;
  const href = `mailto:${email}${subject ? `?subject=${encodeURIComponent(subject)}` : ""}`;
  return (
    <a href={href} className={cn("font-medium text-accent-hi underline-offset-2 hover:underline", className)}>
      {children}
    </a>
  );
}
