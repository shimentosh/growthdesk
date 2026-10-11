"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { MailX } from "lucide-react";
import type { PreferencesDetails } from "@growthdesk/shared";
import { AuthCard, AuthFooter } from "@/components/account/AuthFrame";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { FormError } from "@/components/ui/Field";
import { LoadingBlock } from "@/components/ui/Skeleton";
import { Switch } from "@/components/ui/Switch";
import { ApiError, get, messageOf, post } from "@/lib/api";

/*
 * The preference page a marketing email links to (/api/m/u/:token redirects
 * here). Opening it changes nothing — link scanners follow GETs — and every
 * change waits for Save or "Unsubscribe from all marketing". The visitor is
 * an email recipient, not a Growthdesk user, so nothing here asks them to
 * sign in or points them into the app.
 */

type Update = { unsubscribeAll: true } | { lists: { listId: string; subscribed: boolean }[] };

export function Preferences({ token }: { token: string }) {
  const path = `/m/p/${encodeURIComponent(token)}`;
  const details = useQuery<PreferencesDetails, ApiError>({
    queryKey: ["preferences", token],
    queryFn: ({ signal }) => get<PreferencesDetails>(path, { signal, noAuthRedirect: true }),
    retry: false,
    refetchOnWindowFocus: false,
  });
  /** Switches the person has flipped, by list id; the server's value otherwise. */
  const [edits, setEdits] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState<"save" | "all" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<"lists" | "all" | null>(null);
  /** What the last save answered — the state from then on (set together with `saved`, so they render as one). */
  const [latest, setLatest] = useState<PreferencesDetails | null>(null);

  async function send(body: Update, which: "save" | "all") {
    setBusy(which);
    setError(null);
    try {
      setLatest(await post<PreferencesDetails>(path, body, { noAuthRedirect: true }));
      setEdits({});
      setSaved(which === "all" ? "all" : "lists");
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(null);
    }
  }

  if (details.isPending) return <LoadingBlock label="Opening your preferences…" />;

  if (details.isError) {
    if (details.error.isNotFound)
      return token === "test" ? (
        <AuthCard title="Email preferences">
          <Callout tone="info">This is a test email, so there are no preferences to change.</Callout>
        </AuthCard>
      ) : (
        <AuthCard title="This link can't be used" description="This link has expired or is invalid.">
          <p className="text-center text-xs text-text-3">To change what you receive, use the link at the bottom of a more recent email.</p>
        </AuthCard>
      );
    return (
      <AuthCard title="Couldn't open your preferences">
        <Callout tone="bad">{details.error.message}</Callout>
        <Button variant="primary" className="w-full" onClick={() => void details.refetch()}>
          Try again
        </Button>
      </AuthCard>
    );
  }

  const d = latest ?? details.data;
  const sender = d.workspaceName || d.legalName;
  const value = (id: string, server: boolean) => edits[id] ?? server;
  const changes = d.lists.filter((l) => value(l.id, l.subscribed) !== l.subscribed).map((l) => ({ listId: l.id, subscribed: value(l.id, l.subscribed) }));
  const dirty = changes.length > 0;

  return (
    <AuthCard
      title="Email preferences"
      description={
        <>
          Choose what {sender} sends to <span className="font-medium break-words text-text-hi">{d.email}</span>.
        </>
      }
    >
      {saved === "all" && !dirty ? (
        <Callout tone="ok" title="You're unsubscribed from all marketing">
          {d.email} won&apos;t receive marketing email from {sender}. You can turn a list back on here at any time.
        </Callout>
      ) : saved === "lists" && !dirty ? (
        <Callout tone="ok">Your preferences are saved.</Callout>
      ) : d.unsubscribedFromAll ? (
        <Callout tone="info">You aren&apos;t receiving marketing email from {sender} right now. Turn a list on to subscribe again.</Callout>
      ) : null}

      {d.lists.length > 0 ? (
        <ul className="divide-y divide-line rounded-lg border border-line">
          {d.lists.map((l) => (
            <li key={l.id} className="px-4 py-3">
              <Switch
                checked={value(l.id, l.subscribed)}
                onCheckedChange={(on) => {
                  setSaved(null);
                  setEdits((prev) => ({ ...prev, [l.id]: on }));
                }}
                disabled={busy !== null}
                label={<span className="font-medium text-text-hi">{l.name}</span>}
                description={l.description || undefined}
              />
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-center text-sm text-text-3">You aren&apos;t on any of {sender}&apos;s mailing lists.</p>
      )}

      <FormError error={error} />

      <div className="flex flex-col gap-2">
        {d.lists.length > 0 && (
          <Button variant="primary" className="w-full" loading={busy === "save"} disabled={!dirty || busy !== null} onClick={() => void send({ lists: changes }, "save")}>
            Save preferences
          </Button>
        )}
        {!(d.unsubscribedFromAll && !dirty) && (
          <Button variant="ghost" className="w-full" icon={<MailX />} loading={busy === "all"} disabled={busy !== null} onClick={() => void send({ unsubscribeAll: true }, "all")}>
            Unsubscribe from all marketing
          </Button>
        )}
      </div>

      {d.legalName && d.legalName !== d.workspaceName && <AuthFooter>{`${d.workspaceName} emails are sent by ${d.legalName}.`}</AuthFooter>}
    </AuthCard>
  );
}
