"use client";

import { UserPlus } from "lucide-react";
import { Callout } from "@/components/ui/Callout";
import { QueryState } from "@/components/ui/ErrorState";
import { IconTile } from "@/components/ui/IconTile";
import { Page, PageHeader } from "@/components/ui/PageHeader";
import { SkeletonText } from "@/components/ui/Skeleton";
import { useApiQuery } from "@/lib/query";
import { platformKey, usePlatform } from "@/features/common/platform";
import { RegistrationPolicy } from "./RegistrationPolicy";
import { SignupInvites } from "./SignupInvites";
import { Waitlist } from "./Waitlist";
import type { RegistrationSettings } from "./types";

/** /registration — the sign-up policy, the waitlist and sign-up invitations. */
export function Registration() {
  const { canChange } = usePlatform();
  const q = useApiQuery<RegistrationSettings>(platformKey("settings"), "/admin/settings");
  return (
    <Page width="narrow">
      <PageHeader
        icon={<IconTile icon={<UserPlus />} tint="green" size="lg" />}
        title="Registration"
        description="Who can create an account, which addresses are refused, and the people waiting for an invitation. Every change is recorded in the audit log."
      />
      <QueryState query={q} loading={<SkeletonText lines={12} />}>
        {(s) => (
          <div className="flex flex-col gap-4">
            {!canChange && <Callout tone="info">Platform support can view the sign-up policy; an admin or owner changes it and manages the waitlist and invitations.</Callout>}
            <RegistrationPolicy
              key={[s.signupMode, s.signupDomains, s.blockDisposableDomains, s.extraBlockedDomains, s.requireEmailVerification, s.defaultTrialDays].map((v) => JSON.stringify(v)).join("|")}
              s={s}
            />
            {canChange && (
              <>
                <Waitlist active={s.signupMode === "waitlist"} />
                <SignupInvites />
              </>
            )}
          </div>
        )}
      </QueryState>
    </Page>
  );
}
