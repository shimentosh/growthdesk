"use client";

import { useState } from "react";
import { CircleAlert, Link2, ShieldCheck, Unplug } from "lucide-react";
import { Badge, StatusBadge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, CardBody, CardFooter } from "@/components/ui/Card";
import { ConfirmDialog } from "@/components/ui/Dialog";
import { CHANNEL, ChannelTile } from "@/components/ui/icons";
import { KeyValueList, type KeyValueItem } from "@/components/ui/KeyValue";
import { toast } from "@/components/ui/Toast";
import { useApiMutation } from "@/lib/query";
import { useFormat, useWorkspace } from "@/lib/session";
import { CHANNEL_PROVIDER_LABELS, type ChannelCapabilities, type ChannelIntegration } from "@/lib/types/integrations";
import { CopyValue } from "./Copy";
import { StartLinkModal } from "./ChannelTools";

const isChannel = (c: string): c is keyof typeof CHANNEL => c in CHANNEL;

/** What the provider's rules allow, from the capabilities the API reports. */
function capabilityText(c: ChannelCapabilities): string {
  const parts: string[] = [];
  if (!c.canInitiate) parts.push("Can only message people who have started a chat with it first.");
  else if (c.requiresTemplateToInitiate) parts.push("Starts conversations with approved message templates.");
  else parts.push("Can start conversations.");
  if (c.freeFormWindowHours) parts.push(`Free-form messages only within ${c.freeFormWindowHours} hours of the contact's last message.`);
  parts.push(c.supportsDeliveryReceipts ? "Reports delivered and read receipts." : "No delivery receipts.");
  return parts.join(" ");
}

function details(row: ChannelIntegration): KeyValueItem[] {
  const d = row.details;
  if (row.provider === "meta_cloud") {
    return [
      { label: "Number", value: d.displayPhoneNumber },
      { label: "Verified name", value: d.verifiedName },
      { label: "Phone number ID", value: d.phoneNumberId ? <span className="font-mono text-xs">{d.phoneNumberId}</span> : null },
      { label: "Business account ID", value: d.businessAccountId ? <span className="font-mono text-xs">{d.businessAccountId}</span> : null },
    ];
  }
  if (row.provider === "telegram_bot") {
    return [
      { label: "Bot", value: d.botUsername ? `@${d.botUsername}` : null },
      { label: "Bot name", value: d.botName },
      { label: "Delivery", value: d.mode === "webhook" ? "Webhook" : d.mode === "polling" ? "Polling" : null },
    ];
  }
  if (row.provider === "twilio") {
    return [
      { label: "Account", value: d.friendlyName },
      { label: "Account SID", value: d.accountSid ? <span className="font-mono text-xs">{d.accountSid}</span> : null },
      { label: "Caller ID", value: d.callerId },
    ];
  }
  return [];
}

