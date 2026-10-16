"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { QueryState } from "@/components/ui/ErrorState";
import { EntityTile } from "@/components/ui/icons";
import { PageHeader } from "@/components/ui/PageHeader";
import { RequirePermission } from "@/components/ui/RequirePermission";
import { SkeletonText } from "@/components/ui/Skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/Tabs";
import { toast } from "@/components/ui/Toast";
import { DiscordDeliveries } from "@/components/discord/DiscordDeliveries";
import { DiscordRules } from "@/components/discord/DiscordRules";
import { DiscordServers } from "@/components/discord/DiscordServers";
import { DiscordTemplates } from "@/components/discord/DiscordTemplates";
import { useApiQuery, useInvalidate } from "@/lib/query";
import { useWorkspace } from "@/lib/session";
import type { DiscordOverview } from "@/lib/types/discord";

/**
 * Where Discord sends the browser back after adding the bot: the API's
 * callback redirects here with ?discord=connected&connection=<id> or
 * ?discordError=<message>. Says what happened once, then drops the parameters.
 */
function OAuthLanding() {
  const ws = useWorkspace();
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const invalidate = useInvalidate();
  const handled = useRef<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    const connected = params.get("discord") === "connected";
    const error = params.get("discordError");
    if (!connected && !error) return;
    const sig = params.toString();
    if (handled.current === sig) return;
    handled.current = sig;
    if (connected) {
      setFailure(null);
      toast.success("Discord server connected", {
        description: "Now choose the channels Growthdesk may post in.",
      });
      void invalidate(ws.key("discord"));
    } else if (error) {
      setFailure(error.slice(0, 300));
    }
    router.replace(pathname, { scroll: false });
  }, [params, router, pathname, invalidate, ws]);

  if (!failure) return null;
  return (
    <Callout
      tone="bad"
      title="Discord was not connected"
      className="mb-4"
      action={
        <Button size="sm" variant="ghost" onClick={() => setFailure(null)}>
          Dismiss
        </Button>
      }
    >
      {failure}
    </Callout>
  );
}

export default function DiscordSettingsPage() {
  const ws = useWorkspace();
  const overview = useApiQuery<DiscordOverview>(ws.key("discord", "overview"), ws.path("/discord"));

  return (
    <RequirePermission permission="integrations.read">
      <PageHeader icon={<EntityTile of="discord" />} title="Discord" description="Post deals won, new leads, replies and other events into your team's Discord channels." />
      <Suspense>
        <OAuthLanding />
      </Suspense>
      <QueryState query={overview} loading={<SkeletonText lines={8} />}>
        {(o) => (
          <>
            {!o.configured && o.connections.some((c) => c.status !== "disconnected") && (
              <Callout tone="warn" className="mb-4">
                No Discord bot is set up, so nothing can be posted. Set up your bot on the Servers &amp; channels tab.
              </Callout>
            )}
            <Tabs defaultValue={o.configured && o.connections.some((c) => c.status === "connected") ? "rules" : "servers"}>
              <TabsList>
                <TabsTrigger value="servers">Servers &amp; channels</TabsTrigger>
                <TabsTrigger value="rules">Notifications</TabsTrigger>
                <TabsTrigger value="templates">Templates</TabsTrigger>
                <TabsTrigger value="log">Delivery log</TabsTrigger>
              </TabsList>
              <TabsContent value="servers">
                <DiscordServers overview={o} />
              </TabsContent>
              <TabsContent value="rules">
                <DiscordRules overview={o} />
              </TabsContent>
              <TabsContent value="templates">
                <DiscordTemplates />
              </TabsContent>
              <TabsContent value="log">
                <DiscordDeliveries />
              </TabsContent>
            </Tabs>
          </>
        )}
      </QueryState>
    </RequirePermission>
  );
}
