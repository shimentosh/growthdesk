"use client";

import { useState } from "react";
import { ShieldBan, ShieldCheck } from "lucide-react";
import { labelOf, type PlatformSubscriberTab } from "@growthdesk/shared";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { ConfirmDialog } from "@/components/ui/Dialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { QueryState } from "@/components/ui/ErrorState";
import { Page, PageHeader } from "@/components/ui/PageHeader";
import { Pagination } from "@/components/ui/Pagination";
import { SearchInput } from "@/components/ui/SearchInput";
import { SkeletonText } from "@/components/ui/Skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/Tabs";
import { cn } from "@/lib/cn";
import { formatNumber } from "@/lib/format";
import { useApiMutation, useApiQuery } from "@/lib/query";
import { useFormat } from "@/lib/session";
import { FilterBar, PersonCell, platformKey, table, TableFooter, usePlatform } from "@/features/common/platform";
import { GrowthTile, growthEmpty } from "./common";
import type { Subscriber, SubscribersPage } from "./types";

/*
 * /growth/subscribers — who receives product emails. Consented: opted in and
 * reachable. Unsubscribed: opted out (preferences page, one-click, account
 * settings). Suppressed: a hard bounce, a spam complaint, Resend's own
 * suppression, or an admin — never mailed again until unsuppressed.
 */

const TABS: { value: PlatformSubscriberTab; label: string; empty: string }[] = [
  { value: "consented", label: "Consented", empty: "Nobody has opted in to product emails yet. New sign-ups can tick the box on the sign-up form; existing users opt in from their account page." },
  { value: "unsubscribed", label: "Unsubscribed", empty: "Nobody has unsubscribed." },
  { value: "suppressed", label: "Suppressed", empty: "No suppressed addresses — no hard bounces or complaints so far." },
];

const SOURCE: Record<string, string> = {
  signup_form: "Sign-up form",
  account_settings: "Account settings",
  preference_page: "Email preferences page",
  admin: "Admin",
};

const REASON: Record<string, string> = {
  hard_bounce: "Hard bounce",
  complaint: "Spam complaint",
  provider_suppressed: "Suppressed by Resend",
  admin: "Suppressed by an admin",
};

