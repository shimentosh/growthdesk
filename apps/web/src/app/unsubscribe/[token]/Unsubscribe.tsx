"use client";

import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import type { UnsubscribeDetails, UnsubscribeResult } from "@growthdesk/shared";
import { AuthCard } from "@/components/account/AuthFrame";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { FormError } from "@/components/ui/Field";
import { LoadingBlock } from "@/components/ui/Skeleton";
import { ApiError, get, messageOf, post } from "@/lib/api";

/*
 * Confirming an unsubscribe. Opening this page changes nothing: the link in
 * an email is also followed by link scanners and anti-spam filters, so the
 * opt-out happens only when the person presses the button (a POST — the same
 * endpoint a mail app's RFC 8058 one-click unsubscribe uses). The visitor is
 * an email recipient, not a Growthdesk user, so nothing here asks them to
 * sign in or points them into the app. A campaign's test send links to
 * /unsubscribe/test (no token): the page says so and asks the API nothing.
 */

function Frame({ title, children }: { title: string; children: ReactNode }) {
  return <AuthCard title={title}>{children}</AuthCard>;
}

const senderOf = (d: UnsubscribeDetails) => (d.senderName ? `${d.senderName} (${d.senderEmail})` : d.senderEmail);

export function Unsubscribe({ token }: { token: string }) {
  const path = `/t/u/${encodeURIComponent(token)}`;
  const details = useQuery<UnsubscribeDetails, ApiError>({
    queryKey: ["unsubscribe", token],
    queryFn: ({ signal }) => get<UnsubscribeDetails>(`${path}/details`, { signal, noAuthRedirect: true }),
    retry: false,
    enabled: token !== "test",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<UnsubscribeResult | null>(null);

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      setDone(await post<UnsubscribeResult>(path, { via: "page" }, { noAuthRedirect: true }));
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }

  if (token === "test") {
    return (
      <Frame title="Unsubscribe">
        <Callout tone="info">This is a test email, so there is nothing to unsubscribe from. Nothing was changed.</Callout>
      </Frame>
    );
  }

  if (details.isPending) return <LoadingBlock label="Opening your unsubscribe link…" />;

  if (details.isError) {
    const gone = details.error.isNotFound;
    return (
      <Frame title={gone ? "This link can't be used" : "Couldn't open the link"}>
        <Callout tone="bad">{details.error.message}</Callout>
        {!gone && (
          <Button variant="primary" className="w-full" onClick={() => void details.refetch()}>
            Try again
          </Button>
        )}
      </Frame>
    );
  }

  const d = details.data;

  if (done || d.suppressed) {
    const already = done ? !done.changed : true;
    return (
      <Frame title="You're unsubscribed">
        <Callout tone="ok" title={already ? "This address was already opted out" : "Done"}>
          {d.email} won&apos;t receive any more emails from {d.workspaceName}.
        </Callout>
      </Frame>
    );
  }

  return (
    <Frame title="Unsubscribe">
      <p className="text-center text-sm text-text-2">
        Stop emails to <span className="font-medium text-text-hi">{d.email}</span> from {senderOf(d)}?
      </p>
      <p className="text-center text-xs text-text-3">This stops all email from {d.workspaceName} to this address, not only from this sender.</p>
      <FormError error={error} />
      <Button variant="primary" loading={busy} onClick={confirm} className="w-full">
        Unsubscribe
      </Button>
    </Frame>
  );
}
