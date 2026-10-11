"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Plus } from "lucide-react";
import { PLATFORM_BROADCAST_STATUSES, type PlatformBroadcastStatus } from "@growthdesk/shared";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Modal } from "@/components/ui/Dialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { QueryState } from "@/components/ui/ErrorState";
import { Field, FormError } from "@/components/ui/Field";
import { Input, NativeSelect } from "@/components/ui/Input";
import { Page, PageHeader } from "@/components/ui/PageHeader";
import { SkeletonText } from "@/components/ui/Skeleton";
import { cn } from "@/lib/cn";
import { formatNumber } from "@/lib/format";
import { useApiMutation, useApiQuery } from "@/lib/query";
import { useFormat } from "@/lib/session";
import { FilterBar, platformKey, table, usePlatform } from "@/features/common/platform";
import { BroadcastStatusBadge, GrowthTile, growthEmpty, ProgressBar } from "./common";
import type { Audience, BroadcastDetail, BroadcastRow } from "./types";

/*
 * /growth/broadcasts — one-off product emails to an audience of our own
 * users. Drafts are edited on /growth/broadcasts/[id]; the list shows where
 * each one is and, while sending, how far it got.
 */

const STATUS_LABEL: Record<PlatformBroadcastStatus, string> = { draft: "Draft", scheduled: "Scheduled", sending: "Sending", sent: "Sent", canceled: "Canceled", failed: "Failed" };

function NewBroadcast({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [audienceId, setAudienceId] = useState("");
  const audiences = useApiQuery<Audience[]>(platformKey("growth", "audiences"), "/admin/growth/audiences", { enabled: open });
  const create = useApiMutation<BroadcastDetail, void>({
    path: "/admin/growth/broadcasts",
    body: () => ({ name, audienceId: audienceId || null }),
    invalidate: [platformKey("growth", "broadcasts")],
    errorToast: false,
    onSuccess: (b) => router.push(`/growth/broadcasts/${b.id}`),
  });
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      icon={<GrowthTile of="broadcasts" size="md" />}
      title="New broadcast"
      description="Starts as a draft. You can test it, preview it and choose when it goes out."
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" loading={create.isPending} disabled={!name.trim()} onClick={() => create.mutate()}>
            Create draft
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) create.mutate();
        }}
      >
        <Field label="Name" required hint="For you and the team; recipients never see it.">
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={160} placeholder="e.g. October product update" autoFocus />
        </Field>
        <Field label="Audience" hint="You can change it until the broadcast is scheduled.">
          <NativeSelect
            value={audienceId}
            onChange={(e) => setAudienceId(e.target.value)}
            placeholder={audiences.isPending ? "Loading…" : "Choose later"}
            options={(audiences.data ?? []).map((a) => ({ value: a.id, label: `${a.name} · ${formatNumber(a.count)}` }))}
          />
        </Field>
        <FormError error={create.error?.message ?? null} />
      </form>
    </Modal>
  );
}

