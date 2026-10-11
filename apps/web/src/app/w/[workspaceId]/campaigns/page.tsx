"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState, type ReactNode } from "react";
import { Plus, SearchX, X } from "lucide-react";
import { CAMPAIGN_STATUSES, labelOf, type CampaignStatus } from "@growthdesk/shared";
import { StatusBadge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { ENTITY, EntityTile } from "@/components/ui/icons";
import { Page, PageHeader } from "@/components/ui/PageHeader";
import { Pagination } from "@/components/ui/Pagination";
import { RequirePermission } from "@/components/ui/RequirePermission";
import { SearchInput } from "@/components/ui/SearchInput";
import { LoadingBlock, Skeleton } from "@/components/ui/Skeleton";
import { NewCampaignModal } from "@/components/campaigns/NewCampaignModal";
import { cn } from "@/lib/cn";
import { formatNumber } from "@/lib/format";
import { useApiQuery } from "@/lib/query";
import { useFormat, useWorkspace } from "@/lib/session";
import type { Paged } from "@/lib/types";
import type { Campaign } from "@/lib/types/campaigns";

export default function CampaignsPage() {
  return (
    <Page>
      <RequirePermission permission="campaigns.read">
        <Suspense fallback={<LoadingBlock />}>
          <Campaigns />
        </Suspense>
      </RequirePermission>
    </Page>
  );
}

const PAGE_SIZES = [25, 50, 100];
const CampaignGlyph = ENTITY.campaigns.icon;
const TH = "h-9 px-3 text-left text-xs font-medium whitespace-nowrap text-text-3";
const TD = "px-3 py-2 align-middle";

/** Status, search and page live in the URL (?status=&q=&page=&pageSize=). */
function useListParams() {
  const sp = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const page = Number(sp.get("page"));
  const pageSize = Number(sp.get("pageSize"));
  const status = sp.get("status") ?? "";
  const state = {
    q: sp.get("q") ?? "",
    status: ((CAMPAIGN_STATUSES as readonly string[]).includes(status) ? status : "") as CampaignStatus | "",
    page: Number.isInteger(page) && page > 0 ? page : 1,
    pageSize: PAGE_SIZES.includes(pageSize) ? pageSize : 50,
  };
  const update = (patch: Partial<typeof state>) => {
    const next = { ...state, ...patch };
    if (!("page" in patch)) next.page = 1;
    const p = new URLSearchParams();
    if (next.q.trim()) p.set("q", next.q.trim());
    if (next.status) p.set("status", next.status);
    if (next.page > 1) p.set("page", String(next.page));
    if (next.pageSize !== 50) p.set("pageSize", String(next.pageSize));
    const qs = p.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };
  return { state, update };
}

const Num = ({ n }: { n: number }) => <span className={cn("tabular-nums", n ? "text-text" : "text-text-3")}>{formatNumber(n)}</span>;

function Campaigns() {
  const ws = useWorkspace();
  const f = useFormat();
  const { state, update } = useListParams();
  const [creating, setCreating] = useState(false);
  const canWrite = ws.can("campaigns.write");
  const list = useApiQuery<Paged<Campaign>>(ws.key("campaigns", "list"), ws.path("/campaigns"), {
    query: { q: state.q || undefined, status: state.status || undefined, page: state.page, pageSize: state.pageSize },
    keepPrevious: true,
  });
  const rows = list.data?.items ?? [];
  const filtered = Boolean(state.q || state.status);
  const create = canWrite ? (
    <Button variant="primary" icon={<Plus />} onClick={() => setCreating(true)}>
      New campaign
    </Button>
  ) : undefined;

  let body: ReactNode;
  if (list.isPending) {
    body = (
      <div className="flex flex-col gap-2 p-4" aria-busy>
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="h-9" />
        ))}
      </div>
    );
  } else if (list.isError && !list.data) {
    body = <ErrorState error={list.error} onRetry={() => void list.refetch()} />;
  } else if (!rows.length) {
    body = filtered ? (
      <EmptyState
        icon={<SearchX />}
        title="No campaigns match"
        description="Search looks at the campaign name."
        action={
          <Button size="sm" icon={<X />} onClick={() => update({ q: "", status: "" })}>
            Clear filters
          </Button>
        }
      />
    ) : (
      <EmptyState
        icon={<CampaignGlyph />}
        tint={ENTITY.campaigns.tint}
        title="No campaigns yet"
        description={
          canWrite
            ? "A campaign sends a sequence of steps to an audience from your mailboxes, inside a send window, and stops for anyone who replies."
            : "Nobody has created a campaign yet."
        }
        action={create}
      />
    );
  } else {
    body = (
      <div className={cn("overflow-x-auto transition-opacity", list.isFetching && list.isPlaceholderData && "opacity-60")}>
        <table className="w-full min-w-[1040px] border-collapse text-sm">
          <thead className="border-b border-line bg-s-2">
            <tr>
              <th scope="col" className={TH}>
                Name
              </th>
              <th scope="col" className={TH}>
                Status
              </th>
              <th scope="col" className={TH}>
                Audience
              </th>
              <th scope="col" className={cn(TH, "text-right")}>
                Enrolled
              </th>
              <th scope="col" className={cn(TH, "text-right")}>
                Active
              </th>
              <th scope="col" className={cn(TH, "text-right")}>
                Completed
              </th>
              <th scope="col" className={cn(TH, "text-right")}>
                Replied
              </th>
              <th scope="col" className={cn(TH, "text-right")}>
                Bounced
              </th>
              <th scope="col" className={TH}>
                Mailboxes
              </th>
              <th scope="col" className={TH}>
                Owner
              </th>
              <th scope="col" className={TH}>
                Updated
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows.map((c) => (
              <tr key={c.id} className="hover:bg-hover">
                <td className={cn(TD, "max-w-64")}>
                  <Link href={ws.href(`/campaigns/${c.id}`)} className="group block min-w-0">
                    <span className="block truncate font-medium text-text group-hover:text-accent-hi">{c.name}</span>
                    <span className="block truncate text-xs text-text-3">
                      {c.stepCount} step{c.stepCount === 1 ? "" : "s"}
                      {c.status === "scheduled" && c.startAt ? ` · starts ${f.smart(c.startAt)}` : ""}
                    </span>
                  </Link>
                </td>
                <td className={cn(TD, "whitespace-nowrap")}>
                  <StatusBadge value={c.status} />
                </td>
                <td className={cn(TD, "max-w-56 truncate text-text-2")} title={c.audienceDescription}>
                  {c.audienceDescription}
                </td>
                <td className={cn(TD, "text-right")}>
                  <Num n={c.stats.enrolled} />
                </td>
                <td className={cn(TD, "text-right")}>
                  <Num n={c.enrollments.active} />
                </td>
                <td className={cn(TD, "text-right")}>
                  <Num n={c.enrollments.completed} />
                </td>
                <td className={cn(TD, "text-right")}>
                  <Num n={c.stats.replied} />
                </td>
                <td className={cn(TD, "text-right")}>
                  <Num n={c.stats.bounced} />
                </td>
                <td className={cn(TD, "max-w-48 truncate text-text-2")} title={c.mailboxes.map((m) => m.email).join(", ")}>
                  {c.mailboxes.length === 0 ? (
                    <span className="text-text-3">Any connected</span>
                  ) : c.mailboxes.length === 1 ? (
                    c.mailboxes[0]!.email
                  ) : (
                    `${c.mailboxes[0]!.email} +${c.mailboxes.length - 1}`
                  )}
                </td>
                <td className={cn(TD, "max-w-36 truncate text-text-2")}>{c.owner?.name || c.owner?.email || <span className="text-text-3">—</span>}</td>
                <td className={cn(TD, "whitespace-nowrap text-text-3")} title={f.dateTime(c.updatedAt)}>
                  {f.smart(c.updatedAt)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <>
      <PageHeader
        icon={<EntityTile of="campaigns" />}
        title="Campaigns"
        description="Sequences sent to an audience from your mailboxes. Counts come from the enrollments and messages behind each campaign."
        actions={create}
      />
      <div className="mb-3 flex flex-col gap-2 lg:flex-row lg:items-center">
        <div role="tablist" aria-label="Status" className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-1 lg:pb-0">
          {(["", ...CAMPAIGN_STATUSES] as const).map((s) => (
            <button
              key={s || "all"}
              type="button"
              role="tab"
              aria-selected={state.status === s}
              onClick={() => update({ status: s })}
              className={cn(
                "h-7 shrink-0 rounded-sm px-2.5 text-xs font-medium whitespace-nowrap",
                state.status === s ? "bg-accent-soft text-accent-ink" : "text-text-2 hover:bg-hover hover:text-text",
              )}
            >
              {s ? labelOf(s) : "All"}
            </button>
          ))}
        </div>
        <SearchInput value={state.q} onChange={(q) => update({ q })} placeholder="Search campaigns" className="lg:ml-auto lg:max-w-xs" />
      </div>
      <Card className="overflow-hidden">
        {body}
        {list.data && list.data.total > 0 && (
          <div className="border-t border-line px-3 py-2">
            <Pagination
              page={state.page}
              pageSize={state.pageSize}
              total={list.data.total}
              pageSizes={PAGE_SIZES}
              onPageChange={(page) => update({ page })}
              onPageSizeChange={(pageSize) => update({ pageSize })}
            />
          </div>
        )}
      </Card>
      {canWrite && <NewCampaignModal open={creating} onOpenChange={setCreating} />}
    </>
  );
}
