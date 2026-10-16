"use client";

import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { INTEGRATION_APPS } from "@growthdesk/shared";
import { Card } from "@/components/ui/Card";
import { EntityTile, type Entity } from "@/components/ui/icons";
import { PageHeader } from "@/components/ui/PageHeader";
import { RequirePermission } from "@/components/ui/RequirePermission";
import { UpgradePrompt } from "@/components/ui/UpgradePrompt";
import { AppConnection } from "@/components/integrations/AppConnection";
import { useApiQuery } from "@/lib/query";
import { useWorkspace } from "@/lib/session";
import type { ApiKey } from "@/lib/types/api-keys";

/** Everything else that connects to the workspace, each managed on its own settings page. */
const CONNECTIONS: { href: string; label: string; description: string; tile: Entity; permission?: string }[] = [
  { href: "/settings/mailboxes", label: "Mailboxes", description: "The mailboxes outreach sends from and replies arrive in.", tile: "mailboxes", permission: "integrations.read" },
  { href: "/settings/channels", label: "WhatsApp & Telegram", description: "Message leads and get their replies in the inbox.", tile: "channels", permission: "integrations.read" },
  { href: "/settings/live-chat", label: "Live chat", description: "A chat widget for your website, answered from the inbox.", tile: "liveChat", permission: "integrations.read" },
  { href: "/settings/calling", label: "Calling", description: "Phone numbers for calls and AI agents.", tile: "calling", permission: "integrations.read" },
  { href: "/settings/calendar", label: "Calendar", description: "Your own calendar, for meetings and booking pages.", tile: "meetings" },
  { href: "/settings/sending-domains", label: "Sending domains", description: "Domains marketing email is sent from.", tile: "sendingDomains", permission: "marketing.read" },
  { href: "/settings/mcp", label: "MCP / Claude", description: "Let Claude work in this workspace as you.", tile: "mcp" },
  { href: "/settings/webhooks", label: "Webhooks", description: "Tell your systems when things happen here.", tile: "webhooks", permission: "webhooks.manage" },
  { href: "/settings/api-keys", label: "API keys", description: "Any other system with an API: leads in, CRM records in and out.", tile: "apiKeys", permission: "apikeys.manage" },
];

export default function IntegrationsPage() {
  const ws = useWorkspace();
  const canManage = ws.can("apikeys.manage");
  const keys = useApiQuery<ApiKey[]>(ws.key("api-keys", "list"), canManage ? ws.path("/api-keys") : null);
  const connections = CONNECTIONS.filter((c) => !c.permission || ws.can(c.permission));

  return (
    <RequirePermission permission={["integrations.read", "apikeys.manage"]}>
      <PageHeader
        icon={<EntityTile of="integrations" />}
        title="Integrations"
        description="Connect Clientdesk and the other systems and channels this workspace works with."
      />

      <section className="mb-8 flex flex-col gap-3">
        <h2 className="text-sm font-semibold text-text-hi">Apps</h2>
        {canManage && !ws.hasFeature("apiAccess") && (
          <UpgradePrompt details={{ feature: "apiAccess", plan: ws.plan.name }} message="Apps connect through the API, which this plan doesn't include. Connected apps are refused until it does." />
        )}
        {!canManage && <p className="text-xs text-text-3">Ask someone who manages API keys to connect or disconnect apps.</p>}
        <div className="grid gap-3 md:grid-cols-2">
          {INTEGRATION_APPS.map((app) => (
            <AppConnection key={app} app={app} keys={canManage ? keys.data : undefined} canManage={canManage} />
          ))}
        </div>
      </section>

      {connections.length > 0 && (
        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold text-text-hi">Channels and tools</h2>
          <Card>
            <ul className="divide-y divide-line">
              {connections.map((c) => (
                <li key={c.href}>
                  <Link href={ws.href(c.href)} className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-ctl-hover">
                    <EntityTile of={c.tile} size="md" />
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium text-text-hi">{c.label}</span>
                      <span className="block text-xs text-text-3">{c.description}</span>
                    </span>
                    <ChevronRight aria-hidden className="size-4 shrink-0 text-text-3" />
                  </Link>
                </li>
              ))}
            </ul>
          </Card>
        </section>
      )}
    </RequirePermission>
  );
}
