"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Users } from "lucide-react";
import { MARKETING_SEND_STATUSES, type MarketingSendStatus } from "@growthdesk/shared";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { Pagination } from "@/components/ui/Pagination";
import { Skeleton } from "@/components/ui/Skeleton";
import { SendStatusBadge, useMarketing } from "@/components/marketing/common";
import { cn } from "@/lib/cn";
import { useApiQuery } from "@/lib/query";
import { useFormat, useWorkspace } from "@/lib/session";
import type { CampaignRecipient, MarketingCampaign, Paged } from "@/lib/types/marketing";

const TH = "h-9 px-3 text-left text-xs font-medium whitespace-nowrap text-text-3";
const TD = "px-3 py-2 align-middle";
const STATUS_LABEL: Record<MarketingSendStatus, string> = { queued: "Queued", sent: "Sent", failed: "Failed", skipped: "Skipped", bounced: "Bounced", complained: "Complained" };

/** Who the campaign went to and what happened, page by page (GET recipients). */
export function RecipientsTable({ campaign }: { campaign: MarketingCampaign }) {
  const ws = useWorkspace();
  const mk = useMarketing();
  const f = useFormat();
  const [status, setStatus] = useState<MarketingSendStatus | "">("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const live = campaign.status === "sending";
  const q = useApiQuery<Paged<CampaignRecipient>>(mk.key("campaigns", campaign.id, "recipients"), mk.path(`/campaigns/${campaign.id}/recipients`), {
    query: { page, pageSize, status: status || undefined },
    keepPrevious: true,
    refetchInterval: live ? 5_000 : false,
  });
  const { refetch } = q;
  // Catch the last sends when the campaign finishes, pauses or is canceled.
  useEffect(() => {
    void refetch();
  }, [campaign.status, refetch]);
  const rows = q.data?.items ?? [];
  const dash = <span className="text-text-3">—</span>;
  const when = (v: string | null) => (v ? <span title={f.dateTime(v)}>{f.smart(v)}</span> : dash);

  return (
    <div className="flex flex-col gap-3">
      <div role="tablist" aria-label="Status" className="-mx-1 flex gap-1 overflow-x-auto px-1">
        {(["", ...MARKETING_SEND_STATUSES] as const).map((s) => (
          <button
            key={s || "all"}
            type="button"
            role="tab"
            aria-selected={status === s}
            onClick={() => {
              setStatus(s);
              setPage(1);
            }}
            className={cn(
              "h-7 shrink-0 rounded-sm px-2.5 text-xs font-medium whitespace-nowrap",
              status === s ? "bg-accent-soft text-accent-ink" : "text-text-2 hover:bg-hover hover:text-text",
            )}
          >
            {s ? STATUS_LABEL[s] : "All"}
          </button>
        ))}
      </div>
      <Card className="overflow-hidden">
        {q.isPending ? (
          <div className="flex flex-col gap-2 p-4" aria-busy>
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-9" />
            ))}
          </div>
        ) : q.isError && !q.data ? (
          <ErrorState error={q.error} onRetry={() => void q.refetch()} />
        ) : !rows.length ? (
          <EmptyState
            compact
            icon={<Users />}
            title={status ? `No ${STATUS_LABEL[status].toLowerCase()} recipients` : "No recipients yet"}
            description={status ? undefined : campaign.status === "scheduled" ? "Recipients are chosen when sending starts." : "Nobody was sent this campaign."}
          />
        ) : (
          <div className={cn("overflow-x-auto transition-opacity", q.isFetching && q.isPlaceholderData && "opacity-60")}>
            <table className="w-full min-w-[860px] border-collapse text-sm">
              <thead className="border-b border-line bg-s-2">
                <tr>
                  <th scope="col" className={TH}>
                    Recipient
                  </th>
                  <th scope="col" className={TH}>
                    Status
                  </th>
                  <th scope="col" className={TH}>
                    Sent
                  </th>
                  {campaign.trackOpens && (
                    <th scope="col" className={TH}>
                      Opened
                    </th>
                  )}
                  {campaign.trackClicks && (
                    <th scope="col" className={TH}>
                      Clicked
                    </th>
                  )}
                  <th scope="col" className={TH}>
                    Notes
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {rows.map((r) => {
                  const note = r.complainedAt
                    ? `Marked as spam ${f.smart(r.complainedAt)}`
                    : r.bouncedAt
                      ? `Bounced ${f.smart(r.bouncedAt)}${r.error ? `: ${r.error}` : ""}`
                      : r.unsubscribedAt
                        ? `Unsubscribed ${f.smart(r.unsubscribedAt)}`
                        : r.error;
                  return (
                    <tr key={r.id}>
                      <td className={cn(TD, "max-w-72")}>
                        {r.contact ? (
                          <Link href={ws.href(`/contacts/${r.contact.id}`)} className="group block min-w-0">
                            <span className="block truncate font-medium text-text group-hover:text-accent-hi">{r.contact.fullName || r.email}</span>
                            <span className="block truncate text-xs text-text-3">{r.email}</span>
                          </Link>
                        ) : (
                          <span className="block truncate text-text">{r.email}</span>
                        )}
                      </td>
                      <td className={cn(TD, "whitespace-nowrap")}>
                        <SendStatusBadge status={r.status} />
                      </td>
                      <td className={cn(TD, "whitespace-nowrap text-text-2")}>{when(r.sentAt)}</td>
                      {campaign.trackOpens && <td className={cn(TD, "whitespace-nowrap text-text-2")}>{when(r.openedAt)}</td>}
                      {campaign.trackClicks && <td className={cn(TD, "whitespace-nowrap text-text-2")}>{when(r.clickedAt)}</td>}
                      <td className={cn(TD, "max-w-80 truncate", r.status === "failed" || r.complainedAt ? "text-bad-ink" : "text-text-2")} title={note || undefined}>
                        {note || dash}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {q.data && q.data.total > 0 && (
          <div className="border-t border-line px-3 py-2">
            <Pagination
              page={page}
              pageSize={pageSize}
              total={q.data.total}
              onPageChange={setPage}
              onPageSizeChange={(n) => {
                setPageSize(n);
                setPage(1);
              }}
            />
          </div>
        )}
      </Card>
    </div>
  );
}
