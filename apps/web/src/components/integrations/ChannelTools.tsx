"use client";

import { useState } from "react";
import { UserRoundSearch } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { Modal } from "@/components/ui/Dialog";
import { ErrorState } from "@/components/ui/ErrorState";
import { Field } from "@/components/ui/Field";
import { NativeSelect } from "@/components/ui/Input";
import { Spinner } from "@/components/ui/Skeleton";
import { ContactPicker } from "@/components/pickers/Pickers";
import { useApiQuery } from "@/lib/query";
import { useFormat, useWorkspace } from "@/lib/session";
import type { ChannelIntegration, ChatReachability, TelegramStartLink } from "@/lib/types/integrations";
import { CopyValue } from "./Copy";

/**
 * A t.me link for one contact. When they open it and press Start, their
 * Telegram chat is filed against that contact (instead of creating a new
 * one), and the bot may message them from then on.
 */
export function StartLinkModal({ integration, open, onOpenChange }: { integration: ChannelIntegration; open: boolean; onOpenChange: (o: boolean) => void }) {
  const ws = useWorkspace();
  const [contactId, setContactId] = useState<string | null>(null);
  const link = useApiQuery<TelegramStartLink>(
    ws.key("channels", integration.id, "start-link"),
    open && contactId ? ws.path(`/channels/${integration.id}/start-link`) : null,
    { query: contactId ? { contactId } : undefined, staleTime: Infinity },
  );

  return (
    <Modal
      open={open}
      onOpenChange={(o) => {
        if (!o) setContactId(null);
        onOpenChange(o);
      }}
      title="Telegram start link"
      description={`For ${integration.details.botUsername ? `@${integration.details.botUsername}` : integration.name}`}
      footer={<Button onClick={() => onOpenChange(false)}>Done</Button>}
    >
      <div className="flex flex-col gap-4">
        <Field label="Contact">
          <ContactPicker value={contactId} onChange={(id) => setContactId(id)} />
        </Field>
        {contactId &&
          (link.isPending ? (
            <Spinner label="Creating link" />
          ) : link.isError ? (
            <ErrorState compact error={link.error} onRetry={() => void link.refetch()} />
          ) : link.data ? (
            <div className="flex flex-col gap-2">
              <CopyValue value={link.data.url} label="Copy link" copied="Start link copied" />
              <p className="text-xs text-text-3">
                Send this link to the contact. When they open it and press Start, their Telegram chat is linked to this contact and the bot can message them.
              </p>
            </div>
          ) : null)}
      </div>
    </Modal>
  );
}

/** "Could a WhatsApp / Telegram message reach this contact right now, and if not, why?" — the same check the composer uses. */
export function ReachabilityCheck() {
  const ws = useWorkspace();
  const f = useFormat();
  const [channel, setChannel] = useState<"whatsapp" | "telegram">("whatsapp");
  const [contactId, setContactId] = useState<string | null>(null);
  const r = useApiQuery<ChatReachability>(ws.key("channels", "reachability"), contactId ? ws.path("/channels/reachability") : null, {
    query: contactId ? { channel, contactId } : undefined,
  });

  return (
    <Card>
      <CardHeader icon={<UserRoundSearch />} title="Check a contact" description="Whether a message on this channel could reach a contact right now, and why not." />
      <CardBody className="flex flex-col gap-4">
        <div className="grid gap-3 sm:grid-cols-[160px_1fr]">
          <Field label="Channel">
            <NativeSelect
              value={channel}
              onChange={(e) => setChannel(e.target.value as "whatsapp" | "telegram")}
              options={[
                { value: "whatsapp", label: "WhatsApp" },
                { value: "telegram", label: "Telegram" },
              ]}
            />
          </Field>
          <Field label="Contact">
            <ContactPicker value={contactId} onChange={(id) => setContactId(id)} />
          </Field>
        </div>
        {contactId &&
          (r.isPending ? (
            <Spinner label="Checking" />
          ) : r.isError ? (
            <ErrorState compact error={r.error} onRetry={() => void r.refetch()} />
          ) : r.data ? (
            <div className="flex flex-col gap-1.5 rounded-md border border-line p-3">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={r.data.reachable ? "ok" : "bad"} dot>
                  {r.data.reachable ? "Reachable" : "Not reachable"}
                </Badge>
                {r.data.freeFormAllowed === false && <Badge tone="warn">Template only</Badge>}
              </div>
              <p className="text-sm text-text">{r.data.reason}</p>
              {r.data.freeFormUntil && <p className="text-xs text-text-3">Free-form messages allowed until {f.dateTime(r.data.freeFormUntil)}.</p>}
            </div>
          ) : null)}
      </CardBody>
    </Card>
  );
}
