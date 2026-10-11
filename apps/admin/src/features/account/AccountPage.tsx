"use client";

import { ErrorState } from "@/components/ui/ErrorState";
import { Page, PageHeader } from "@/components/ui/PageHeader";
import { LoadingBlock } from "@/components/ui/Skeleton";
import { useMe } from "@/lib/session";
import { TwoFactorCard } from "./TwoFactorCard";

/** /account — the signed-in staff member's own sign-in security. */
export function AccountPage() {
  const me = useMe();
  if (me.isPending) return <LoadingBlock className="min-h-[50vh]" label="Loading your account…" />;
  if (me.isError) {
    return (
      <Page width="narrow">
        <ErrorState error={me.error} onRetry={() => void me.refetch()} />
      </Page>
    );
  }
  return (
    <Page width="narrow">
      <PageHeader title="Your account" description={`Signed in as ${me.data.user.email}.`} />
      <TwoFactorCard user={me.data.user} />
    </Page>
  );
}
