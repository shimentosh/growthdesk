"use client";

import { useState } from "react";
import { ListOrdered, MailPlus, UserX } from "lucide-react";
import { WAITLIST_STATUSES, type WaitlistStatus } from "@growthdesk/shared";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, CardHeader } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { QueryState } from "@/components/ui/ErrorState";
import { Pagination } from "@/components/ui/Pagination";
import { SearchInput } from "@/components/ui/SearchInput";
import { SkeletonText } from "@/components/ui/Skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/Tabs";
import { cn } from "@/lib/cn";
import { useApiMutation, useApiQuery } from "@/lib/query";
import { useFormat } from "@/lib/session";
import { platformKey, table, TableFooter } from "@/features/common/platform";
import { InviteLinkDialog } from "./InviteLinkDialog";
import type { CreatedInvite, WaitlistEntry, WaitlistPage } from "./types";

const TAB_LABELS: Record<WaitlistStatus, string> = { pending: "Waiting", invited: "Invited", rejected: "Declined" };
const waitlistKey = platformKey("waitlist");

/** The waitlist (signupMode "waitlist"): oldest first, so people are invited in the order they joined. */
export function Waitlist({ active }: { active: boolean }) {
  const f = useFormat();
  const [status, setStatus] = useState<WaitlistStatus>("pending");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [created, setCreated] = useState<CreatedInvite | null>(null);
  const list = useApiQuery<WaitlistPage>(waitlistKey, "/admin/waitlist", { query: { status, q: q || undefined, page, pageSize }, keepPrevious: true });
  const invite = useApiMutation<CreatedInvite, WaitlistEntry>({
    path: (e) => `/admin/waitlist/${e.id}/invite`,
    body: () => ({}),
    invalidate: [waitlistKey, platformKey("signup-invites")],
    onSuccess: (r) => setCreated(r),
  });
  const reject = useApiMutation<WaitlistEntry, WaitlistEntry>({
    path: (e) => `/admin/waitlist/${e.id}/reject`,
    body: () => ({}),
    invalidate: [waitlistKey],
    success: (e) => `${e.email} declined`,
  });
  const counts = list.data?.counts;

  return (
    <Card>
      <CardHeader
        icon={<ListOrdered />}
        title="Waitlist"
        description={
          active
            ? "Visitors who asked to join. Inviting someone emails them a one-time sign-up link."
            : "Sign-ups are not in waitlist mode, so nobody new can join. People already listed can still be invited."
        }
      />
      <div className="flex flex-wrap items-end justify-between gap-3 px-4 pt-1">
        <Tabs
          value={status}
          onValueChange={(v) => {
            setStatus(v as WaitlistStatus);
            setPage(1);
          }}
        >
          <TabsList className="border-b-0">
            {WAITLIST_STATUSES.map((s) => (
              <TabsTrigger key={s} value={s}>
                {TAB_LABELS[s]}
                {counts && <span className="rounded-xs bg-mute-chip px-1.5 text-2xs text-text-2 tabular-nums">{counts[s]}</span>}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <SearchInput
          value={q}
          onChange={(v) => {
            setQ(v);
            setPage(1);
          }}
          placeholder="Search email or name…"
          size="sm"
          className="mb-2 sm:w-64"
        />
      </div>
      <div className="border-t border-line">
        <QueryState
          query={list}
          loading={<SkeletonText lines={4} className="p-4" />}
          isEmpty={(d) => d.total === 0}
          empty={<EmptyState compact icon={<ListOrdered />} title={q ? "Nobody matches" : status === "pending" ? "Nobody is waiting" : `Nobody ${TAB_LABELS[status].toLowerCase()}`} />}
        >
          {(data) => (
            <div className={cn(list.isPlaceholderData && "opacity-60")}>
              <div className={table.wrap}>
                <table className={table.table}>
                  <thead>
                    <tr>
                      <th className={table.th}>Person</th>
                      <th className={table.th}>Came from</th>
                      <th className={table.th}>Joined</th>
                      {status === "invited" && <th className={table.th}>Invited</th>}
                      <th className={cn(table.th, "text-right")}>
                        <span className="sr-only">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.items.map((e) => (
                      <tr key={e.id} className="hover:bg-hover">
                        <td className={cn(table.td, "max-w-72")}>
                          <div className="truncate font-medium">{e.name || e.email}</div>
                          {e.name && <div className="truncate text-xs text-text-3">{e.email}</div>}
                        </td>
                        <td className={table.td}>{e.utm.utm_source ? <Badge tone="mute">{e.utm.utm_source}</Badge> : <span className="text-text-3">—</span>}</td>
                        <td className={cn(table.td, "whitespace-nowrap text-text-2")}>{f.date(e.createdAt)}</td>
                        {status === "invited" && <td className={cn(table.td, "whitespace-nowrap text-text-2")}>{e.invitedAt ? f.relative(e.invitedAt) : "—"}</td>}
                        <td className={cn(table.td, "text-right whitespace-nowrap")}>
                          <div className="inline-flex gap-1.5">
                            <Button size="sm" icon={<MailPlus />} loading={invite.isPending && invite.variables?.id === e.id} onClick={() => invite.mutate(e)}>
                              {status === "invited" ? "Invite again" : "Invite"}
                            </Button>
                            {status !== "rejected" && (
                              <Button size="sm" variant="ghost" icon={<UserX />} loading={reject.isPending && reject.variables?.id === e.id} onClick={() => reject.mutate(e)}>
                                Decline
                              </Button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <TableFooter>
                <Pagination
                  page={data.page}
                  pageSize={data.pageSize}
                  total={data.total}
                  onPageChange={setPage}
                  onPageSizeChange={(s) => {
                    setPageSize(s);
                    setPage(1);
                  }}
                />
              </TableFooter>
            </div>
          )}
        </QueryState>
      </div>
      <InviteLinkDialog created={created} onClose={() => setCreated(null)} />
    </Card>
  );
}
