"use client";

import { useState } from "react";
import { History, RefreshCw, RotateCcw } from "lucide-react";
import { DISCORD_DELIVERY_STATUSES, discordEventLabel, type DiscordDeliveryStatus } from "@growthdesk/shared";
import { Badge, type Tone } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Card } from "@/components/ui/Card";
import { Drawer } from "@/components/ui/Drawer";
import { EmptyState } from "@/components/ui/EmptyState";
import { QueryState } from "@/components/ui/ErrorState";
import { NativeSelect } from "@/components/ui/Input";
import { SkeletonText } from "@/components/ui/Skeleton";
import { useApiMutation, useApiQuery } from "@/lib/query";
import { useFormat, useWorkspace } from "@/lib/session";
import type { DiscordDelivery, DiscordDeliveryPage } from "@/lib/types/discord";
import { DiscordPreview } from "./DiscordPreview";

const STATUS: Record<DiscordDeliveryStatus, { label: string; tone: Tone }> = {
  pending: { label: "Waiting", tone: "info" },
  sent: { label: "Sent", tone: "ok" },
  failed: { label: "Failed", tone: "bad" },
  filtered: { label: "Filtered", tone: "mute" },
  skipped: { label: "Held back", tone: "warn" },
  canceled: { label: "Canceled", tone: "mute" },
};

const RETRYABLE = new Set<DiscordDeliveryStatus>(["failed", "skipped", "canceled"]);

function DeliveryDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const ws = useWorkspace();
  const f = useFormat();
  const canManage = ws.can("integrations.manage");
  const d = useApiQuery<DiscordDelivery>(ws.key("discord", "deliveries", id), ws.path(`/discord/deliveries/${id}`));
  const retry = useApiMutation<DiscordDelivery, void>({
    path: ws.path(`/discord/deliveries/${id}/retry`),
    invalidate: [ws.key("discord", "deliveries")],
    success: "Trying again",
  });
  return (
    <Drawer
      open
      onOpenChange={(o) => !o && onClose()}
      width="lg"
      title="Delivery"
      actions={
        canManage && d.data && RETRYABLE.has(d.data.status) ? (
          <Button size="sm" icon={<RotateCcw />} loading={retry.isPending} onClick={() => retry.mutate()}>
            Try again
          </Button>
        ) : undefined
      }
    >
      <QueryState query={d} loading={<SkeletonText lines={8} />}>
        {(x) => (
          <div className="flex flex-col gap-4">
            <dl className="grid grid-cols-[8rem_1fr] gap-x-3 gap-y-1.5 text-sm">
              <dt className="text-text-3">Status</dt>
              <dd>
                <Badge tone={STATUS[x.status].tone} dot>
                  {STATUS[x.status].label}
                </Badge>
              </dd>
              <dt className="text-text-3">Event</dt>
              <dd className="text-text-hi">
                {discordEventLabel(x.eventType)} <code className="font-mono text-xs text-text-3">{x.eventType}</code>
              </dd>
              <dt className="text-text-3">Rule</dt>
              <dd className="text-text-hi">{x.ruleName || "—"}</dd>
              <dt className="text-text-3">Channel</dt>
              <dd className="text-text-hi">
                #{x.channelName}
                {x.guildName && <span className="text-text-3"> · {x.guildName}</span>}
              </dd>
              <dt className="text-text-3">Created</dt>
              <dd className="text-text-hi">{f.dateTime(x.createdAt)}</dd>
              {x.sentAt && (
                <>
                  <dt className="text-text-3">Posted</dt>
                  <dd className="text-text-hi">{f.dateTime(x.sentAt)}</dd>
                </>
              )}
              <dt className="text-text-3">Attempts</dt>
              <dd className="text-text-hi">
                {x.attempts}
                {x.nextAttemptAt && x.status === "pending" && <span className="text-text-3"> · next {f.relative(x.nextAttemptAt)}</span>}
              </dd>
            </dl>
            {x.error && (
              <Callout tone={x.status === "failed" ? "bad" : "info"}>
                {x.error}
                {x.responseStatus ? ` (HTTP ${x.responseStatus})` : ""}
              </Callout>
            )}
            {x.message && <DiscordPreview message={x.message} />}
          </div>
        )}
      </QueryState>
    </Drawer>
  );
}

