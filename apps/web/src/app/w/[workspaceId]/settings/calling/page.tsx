"use client";

import { useState } from "react";
import { Info, Phone } from "lucide-react";
import { AiCallingSettings } from "@/components/ai-calling/AiCallingSettings";
import { useCallSetup } from "@/components/calls/callHooks";
import { TwilioConnectModal } from "@/components/calls/TwilioConnectModal";
import { ChannelCard } from "@/components/integrations/ChannelCard";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { EntityTile } from "@/components/ui/icons";
import { QueryState } from "@/components/ui/ErrorState";
import { PageHeader, Section } from "@/components/ui/PageHeader";
import { RequirePermission } from "@/components/ui/RequirePermission";
import { SkeletonText } from "@/components/ui/Skeleton";
import { useApiQuery } from "@/lib/query";
import { useWorkspace } from "@/lib/session";
import type { ChannelIntegration } from "@/lib/types/integrations";

/*
 * Twilio for click-to-call. The account is a channel integration, so it is
 * listed, verified and disconnected through the channels API (ChannelCard);
 * connecting goes through the calls API, which checks the account with
 * Twilio first. Below it, AI calling: the Cartesia account voice agents call
 * through (components/ai-calling/AiCallingSettings), also a "call" channel
 * integration, so it is left out of the Twilio list.
 */
export default function CallingSettingsPage() {
  const ws = useWorkspace();
  const channels = useApiQuery<ChannelIntegration[]>(ws.key("channels", "list"), ws.path("/channels"), {
    select: (rows) => rows.filter((r) => r.channel === "call" && r.provider !== "cartesia"),
  });
  const setup = useCallSetup();
  const manage = ws.can("integrations.manage");
  const [connecting, setConnecting] = useState(false);
  const connectButton = manage ? (
    <Button icon={<Phone />} onClick={() => setConnecting(true)}>
      Connect Twilio
    </Button>
  ) : undefined;
  const reach = setup.data?.twilio.length ? setup.data.clickToCall.reason : null;

  return (
    <RequirePermission permission="integrations.read">
      <PageHeader
        icon={<EntityTile of="calling" />}
        title="Calling"
        description="Place calls from Growthdesk through your own Twilio account, and let AI agents call for you through Cartesia. Without either, reps dial from their own phones and log each call."
        actions={channels.data && channels.data.length > 0 ? connectButton : undefined}
      />
      <div className="flex flex-col gap-6">
        {reach && <Callout tone="warn" title="Click-to-call cannot work here yet">{reach}</Callout>}

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
                icon={<Phone />}
                tint="teal"
                title="Twilio is not connected"
                description={
                  manage
                    ? "Connect a Twilio account to let reps press Call on a contact: Twilio rings the rep's phone, then connects them to the contact."
                    : "Nobody has connected Twilio yet. Ask a workspace admin to connect it. Calls can still be logged by hand."
                }
                action={connectButton}
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

        <Section icon={<Info />} title="How click-to-call works" description="What Growthdesk does when a rep calls through Twilio, and what remains your responsibility.">
          <Card className="p-4">
            <ul className="flex list-disc flex-col gap-1.5 pl-5 text-sm text-text-2">
              <li>A rep presses Call on one contact. Twilio rings the rep&apos;s own phone; when they answer, it dials the contact from your caller ID.</li>
              <li>There is no auto-dialer and no prerecorded messages: every call is one person calling one contact.</li>
              <li>Calls are not recorded.</li>
              <li>
                The contact&apos;s do-not-contact flag and the workspace&apos;s do-not-contact list are checked when the rep presses Call and again when they answer. A
                &ldquo;Do not call&rdquo; outcome adds the number to the list.
              </li>
              <li>Calling hours, national do-not-call registries (such as the US DNC list or the UK TPS) and caller ID rules are your responsibility.</li>
              <li>Twilio bills the calls to your account. Nothing needs setting up in Twilio&apos;s console: each call tells Twilio where to send its updates.</li>
            </ul>
          </Card>
        </Section>

        <AiCallingSettings />
      </div>

      {manage && <TwilioConnectModal open={connecting} onOpenChange={setConnecting} />}
    </RequirePermission>
  );
}
