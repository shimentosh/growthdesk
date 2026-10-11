"use client";

import { ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { useMarketingSetup } from "@/components/marketing/common";
import { useWorkspace } from "@/lib/session";

/** A quiet nudge when nothing can be sent yet: no connected email service, or no verified sending domain. */
export function SendingSetupBanner({ className }: { className?: string }) {
  const ws = useWorkspace();
  const setup = useMarketingSetup();
  if (!setup.data) return null;
  const { esp, domains } = setup.data;
  const connected = esp?.status === "connected";
  const verified = domains.some((d) => d.status === "verified" && !d.pausedAt);
  if (connected && verified) return null;
  const title = !connected ? "Connect an email service to start sending" : "Verify a sending domain to start sending";
  const body = !connected
    ? "Campaigns go out through your own email service (Amazon SES or any SMTP relay). You can write and test drafts in the meantime."
    : domains.some((d) => d.pausedAt)
      ? "Every verified domain is paused. Review it before sending more."
      : "Add the domain your emails come from and its DNS records, so inboxes trust them.";
  return (
    <Callout
      tone="info"
      title={title}
      className={className}
      action={
        <Button size="sm" iconRight={<ArrowRight />} href={ws.href("/settings/sending-domains")}>
          Sending domains
        </Button>
      }
    >
      {body}
    </Callout>
  );
}
