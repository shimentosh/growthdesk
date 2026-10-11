"use client";

import { useState } from "react";
import { Mail, Settings } from "lucide-react";
import { StatusBadge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { Checkbox } from "@/components/ui/Checkbox";
import { EmptyState } from "@/components/ui/EmptyState";
import { FormError } from "@/components/ui/Field";
import { SkeletonText } from "@/components/ui/Skeleton";
import { formatNumber } from "@/lib/format";
import { useApiQuery } from "@/lib/query";
import { useWorkspace } from "@/lib/session";
import type { CampaignDetail } from "@/lib/types/campaigns";
import type { Mailbox } from "@/lib/types/integrations";
import { lockedReason, useCampaignPatch } from "./common";

/**
 * Which mailboxes email steps may send from (PATCH mailboxIds). The engine
 * picks the connected one with the most room left today and keeps a
 * contact's follow-ups on the mailbox that sent their first email.
 */
export function MailboxesEditor({ campaign }: { campaign: CampaignDetail }) {
  const ws = useWorkspace();
  const canList = ws.can("integrations.read");
  const locked = lockedReason(campaign.status);
  const disabled = Boolean(locked) || !ws.can("campaigns.write");
  const initial = campaign.mailboxes.map((m) => m.id);
  const [chosen, setChosen] = useState<string[]>(initial);
  const save = useCampaignPatch(campaign.id, "Mailboxes saved");
  const mailboxes = useApiQuery<Mailbox[]>(ws.key("mailboxes", "list"), canList ? ws.path("/mailboxes") : null);
  const dirty = JSON.stringify([...initial].sort()) !== JSON.stringify([...chosen].sort());
  const hasEmailStep = campaign.steps.some((s) => s.type === "email");

  return (
    <div className="flex flex-col gap-4">
      {locked && <Callout tone="info">{locked}</Callout>}
      {!hasEmailStep && <Callout tone="info">This campaign has no email step, so it does not send from a mailbox.</Callout>}
      <Card>
        <CardHeader
          icon={<Mail />}
          title="Send from"
          description="Each email goes from the chosen connected mailbox with the most room under its daily limit; a contact's follow-ups stay on the mailbox that started their thread. With none chosen, any connected mailbox in the workspace is used."
        />
        <CardBody>
          {save.error && !save.error.isPlanLimit && <FormError error={save.error.fields.mailboxIds ?? save.error.message} className="mb-3" />}
          {!canList ? (
            <div className="flex flex-col gap-2 text-sm">
              <p className="text-text-3">Your role cannot list the workspace's mailboxes. Chosen:</p>
              {campaign.mailboxes.length ? (
                campaign.mailboxes.map((m) => (
                  <p key={m.id} className="flex items-center gap-2 text-text">
                    {m.email} <StatusBadge value={m.status} />
                  </p>
                ))
              ) : (
                <p className="text-text">None (any connected mailbox)</p>
              )}
            </div>
          ) : mailboxes.isPending ? (
            <SkeletonText lines={3} />
          ) : mailboxes.isError ? (
            <p className="text-sm text-bad-ink">{mailboxes.error.message}</p>
          ) : !mailboxes.data.length ? (
            <EmptyState
              compact
              icon={<Mail />}
              title="No mailbox is connected yet"
              description="Email steps send from a connected mailbox."
              action={
                ws.can("integrations.manage") ? (
                  <Button size="sm" icon={<Settings />} href={ws.href("/settings/mailboxes")}>
                    Connect one in Settings → Mailboxes
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <ul className="divide-y divide-line rounded-md border border-line">
              {mailboxes.data.map((m) => (
                <li key={m.id} className="flex flex-col gap-1 px-3 py-2 sm:flex-row sm:items-center sm:justify-between">
                  <Checkbox
                    checked={chosen.includes(m.id)}
                    disabled={disabled}
                    onCheckedChange={(on) => setChosen(on ? [...chosen, m.id] : chosen.filter((x) => x !== m.id))}
                    label={m.displayName ? `${m.displayName} <${m.email}>` : m.email}
                  />
                  <span className="flex items-center gap-2 pl-6 text-xs text-text-3 sm:pl-0">
                    {formatNumber(m.sentToday)} / {formatNumber(m.dailyLimit)} today
                    <StatusBadge value={m.status} />
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>
      {!disabled && canList && (
        <div className="flex justify-end">
          <Button variant="primary" disabled={!dirty} loading={save.isPending} onClick={() => save.mutate({ mailboxIds: chosen })}>
            Save mailboxes
          </Button>
        </div>
      )}
    </div>
  );
}