/** The Delivery log tab: every message Growthdesk tried to post, newest first. */
export function DiscordDeliveries() {
  const ws = useWorkspace();
  const f = useFormat();
  const canManage = ws.can("integrations.manage");
  const [status, setStatus] = useState<DiscordDeliveryStatus | "">("");
  const [pages, setPages] = useState<string[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const cursor = pages.at(-1);
  const list = useApiQuery<DiscordDeliveryPage>(ws.key("discord", "deliveries", "list", status, cursor ?? ""), ws.path("/discord/deliveries"), {
    query: { status: status || undefined, cursor, limit: 50 },
    keepPrevious: true,
  });
  const retryFailed = useApiMutation<{ retried: number }, void>({
    path: ws.path("/discord/deliveries/retry-failed"),
    invalidate: [ws.key("discord", "deliveries")],
    success: (r) => (r.retried ? `Retrying ${r.retried} ${r.retried === 1 ? "delivery" : "deliveries"}` : "Nothing to retry"),
  });
  const counts = list.data?.last24h ?? {};

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="w-44">
          <NativeSelect
            aria-label="Status"
            value={status}
            onChange={(e) => {
              setStatus(e.target.value as DiscordDeliveryStatus | "");
              setPages([]);
            }}
            options={[
              { value: "", label: "All statuses" },
              ...DISCORD_DELIVERY_STATUSES.map((s) => ({
                value: s,
                label: STATUS[s].label,
              })),
            ]}
          />
        </div>
        <span className="text-xs text-text-3">
          Last 24 h: {counts.sent ?? 0} sent · {counts.failed ?? 0} failed · {counts.pending ?? 0} waiting
        </span>
        <div className="ml-auto flex gap-2">
          <Button size="sm" variant="ghost" icon={<RefreshCw />} loading={list.isFetching} onClick={() => list.refetch()}>
            Refresh
          </Button>
          {canManage && Boolean(counts.failed) && (
            <Button size="sm" icon={<RotateCcw />} loading={retryFailed.isPending} onClick={() => retryFailed.mutate()}>
              Retry failed
            </Button>
          )}
        </div>
      </div>

      <QueryState
        query={list}
        loading={<SkeletonText lines={6} />}
        isEmpty={(d) => d.items.length === 0}
        empty={
          <Card>
            <EmptyState icon={<History />} tint="gray" title="Nothing posted yet" description="Each message a rule or a test sends shows up here, with why it failed if it did." />
          </Card>
        }
      >
        {(d) => (
          <Card>
            <ul className="divide-y divide-line">
              {d.items.map((x) => (
                <li key={x.id}>
                  <button type="button" onClick={() => setOpen(x.id)} className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-ctl-hover">
                    <Badge tone={STATUS[x.status].tone} dot className="w-24 shrink-0">
                      {STATUS[x.status].label}
                    </Badge>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm text-text-hi">
                        {discordEventLabel(x.eventType)} → #{x.channelName}
                        {x.test && (
                          <Badge quiet className="ml-2">
                            Test
                          </Badge>
                        )}
                      </span>
                      <span className="block truncate text-xs text-text-3">{x.error || x.ruleName || x.guildName}</span>
                    </span>
                    <span className="shrink-0 text-xs text-text-3">{f.relative(x.createdAt)}</span>
                  </button>
                </li>
              ))}
            </ul>
            {(pages.length > 0 || d.nextCursor) && (
              <div className="flex justify-between border-t border-line px-4 py-2">
                <Button size="sm" variant="ghost" disabled={!pages.length} onClick={() => setPages((p) => p.slice(0, -1))}>
                  Newer
                </Button>
                <Button size="sm" variant="ghost" disabled={!d.nextCursor} onClick={() => d.nextCursor && setPages((p) => [...p, d.nextCursor!])}>
                  Older
                </Button>
              </div>
            )}
          </Card>
        )}
      </QueryState>

      {open && <DeliveryDrawer id={open} onClose={() => setOpen(null)} />}
    </div>
  );
}
