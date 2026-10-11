"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { MailCheck, MailX } from "lucide-react";
import type { PlatformEmailPreferencesDetails } from "@growthdesk/shared";
import { AuthCard } from "@/components/account/AuthFrame";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { FormError } from "@/components/ui/Field";
import { LoadingBlock } from "@/components/ui/Skeleton";
import { ApiError, get, messageOf, post } from "@/lib/api";

/*
 * Product-email preferences from a signed link. Opening the page changes
 * nothing — link scanners and spam filters follow every link in a message —
 * the opt-out happens only on the button (a POST, the same endpoint a mail
 * app's RFC 8058 one-click unsubscribe uses). "Subscribe again" turns consent
 * back on. Neither touches account emails (sign-in, billing, security).
 */

type Result = PlatformEmailPreferencesDetails & { changed: boolean };

export function EmailPreferences({ token }: { token: string }) {
  const path = `/platform-mail/u/${encodeURIComponent(token)}`;
  const details = useQuery<PlatformEmailPreferencesDetails, ApiError>({
    queryKey: ["platform-email-preferences", token],
    queryFn: ({ signal }) => get<PlatformEmailPreferencesDetails>(`${path}/details`, { signal, noAuthRedirect: true }),
    retry: false,
  });
  const [state, setState] = useState<Result | null>(null);
  const [busy, setBusy] = useState<"unsubscribe" | "resubscribe" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function act(kind: "unsubscribe" | "resubscribe") {
    setBusy(kind);
    setError(null);
    try {
      const r = kind === "unsubscribe" ? await post<Result>(path, { via: "page" }, { noAuthRedirect: true }) : await post<Result>(`${path}/resubscribe`, {}, { noAuthRedirect: true });
      setState(r);
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="flex justify-center px-4 py-16 sm:py-24">
      <div className="w-full max-w-md">{body()}</div>
    </section>
  );

  function body() {
    if (details.isPending) return <LoadingBlock label="Opening your email preferences…" />;
    if (details.isError) {
      const gone = details.error.isNotFound;
      return (
        <AuthCard title={gone ? "This link can't be used" : "Couldn't open the link"}>
          <Callout tone="bad">{gone ? "The link is incomplete or no longer valid. You can change product emails any time from your account settings." : details.error.message}</Callout>
          {!gone && (
            <Button variant="primary" className="w-full" onClick={() => void details.refetch()}>
              Try again
            </Button>
          )}
        </AuthCard>
      );
    }

    const d = state ?? details.data;
    const product = d.productName;

    if (d.suppressed) {
      return (
        <AuthCard title="Product emails are off" description={d.email}>
          <Callout tone="info">
            Earlier emails to this address bounced or were reported, so {product} stopped sending product news to it. Contact support if you would like that reviewed.
          </Callout>
        </AuthCard>
      );
    }

    if (!d.subscribed) {
      return (
        <AuthCard title="You're unsubscribed" description={d.email}>
          <div className="flex justify-center text-text-3" aria-hidden>
            <MailX className="size-8" />
          </div>
          <Callout tone="ok" title={state && !state.changed ? "This address was already opted out" : state ? "Done" : undefined}>
            You won&apos;t receive product news, tips or onboarding emails from {product}. Emails about your account — sign-in, security and billing — still arrive.
          </Callout>
          <FormError error={error} />
          <Button variant="secondary" className="w-full" loading={busy === "resubscribe"} onClick={() => void act("resubscribe")}>
            Subscribe again
          </Button>
        </AuthCard>
      );
    }

    return (
      <AuthCard title="Product emails" description={d.email}>
        <div className="flex justify-center text-text-3" aria-hidden>
          <MailCheck className="size-8" />
        </div>
        {state?.changed ? (
          <Callout tone="ok" title="You're subscribed again">
            You&apos;ll receive product news, tips and onboarding emails from {product}.
          </Callout>
        ) : (
          <p className="text-center text-sm text-pretty text-text-2">
            Stop product news, tips and onboarding emails from {product} to <span className="font-medium text-text-hi">{d.email}</span>? Emails about your account still arrive.
          </p>
        )}
        <FormError error={error} />
        <Button variant="primary" className="w-full" loading={busy === "unsubscribe"} onClick={() => void act("unsubscribe")}>
          Unsubscribe
        </Button>
      </AuthCard>
    );
  }
}