/** /growth/broadcasts */
export function Broadcasts() {
  const f = useFormat();
  const { canChange } = usePlatform();
  const [status, setStatus] = useState<PlatformBroadcastStatus | "">("");
  const [creating, setCreating] = useState(false);
  // While something is scheduled or going out, keep the progress moving.
  const [poll, setPoll] = useState(false);
  const list = useApiQuery<BroadcastRow[]>(platformKey("growth", "broadcasts"), "/admin/growth/broadcasts", {
    query: { status: status || undefined },
    keepPrevious: true,
    refetchInterval: poll ? 5_000 : false,
  });
  useEffect(() => setPoll(Boolean(list.data?.some((b) => b.status === "sending" || b.status === "scheduled"))), [list.data]);

  const when = (b: BroadcastRow) => {
    if (b.status === "scheduled" && b.scheduledAt) return `Goes out ${f.dateTime(b.scheduledAt)}`;
    if (b.status === "sending" && b.startedAt) return `Started ${f.smart(b.startedAt)}`;
    if (b.finishedAt) return `${STATUS_LABEL[b.status]} ${f.smart(b.finishedAt)}`;
    return `Edited ${f.smart(b.updatedAt)}`;
  };

  return (
    <Page>
      <PageHeader
        icon={<GrowthTile of="broadcasts" />}
        title="Broadcasts"
        description="One-off product emails to your own users — launches, updates, tips. Sent from the marketing sender with an unsubscribe link and one-click unsubscribe headers."
        actions={
          canChange && (
            <Button variant="primary" icon={<Plus />} onClick={() => setCreating(true)}>
              New broadcast
            </Button>
          )
        }
      />
      <FilterBar>
        <NativeSelect
          aria-label="Status"
          value={status}
          onChange={(e) => setStatus(e.target.value as PlatformBroadcastStatus | "")}
          placeholder="Any status"
          options={PLATFORM_BROADCAST_STATUSES.map((s) => ({ value: s, label: STATUS_LABEL[s] }))}
          className="w-40"
        />
      </FilterBar>
      <QueryState
        query={list}
        loading={<SkeletonText lines={6} />}
        isEmpty={(d) => d.length === 0}
        empty={
          <Card>
            <EmptyState
              {...growthEmpty("broadcasts")}
              title={status ? "No broadcasts with this status" : "No broadcasts yet"}
              description={status ? undefined : "Write one email, pick an audience, send a test to yourself, then schedule it."}
              action={
                canChange &&
                !status && (
                  <Button variant="primary" icon={<Plus />} onClick={() => setCreating(true)}>
                    New broadcast
                  </Button>
                )
              }
            />
          </Card>
        }
      >
        {(rows) => (
          <Card className={cn("overflow-hidden", list.isPlaceholderData && "opacity-60")}>
            <div className={table.wrap}>
              <table className={table.table}>
                <thead>
                  <tr>
                    <th className={table.th}>Broadcast</th>
                    <th className={table.th}>Status</th>
                    <th className={cn(table.th, "hidden md:table-cell")}>Audience</th>
                    <th className={cn(table.th, "hidden sm:table-cell")}>Progress</th>
                    <th className={cn(table.th, "hidden lg:table-cell")}>When</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((b) => {
                    const p = b.progress;
                    const done = p.sent + p.failed + p.skipped + p.canceled;
                    return (
                      <tr key={b.id} className="hover:bg-hover">
                        <td className={table.td}>
                          <Link href={`/growth/broadcasts/${b.id}`} className="block min-w-0">
                            <div className="truncate font-medium text-text-hi hover:underline">{b.name}</div>
                            <div className="max-w-[48ch] truncate text-xs text-text-3">{b.subject || "No subject yet"}</div>
                          </Link>
                        </td>
                        <td className={table.td}>
                          <BroadcastStatusBadge status={b.status} />
                        </td>
                        <td className={cn(table.td, "hidden text-text-2 md:table-cell")}>{b.audience?.name ?? <span className="text-text-3">—</span>}</td>
                        <td className={cn(table.td, "hidden w-48 sm:table-cell")}>
                          {p.total > 0 ? (
                            <div className="flex flex-col gap-1">
                              <ProgressBar progress={p} />
                              <span className="text-2xs text-text-3 tabular-nums">
                                {formatNumber(p.sent)} sent of {formatNumber(p.total)}
                                {p.pending > 0 && b.status === "sending" ? ` · ${formatNumber(p.total - done)} to go` : ""}
                              </span>
                            </div>
                          ) : (
                            <span className="text-text-3">—</span>
                          )}
                        </td>
                        <td className={cn(table.td, "hidden whitespace-nowrap text-text-3 lg:table-cell")}>{when(b)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>
        )}
      </QueryState>
      {creating && <NewBroadcast open onOpenChange={(v) => !v && setCreating(false)} />}
    </Page>
  );
}