/** /growth/subscribers */
export function Subscribers() {
  const f = useFormat();
  const { canChange } = usePlatform();
  const [tab, setTab] = useState<PlatformSubscriberTab>("consented");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [acting, setActing] = useState<{ s: Subscriber; action: "suppress" | "unsuppress" } | null>(null);
  const list = useApiQuery<SubscribersPage>(platformKey("growth", "subscribers"), "/admin/growth/subscribers", { query: { tab, q: q || undefined, page, pageSize }, keepPrevious: true });
  const act = useApiMutation<unknown, { userId: string; action: "suppress" | "unsuppress" }>({
    path: ({ userId, action }) => `/admin/growth/subscribers/${userId}/${action}`,
    body: () => ({}),
    invalidate: [platformKey("growth")],
    success: (_d, v) => (v.action === "suppress" ? "Suppressed — no more product emails" : "Unsuppressed"),
    errorToast: false,
  });
  const counts = list.data?.counts;
  const current = TABS.find((t) => t.value === tab)!;

  return (
    <Page>
      <PageHeader
        icon={<GrowthTile of="subscribers" />}
        title="Subscribers"
        description="Consent to product emails for every user. Existing accounts start opted out; only people who opted in are ever in an audience. Account emails are not affected by any of this."
      />
      <Tabs
        value={tab}
        onValueChange={(v) => {
          setTab(v as PlatformSubscriberTab);
          setPage(1);
        }}
      >
        <TabsList className="mb-4">
          {TABS.map((t) => (
            <TabsTrigger key={t.value} value={t.value}>
              {t.label}
              {counts && <span className="rounded-xs bg-mute-chip px-1.5 text-2xs text-text-2 tabular-nums">{formatNumber(counts[t.value])}</span>}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      <FilterBar>
        <SearchInput
          value={q}
          onChange={(v) => {
            setQ(v);
            setPage(1);
          }}
          placeholder="Search name, email or user id…"
          className="sm:w-72"
        />
      </FilterBar>
      <QueryState
        query={list}
        loading={<SkeletonText lines={8} />}
        isEmpty={(d) => d.total === 0}
        empty={
          <Card>
            <EmptyState {...growthEmpty("subscribers")} title={q ? "Nobody matches" : `No one ${current.label.toLowerCase()}`} description={q ? "Try another search." : current.empty} />
          </Card>
        }
      >
        {(data) => (
          <Card className={cn("overflow-hidden", list.isPlaceholderData && "opacity-60")}>
            <div className={table.wrap}>
              <table className={table.table}>
                <thead>
                  <tr>
                    <th className={table.th}>Person</th>
                    <th className={table.th}>{tab === "consented" ? "Opted in" : tab === "unsubscribed" ? "Unsubscribed" : "Suppressed"}</th>
                    <th className={cn(table.th, "hidden md:table-cell")}>{tab === "suppressed" ? "Reason" : "Source"}</th>
                    <th className={cn(table.th, "hidden lg:table-cell")}>Account</th>
                    {canChange && (
                      <th className={table.th}>
                        <span className="sr-only">Actions</span>
                      </th>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((s) => (
                    <tr key={s.userId} className="hover:bg-hover">
                      <td className={cn(table.td, "max-w-[18rem]")}>
                        <PersonCell person={{ id: s.userId, email: s.email, name: s.name }} />
                      </td>
                      <td className={cn(table.td, "whitespace-nowrap text-text-2")}>{f.date(tab === "consented" ? s.consentAt : tab === "unsubscribed" ? s.unsubscribedAt : s.suppressedAt, "medium") || "—"}</td>
                      <td className={cn(table.td, "hidden text-text-2 md:table-cell")}>
                        {tab === "suppressed" ? REASON[s.suppressionReason] ?? (s.suppressionReason ? labelOf(s.suppressionReason) : "—") : SOURCE[s.consentSource] ?? (s.consentSource ? labelOf(s.consentSource) : "—")}
                      </td>
                      <td className={cn(table.td, "hidden lg:table-cell")}>
                        <span className="flex flex-wrap gap-1">
                          {!s.emailVerified && (
                            <Badge tone="warn" quiet>
                              Unverified
                            </Badge>
                          )}
                          {s.suspended && (
                            <Badge tone="bad" quiet>
                              Suspended
                            </Badge>
                          )}
                          {s.emailVerified && !s.suspended && <span className="text-text-3">—</span>}
                        </span>
                      </td>
                      {canChange && (
                        <td className={cn(table.td, "w-0 whitespace-nowrap text-right")}>
                          {s.suppressedAt ? (
                            <Button size="sm" variant="ghost" icon={<ShieldCheck />} onClick={() => setActing({ s, action: "unsuppress" })}>
                              Unsuppress
                            </Button>
                          ) : (
                            <Button size="sm" variant="ghost" icon={<ShieldBan />} onClick={() => setActing({ s, action: "suppress" })}>
                              Suppress
                            </Button>
                          )}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <TableFooter>
              <Pagination page={data.page} pageSize={data.pageSize} total={data.total} onPageChange={setPage} onPageSizeChange={(n) => (setPageSize(n), setPage(1))} />
            </TableFooter>
          </Card>
        )}
      </QueryState>
      <ConfirmDialog
        open={acting !== null}
        onOpenChange={(v) => !v && setActing(null)}
        tone={acting?.action === "suppress" ? "danger" : "default"}
        title={acting?.action === "suppress" ? `Suppress ${acting?.s.email}?` : `Unsuppress ${acting?.s.email ?? ""}?`}
        description={
          acting?.action === "suppress"
            ? "No broadcast or onboarding email will reach this address, and their onboarding sequences stop. Account emails still go out."
            : acting?.s.suppressionReason === "complaint"
              ? "This person reported a product email as spam. Only unsuppress if they asked you to — mailing them again can hurt deliverability."
              : "They can receive product emails again if they have opted in."
        }
        confirmLabel={acting?.action === "suppress" ? "Suppress" : "Unsuppress"}
        onConfirm={() => act.mutateAsync({ userId: acting!.s.userId, action: acting!.action })}
      />
    </Page>
  );
}
