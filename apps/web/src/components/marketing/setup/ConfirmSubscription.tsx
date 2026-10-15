"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { MailCheck } from "lucide-react";
import type { ConfirmSubscriptionDetails } from "@growthdesk/shared";
import { AuthCard, AuthFooter } from "@/components/account/AuthFrame";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { FormError } from "@/components/ui/Field";
import { LoadingBlock } from "@/components/ui/Skeleton";
import { ApiError, get, messageOf, post } from "@/lib/api";

/*
 * The page a double opt-in email links to (/confirm/:token). Opening it
 * changes nothing — mail scanners open links, and must not be able to
 * subscribe anyone — so the person presses "Confirm subscription", which
 * POSTs /m/s/:token. The visitor is an email recipient, not a Growthdesk
 * user: nothing here asks them to sign in.
 */
export function ConfirmSubscription({ token }: { token: string }) {
  const path = `/m/s/${encodeURIComponent(token)}`;
  const details = useQuery<ConfirmSubscriptionDetails, ApiError>({
    queryKey: ["confirm-subscription", token],
    queryFn: ({ signal }) => get<ConfirmSubscriptionDetails>(path, { signal, noAuthRedirect: true }),
    retry: false,
    refetchOnWindowFocus: false,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [latest, setLatest] = useState<ConfirmSubscriptionDetails | null>(null);

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      setLatest(await post<ConfirmSubscriptionDetails>(path, {}, { noAuthRedirect: true }));
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }

  if (details.isPending) return <LoadingBlock label="Opening your confirmation…" />;

  if (details.isError) {
    if (details.error.isNotFound)
      return (
        <AuthCard title="This link can't be used" description="It is invalid, or you were taken off this list since it was sent.">
          <p className="text-center text-xs text-text-3">If you still want to join, sign up again and use the link in the new email.</p>
        </AuthCard>
      );
    return (
      <AuthCard title="Couldn't open this link">
        <Callout tone="bad">{details.error.message}</Callout>
        <Button variant="primary" className="w-full" onClick={() => void details.refetch()}>
          Try again
        </Button>
      </AuthCard>
    );
  }

  const d = latest ?? details.data;
  const sender = d.workspaceName || d.legalName;
  const footer = d.legalName && d.legalName !== d.workspaceName ? <AuthFooter>{`${d.workspaceName} emails are sent by ${d.legalName}.`}</AuthFooter> : null;

  if (d.status === "subscribed")
    return (
      <AuthCard title="You're subscribed" description={<>{d.listName} from {sender}</>}>
        <Callout tone="ok">
          Thanks for confirming. <span className="font-medium break-words">{d.email}</span> will receive {d.listName}. Every email has a link to change your preferences or unsubscribe.
        </Callout>
        {footer}
      </AuthCard>
    );

  if (d.status === "unsubscribed")
    return (
      <AuthCard title="You've unsubscribed from this list" description={<>{d.listName} from {sender}</>}>
        <p className="text-center text-sm text-text-3">
          {d.email} left {d.listName} after this link was sent, so it no longer subscribes you. To join again, use the link at the bottom of an email from {sender}.
        </p>
        {footer}
      </AuthCard>
    );

  return (
    <AuthCard
      title="Confirm your subscription"
      description={
        <>
          Subscribe <span className="font-medium break-words text-text-hi">{d.email}</span> to {d.listName} from {sender}?
        </>
      }
    >
      <FormError error={error} />
      <Button variant="primary" className="w-full" icon={<MailCheck />} loading={busy} onClick={() => void confirm()}>
        Confirm subscription
      </Button>
      <p className="text-center text-xs text-text-3">If you didn&apos;t ask to join, close this page — you won&apos;t be subscribed.</p>
      {footer}
    </AuthCard>
  );
}