/** One connected WhatsApp number, Telegram bot or calling account: status, details, setup values and actions. */
export function ChannelCard({ row }: { row: ChannelIntegration }) {
  const ws = useWorkspace();
  const f = useFormat();
  const manage = ws.can("integrations.manage");
  const canLink = row.provider === "telegram_bot" && ws.can(["inbox.reply", "contacts.write"]) && ws.can("contacts.read");
  const [confirm, setConfirm] = useState(false);
  const [link, setLink] = useState(false);

  const verify = useApiMutation<ChannelIntegration, void>({
    path: ws.path(`/channels/${row.id}/verify`),
    invalidate: [ws.key("channels"), ws.key("calls")],
    onSuccess: (r) => {
      if (r.status === "connected") toast.success(`${r.name} is working`);
      else toast.error(r.lastError || `${r.name} could not be verified`);
    },
  });
  const remove = useApiMutation<{ ok: boolean }, void>({
    method: "DELETE",
    path: ws.path(`/channels/${row.id}`),
    invalidate: [ws.key("channels"), ws.key("calls")],
    success: `${row.name} disconnected`,
    errorToast: false,
  });

  const whatsappSetup = row.provider === "meta_cloud" && row.webhookUrl;
  const telegramWebhook = row.provider === "telegram_bot" && row.details.mode === "webhook" && row.webhookUrl;

  return (
    <Card className="flex flex-col">
      <CardBody className="flex flex-1 flex-col gap-4">
        <div className="flex flex-wrap items-start gap-3">
          {isChannel(row.channel) && <ChannelTile channel={row.channel} size="md" />}
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="truncate text-sm font-semibold text-text-hi">{row.name}</h3>
              <StatusBadge value={row.status} />
              <Badge quiet>{CHANNEL_PROVIDER_LABELS[row.provider] ?? row.provider}</Badge>
            </div>
            <p className="mt-0.5 text-xs text-text-3">
              {row.lastEventAt ? `Last activity ${f.relative(row.lastEventAt)}` : "No activity yet"} · connected {f.date(row.createdAt)}
            </p>
          </div>
        </div>

        {row.lastError && (
          <p className="flex items-start gap-1.5 text-xs text-bad-ink">
            <CircleAlert aria-hidden className="mt-px size-3.5 shrink-0" />
            <span className="min-w-0 break-words">{row.lastError}</span>
          </p>
        )}

        <KeyValueList columns={2} items={details(row)} />

        {row.capabilities && <p className="text-xs text-text-2">{capabilityText(row.capabilities)}</p>}

        {whatsappSetup && (
          <div className="flex flex-col gap-2 rounded-md border border-line p-3">
            <div className="text-xs font-semibold text-text-hi">Webhook setup in Meta</div>
            <p className="text-xs text-text-2">
              In your Meta app, open WhatsApp → Configuration, set the callback URL and verify token below, then subscribe to the <code className="font-mono">messages</code> field.
              Until then, replies and delivery receipts do not arrive.
            </p>
            <div className="text-2xs font-medium text-text-3 uppercase">Callback URL</div>
            <CopyValue value={row.webhookUrl as string} label="Copy callback URL" copied="Callback URL copied" />
            {manage && row.verifyToken && (
              <>
                <div className="text-2xs font-medium text-text-3 uppercase">Verify token</div>
                <CopyValue value={row.verifyToken} label="Copy verify token" copied="Verify token copied" />
              </>
            )}
          </div>
        )}

        {row.provider === "telegram_bot" && row.setup && (
          <div className="flex flex-col gap-2">
            <p className="text-xs text-text-2">{row.setup}</p>
            {telegramWebhook && <CopyValue value={row.webhookUrl as string} label="Copy webhook URL" copied="Webhook URL copied" />}
          </div>
        )}
      </CardBody>

      {(manage || canLink) && (
        <CardFooter>
          <div className="flex w-full flex-wrap items-center gap-2">
            {manage && (
              <Button size="sm" icon={<ShieldCheck />} loading={verify.isPending} onClick={() => verify.mutate()}>
                Verify
              </Button>
            )}
            {canLink && (
              <Button size="sm" icon={<Link2 />} onClick={() => setLink(true)}>
                Start link for a contact
              </Button>
            )}
            {manage && (
              <Button size="sm" variant="danger" icon={<Unplug />} className="ml-auto" onClick={() => setConfirm(true)}>
                Disconnect
              </Button>
            )}
          </div>
        </CardFooter>
      )}

      {canLink && <StartLinkModal integration={row} open={link} onOpenChange={setLink} />}
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={`Disconnect ${row.name}?`}
        description={
          row.provider === "twilio"
            ? "Its credentials are deleted and no more calls can be placed through it. Call history stays. You can connect it again later."
            : "Its credentials are deleted and nothing more is sent or received through it. Conversations already filed stay. You can connect it again later."
        }
        confirmLabel="Disconnect"
        onConfirm={() => remove.mutateAsync()}
      />
    </Card>
  );
}
