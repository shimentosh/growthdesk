"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Plus, SearchX, X } from "lucide-react";
import { MARKETING_CAMPAIGN_STATUSES, type MarketingCampaignStatus } from "@growthdesk/shared";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { ENTITY, EntityTile } from "@/components/ui/icons";
import { Page, PageHeader } from "@/components/ui/PageHeader";
import { RequirePermission } from "@/components/ui/RequirePermission";
import { SearchInput } from "@/components/ui/SearchInput";
import { LoadingBlock, Skeleton } from "@/components/ui/Skeleton";
import { CampaignStatusBadge, useMarketing, useMarketingLists } from "@/components/marketing/common";
import { CampaignMenu, audienceSummary, rateOf } from "@/components/marketing/campaigns/common";
import { NewCampaignModal } from "@/components/marketing/campaigns/NewCampaignModal";
import { SendingSetupBanner } from "@/components/marketing/campaigns/SendingSetupBanner";
import { cn } from "@/lib/cn";
import { formatNumber } from "@/lib/format";
import { useApiQuery } from "@/lib/query";
import { useFormat, useWorkspace } from "@/lib/session";
import type { SavedView } from "@/lib/types/crm";
import type { MarketingCampaign } from "@/lib/types/marketing";

export default function MarketingCampaignsPage() {
  return (
    <Page>
      <RequirePermission permission="marketing.read">
        <Suspense fallback={<LoadingBlock />}>
          <Campaigns />
        </Suspense>
      </RequirePermission>
    </Page>
  );
}

const Glyph = ENTITY.marketingCampaigns.icon;
const TH = "h-9 px-3 text-left text-xs font-medium whitespace-nowrap text-text-3";
const TD = "px-3 py-2 align-middle";
const STATUS_LABEL: Record<MarketingCampaignStatus, string> = { draft: "Drafts", scheduled: "Scheduled", sending: "Sending", paused: "Paused", sent: "Sent", canceled: "Canceled" };

/** Status and search live in the URL (?status=&q=). The API returns every campaign at once, so both filter here. */
function useListParams() {
  const sp = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const raw = sp.get("status") ?? "";
  const state = {
    q: sp.get("q") ?? "",
    status: ((MARKETING_CAMPAIGN_STATUSES as readonly string[]).includes(raw) ? raw : "") as MarketingCampaignStatus | "",
  };
  const update = (patch: Partial<typeof state>) => {
    const next = { ...state, ...patch };
    const p = new URLSearchParams();
    if (next.q.trim()) p.set("q", next.q.trim());
    if (next.status) p.set("status", next.status);
    const qs = p.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };
  return { state, update };
}

const Num = ({ n }: { n: number }) => <span className={cn("tabular-nums", n ? "text-text" : "text-text-3")}>{formatNumber(n)}</span>;

