"use client";

import { useState } from "react";
import { MessageCircle, Radar, Send } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { EntityTile } from "@/components/ui/icons";
import { QueryState } from "@/components/ui/ErrorState";
import { PageHeader, Section } from "@/components/ui/PageHeader";
import { RequirePermission } from "@/components/ui/RequirePermission";
import { SkeletonText } from "@/components/ui/Skeleton";
import { ChannelCard } from "@/components/integrations/ChannelCard";
import { TelegramConnectModal, WhatsAppConnectModal } from "@/components/integrations/ChannelConnectModals";
import { ReachabilityCheck } from "@/components/integrations/ChannelTools";
import { useApiQuery } from "@/lib/query";
import { useWorkspace } from "@/lib/session";
import type { ChannelIntegration } from "@/lib/types/integrations";

export default function ChannelsPage() {
  const ws = useWorkspace();
  // Twilio (channel "call") has its own page, Settings → Calling.
  const channels = useApiQuery<ChannelIntegration[]>(ws.key("channels", "list"), ws.path("/channels"), { select: (rows) => rows.filter((r) => r.channel !== "call") });
  const manage = ws.can("integrations.manage");
  const [wa, setWa] = useState(false);
  const [tg, setTg] = useState(false);

  const connectButtons = manage ? (
    <>
      <Button icon={<MessageCircle />} onClick={() => setWa(true)}>
        Connect WhatsApp
      </Button>
      <Button icon={<Send />} onClick={() => setTg(true)}>
        Connect Telegram
      </Button>
    </>
  ) : undefined;

  const hasChat = (channels.data ?? []).some((c) => c.channel === "whatsapp" || c.channel === "telegram");

  return (
    <RequirePermission permission="integrations.read">
      <PageHeader
        icon={<EntityTile of="channels" />}
        title="WhatsApp & Telegram"
        description="Message contacts on WhatsApp and Telegram. Their replies are filed as conversations against the contact, like email replies."
        actions={channels.data && channels.data.length > 0 ? connectButtons : undefined}
      />
      <div className="flex flex-col gap-6">
        <QueryState
          query={channels}
          loading={
            <Card className="p-4">
              <SkeletonText lines={4} />
            </Card>
          }
          isEmpty={(d) => d.length === 0}
          empty={
            <Card>
              <EmptyState
                icon={<MessageCircle />}
                tint="green"
                title="No chat channel connected"
                description={
                  manage
                    ? "Connect a WhatsApp Business number (Meta Cloud API) or a Telegram bot to message contacts there."
                    : "Nobody has connected WhatsApp or Telegram yet. Ask a workspace admin to connect one."
                }
                action={connectButtons}
              />
            </Card>
          }
        >
          {(rows) => (
            <div className="grid gap-4 lg:grid-cols-2">
              {rows.map((r) => (
                <ChannelCard key={r.id} row={r} />
              ))}
            </div>
          )}
        </QueryState>

        {hasChat && ws.can("inbox.read") && ws.can("contacts.read") && (
          <Section icon={<Radar />} title="Reachability" description="Chat channels follow the provider's rules about who may be messaged and when.">
            <ReachabilityCheck />
          </Section>
        )}
      </div>

      {manage && (
        <>
          <WhatsAppConnectModal open={wa} onOpenChange={setWa} />
          <TelegramConnectModal open={tg} onOpenChange={setTg} />
        </>
      )}
    </RequirePermission>
  );
}