function Campaigns() {
  const ws = useWorkspace();
  const mk = useMarketing();
  const f = useFormat();
  const { state, update } = useListParams();
  const [creating, setCreating] = useState(false);
  const canWrite = ws.can("marketing.write");
  const qc = useQueryClient();
  const listKey = mk.key("campaigns", "list");
  // Sending campaigns move; keep their numbers fresh while the list is open.
  const sending = qc.getQueryData<MarketingCampaign[]>(listKey)?.some((c) => c.status === "sending") ?? false;
  const list = useApiQuery<MarketingCampaign[]>(listKey, mk.path("/campaigns"), { refetchInterval: sending ? 5_000 : false });
  const lists = useMarketingLists(true);
  const views = useApiQuery<SavedView[]>(ws.key("views", "contact"), ws.path("/views"), { query: { entity: "contact" } });
  const all = list.data ?? [];
  const q = state.q.trim().toLowerCase();
  const rows = all.filter((c) => (!state.status || c.status === state.status) && (!q || c.name.toLowerCase().includes(q) || c.subject.toLowerCase().includes(q)));
  const counts = Object.fromEntries(MARKETING_CAMPAIGN_STATUSES.map((s) => [s, all.filter((c) => c.status === s).length])) as Record<MarketingCampaignStatus, number>;
  const filtered = Boolean(q || state.status);
  const create = canWrite ? (
    <Button variant="primary" icon={<Plus />} onClick={() => setCreating(true)}>
      New campaign
    </Button>
  ) : undefined;

  let body: ReactNode;
  if (list.isPending) {
    body = (
      <div className="flex flex-col gap-2 p-4" aria-busy>
        {Array.from({ length: 5 }, (_, i) => (
          <Skeleton key={i} className="h-10" />
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
        description="Search looks at the campaign name and subject line."
        action={
          <Button size="sm" icon={<X />} onClick={() => update({ q: "", status: "" })}>
            Clear filters
          </Button>
        }
      />
    ) : (
      <EmptyState
        icon={<Glyph />}
        tint={ENTITY.marketingCampaigns.tint}
        title="No email campaigns yet"
        description={
          canWrite
            ? "Send a newsletter or an announcement to the people on your lists. Only contacts who agreed to hear from you receive it, and every email carries an unsubscribe link."
            : "Nobody has created an email campaign yet."
        }
        action={create}
      />
    );
  } else {
    body = (
      <div className="overflow-x-auto">
        <table className="w-full min-w-[980px] border-collapse text-sm">
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
                Recipients
              </th>
              <th scope="col" className={cn(TH, "text-right")}>
                Sent
              </th>
              <th scope="col" className={cn(TH, "text-right")}>
                Opened
              </th>
              <th scope="col" className={cn(TH, "text-right")}>
                Clicked
              </th>
              <th scope="col" className={TH}>
                Updated
              </th>
              <th scope="col" className="w-10">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows.map((c) => {
              const started = c.status !== "draft" && c.status !== "scheduled";
              const audience = audienceSummary(c.audience, lists.data, views.data?.find((v) => v.id === c.audience.viewId)?.name);
              const sub =
                c.status === "scheduled" && c.scheduledAt
                  ? `Sends ${f.smart(c.scheduledAt)}`
                  : c.status === "sent" && c.completedAt
                    ? `Sent ${f.smart(c.completedAt)}`
                    : c.subject || "No subject yet";
              return (
                <tr key={c.id} className="hover:bg-hover">
                  <td className={cn(TD, "max-w-72")}>
                    <Link href={mk.href(`/campaigns/${c.id}`)} className="group block min-w-0">
                      <span className="block truncate font-medium text-text group-hover:text-accent-hi">{c.name}</span>
                      <span className={cn("block truncate text-xs", c.subject || c.status !== "draft" ? "text-text-3" : "text-text-3 italic")}>{sub}</span>
                    </Link>
                  </td>
                  <td className={cn(TD, "whitespace-nowrap")}>
                    <CampaignStatusBadge status={c.status} />
                  </td>
                  <td className={cn(TD, "max-w-60 truncate", c.audience.listIds.length ? "text-text-2" : "text-text-3")} title={audience}>
                    {audience}
                  </td>
                  <td className={cn(TD, "text-right")}>{started ? <Num n={c.stats.recipients} /> : <span className="text-text-3">—</span>}</td>
                  <td className={cn(TD, "text-right")}>{started ? <Num n={c.stats.sent} /> : <span className="text-text-3">—</span>}</td>
                  <td className={cn(TD, "text-right tabular-nums")}>
                    {started && c.trackOpens ? <span className={c.stats.uniqueOpens ? "text-text" : "text-text-3"}>{rateOf(c.stats.uniqueOpens, c.stats.sent)}</span> : <span className="text-text-3">—</span>}
                  </td>
                  <td className={cn(TD, "text-right tabular-nums")}>
                    {started && c.trackClicks ? <span className={c.stats.uniqueClicks ? "text-text" : "text-text-3"}>{rateOf(c.stats.uniqueClicks, c.stats.sent)}</span> : <span className="text-text-3">—</span>}
                  </td>
                  <td className={cn(TD, "whitespace-nowrap text-text-3")} title={f.dateTime(c.updatedAt)}>
                    {f.smart(c.updatedAt)}
                  </td>
                  <td className="px-2 py-2 text-right">
                    <CampaignMenu campaign={c} size="sm" />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <>
      <PageHeader
        icon={<EntityTile of="marketingCampaigns" />}
        title="Email campaigns"
        description="One-off emails to your marketing lists. Only subscribed contacts with recorded consent receive them."
        actions={create}
      />
      {!ws.hasFeature("marketing") && (
        <Callout tone="warn" title="Your plan does not include email marketing" className="mb-4">
          You can look at past campaigns, but new ones cannot be sent until the plan is upgraded.
        </Callout>
      )}
      <SendingSetupBanner className="mb-4" />
      {all.length > 0 && (
        <div className="mb-3 flex flex-col gap-2 lg:flex-row lg:items-center">
          <div role="tablist" aria-label="Status" className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-1 lg:pb-0">
            {(["", ...MARKETING_CAMPAIGN_STATUSES.filter((s) => counts[s] > 0 || state.status === s)] as const).map((s) => (
              <button
                key={s || "all"}
                type="button"
                role="tab"
                aria-selected={state.status === s}
                onClick={() => update({ status: s })}
                className={cn(
                  "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-sm px-2.5 text-xs font-medium whitespace-nowrap",
                  state.status === s ? "bg-accent-soft text-accent-ink" : "text-text-2 hover:bg-hover hover:text-text",
                )}
              >
                {s ? STATUS_LABEL[s] : "All"}
                <span className="text-text-3 tabular-nums">{s ? counts[s] : all.length}</span>
              </button>
            ))}
          </div>
          <SearchInput value={state.q} onChange={(v) => update({ q: v })} placeholder="Search campaigns" className="lg:ml-auto lg:max-w-xs" />
        </div>
      )}
      <Card className="overflow-hidden">{body}</Card>
      {canWrite && <NewCampaignModal open={creating} onOpenChange={setCreating} />}
    </>
  );
}
