"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useMemo, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AudioLines, Layers, MailPlus, Plus, SearchX, Send, X } from "lucide-react";
import type { StepType } from "@growthdesk/shared";
import { CampaignTypeModal, useCampaignKinds } from "@/components/campaigns/CampaignTypeModal";
import { CampaignMenu, rateOf } from "@/components/marketing/campaigns/common";
import { SendingSetupBanner } from "@/components/marketing/campaigns/SendingSetupBanner";
import { CampaignStatusBadge, useMarketing } from "@/components/marketing/common";
import { Badge, StatusBadge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Card } from "@/components/ui/Card";
import { COL, ColumnLabel } from "@/components/ui/columns";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { ENTITY, EntityTile } from "@/components/ui/icons";
import { Page, PageHeader } from "@/components/ui/PageHeader";
import { Pagination } from "@/components/ui/Pagination";
import { RequirePermission } from "@/components/ui/RequirePermission";
import { SearchInput } from "@/components/ui/SearchInput";
import { LoadingBlock, Skeleton } from "@/components/ui/Skeleton";
import { cn } from "@/lib/cn";
import { formatNumber } from "@/lib/format";
import { useApiQuery } from "@/lib/query";
import { useFormat, useWorkspace } from "@/lib/session";
import type { Paged } from "@/lib/types";
import type { Campaign } from "@/lib/types/campaigns";
import type { MarketingCampaign } from "@/lib/types/marketing";

export default function CampaignsPage() {
  return (
    <Page>
      <RequirePermission permission={["campaigns.read", "marketing.read"]}>
        <Suspense fallback={<LoadingBlock />}>
          <Campaigns />
        </Suspense>
      </RequirePermission>
    </Page>
  );
}

/** ai_calling: outreach campaigns with an AI call step (still the outreach list, filtered here). */
type TypeFilter = "" | "outreach" | "marketing" | "ai_calling";

const PAGE_SIZES = [25, 50, 100];
/** How many outreach campaigns the merged list reads (the API's page-size cap); search reaches the rest. */
const OUTREACH_CAP = 200;
const CampaignGlyph = ENTITY.campaigns.icon;
const TH = "h-9 px-3 text-left text-xs font-medium whitespace-nowrap text-text-3";
const TD = "px-3 py-2 align-middle";

const STEP_CHANNEL: Partial<Record<StepType, string>> = { email: "Email", call_task: "Calls", ai_call: "AI calls", whatsapp: "WhatsApp", telegram: "Telegram" };

const isAiCalling = (c: Campaign) => (c.stepTypes ?? []).includes("ai_call");

/** One row of the merged table: an outreach campaign or a marketing campaign. */
type Row = { kind: "outreach"; id: string; updatedAt: string; c: Campaign } | { kind: "marketing"; id: string; updatedAt: string; c: MarketingCampaign };

/** Type, search and page live in the URL (?type=&q=&page=&pageSize=). */
function useListParams() {
  const sp = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const page = Number(sp.get("page"));
  const pageSize = Number(sp.get("pageSize"));
  const type = sp.get("type") ?? "";
  const state = {
    q: sp.get("q") ?? "",
    type: (type === "outreach" || type === "marketing" || type === "ai_calling" ? type : "") as TypeFilter,
    page: Number.isInteger(page) && page > 0 ? page : 1,
    pageSize: PAGE_SIZES.includes(pageSize) ? pageSize : 50,
  };
  const update = (patch: Partial<typeof state>) => {
    const next = { ...state, ...patch };
    if (!("page" in patch)) next.page = 1;
    const p = new URLSearchParams();
    if (next.type) p.set("type", next.type);
    if (next.q.trim()) p.set("q", next.q.trim());
    if (next.page > 1) p.set("page", String(next.page));
    if (next.pageSize !== 50) p.set("pageSize", String(next.pageSize));
    const qs = p.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };
  return { state, update };
}

const Num = ({ n }: { n: number }) => <span className={cn("tabular-nums", n ? "text-text" : "text-text-3")}>{formatNumber(n)}</span>;
const Dash = () => <span className="text-text-3">—</span>;

/** Outreach channels from the step kinds when the list answer has them; otherwise "Sequence". */
function outreachChannels(c: Campaign): string {
  const kinds = [...new Set((c.stepTypes ?? []).map((t) => STEP_CHANNEL[t]).filter((x): x is string => Boolean(x)))];
  return kinds.length ? kinds.join(", ") : "Sequence";
}

/**
 * Every campaign in one table: outreach (multi-step sequences from your
 * mailboxes) and marketing (one-off email to opted-in lists). They are two
 * engines with their own detail pages; this list only merges them.
 */
function Campaigns() {
  const ws = useWorkspace();
  const mk = useMarketing();
  const f = useFormat();
  const qc = useQueryClient();
  const { state, update } = useListParams();
  const [creating, setCreating] = useState(false);
  const kinds = useCampaignKinds();
  const canOutreach = ws.can("campaigns.read");
  const canMarketing = ws.can("marketing.read");
  const wantOutreach = canOutreach && state.type !== "marketing";
  const wantMarketing = canMarketing && state.type !== "outreach" && state.type !== "ai_calling";
  const showAiCalling = canOutreach && (ws.hasFeature("calling") || state.type === "ai_calling");

  const outreach = useApiQuery<Paged<Campaign>>(ws.key("campaigns", "list"), wantOutreach ? ws.path("/campaigns") : null, {
    query: { q: state.q.trim() || undefined, sort: "updatedAt", dir: "desc", page: 1, pageSize: OUTREACH_CAP },
    keepPrevious: true,
  });
  const listKey = mk.key("campaigns", "list");
  // Sending campaigns move; keep their numbers fresh while the list is open.
  const sending = qc.getQueryData<MarketingCampaign[]>(listKey)?.some((c) => c.status === "sending") ?? false;
  const marketing = useApiQuery<MarketingCampaign[]>(listKey, wantMarketing ? mk.path("/campaigns") : null, { refetchInterval: sending ? 5_000 : false });

  const q = state.q.trim().toLowerCase();
  const all = useMemo<Row[]>(() => {
    const rows: Row[] = [];
    if (wantOutreach)
      for (const c of outreach.data?.items ?? []) if (state.type !== "ai_calling" || isAiCalling(c)) rows.push({ kind: "outreach", id: c.id, updatedAt: c.updatedAt, c });
    if (wantMarketing)
      for (const c of marketing.data ?? [])
        if (!q || c.name.toLowerCase().includes(q) || c.subject.toLowerCase().includes(q)) rows.push({ kind: "marketing", id: c.id, updatedAt: c.updatedAt, c });
    return rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }, [wantOutreach, wantMarketing, outreach.data, marketing.data, q, state.type]);
  const rows = all.slice((state.page - 1) * state.pageSize, state.page * state.pageSize);

  const pending = (wantOutreach && outreach.isPending) || (wantMarketing && marketing.isPending);
  const failed = wantOutreach && outreach.isError && !outreach.data ? outreach : wantMarketing && marketing.isError && !marketing.data ? marketing : null;
  const truncated = wantOutreach && (outreach.data?.total ?? 0) > OUTREACH_CAP;
  const filtered = Boolean(state.q);
  const create = kinds.any ? (
    <Button variant="primary" icon={<Plus />} onClick={() => setCreating(true)}>
      New campaign
    </Button>
  ) : undefined;

  let body: ReactNode;
  if (pending) {
    body = (
      <div className="flex flex-col gap-2 p-4" aria-busy>
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="h-9" />
        ))}
      </div>
    );
  } else if (failed?.error) {
    body = <ErrorState error={failed.error} onRetry={() => void failed.refetch()} />;
  } else if (!all.length) {
    body = filtered ? (
      <EmptyState
        icon={<SearchX />}
        title="No campaigns match"
        description="Search looks at the campaign name (and a marketing email's subject line)."
        action={
          <Button size="sm" icon={<X />} onClick={() => update({ q: "" })}>
            Clear search
          </Button>
        }
      />
    ) : (
      <EmptyState
        icon={<CampaignGlyph />}
        tint={ENTITY.campaigns.tint}
        title={
          state.type === "marketing"
            ? "No marketing campaigns yet"
            : state.type === "outreach"
              ? "No outreach campaigns yet"
              : state.type === "ai_calling"
                ? "No AI calling campaigns yet"
                : "No campaigns yet"
        }
        description={
          kinds.any
            ? "Outreach campaigns send 1:1 multi-step sequences from your mailboxes. Marketing campaigns send one email to opted-in lists from your verified domain."
            : "Nobody has created a campaign yet."
        }
        action={create}
      />
    );
  } else {
    body = (
      <div className={cn("overflow-x-auto transition-opacity", outreach.isFetching && outreach.isPlaceholderData && "opacity-60")}>
        <table className="w-full min-w-[1040px] border-collapse text-sm">
          <thead className="border-b border-line bg-s-2">
            <tr>
              <th scope="col" className={TH}>
                <ColumnLabel icon={COL.name}>Name</ColumnLabel>
              </th>
              <th scope="col" className={TH}>
                <ColumnLabel icon={COL.type}>Type</ColumnLabel>
              </th>
              <th scope="col" className={TH}>
                <ColumnLabel icon={COL.channel}>Channels</ColumnLabel>
              </th>
              <th scope="col" className={TH}>
                <ColumnLabel icon={COL.status}>Status</ColumnLabel>
              </th>
              <th scope="col" className={TH}>
                <ColumnLabel icon={COL.target}>Audience</ColumnLabel>
              </th>
              <th scope="col" className={cn(TH, "text-right")}>
                <ColumnLabel icon={COL.people}>Reached</ColumnLabel>
              </th>
              <th scope="col" className={cn(TH, "text-right")}>
                <ColumnLabel icon={COL.sent}>Sent</ColumnLabel>
              </th>
              <th scope="col" className={cn(TH, "text-right")}>
                <ColumnLabel icon={COL.activity}>Engagement</ColumnLabel>
              </th>
              <th scope="col" className={TH}>
                <ColumnLabel icon={COL.updated}>Updated</ColumnLabel>
              </th>
              <th scope="col" className="w-10">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows.map((r) =>
              r.kind === "outreach" ? (
                <tr key={`o-${r.id}`} className="hover:bg-hover">
                  <td className={cn(TD, "max-w-64")}>
                    <Link href={ws.href(`/campaigns/${r.c.id}`)} className="group block min-w-0">
                      <span className="block truncate font-medium text-text group-hover:text-accent-hi">{r.c.name}</span>
                      <span className="block truncate text-xs text-text-3">
                        {r.c.stepCount} step{r.c.stepCount === 1 ? "" : "s"}
                        {r.c.status === "scheduled" && r.c.startAt ? ` · starts ${f.smart(r.c.startAt)}` : ""}
                      </span>
                    </Link>
                  </td>
                  <td className={TD}>
                    <Badge tone="live" quiet>
                      {isAiCalling(r.c) ? "AI calling" : "Outreach"}
                    </Badge>
                  </td>
                  <td className={cn(TD, "max-w-40 truncate text-text-2")}>{outreachChannels(r.c)}</td>
                  <td className={cn(TD, "whitespace-nowrap")}>
                    <StatusBadge value={r.c.status} />
                  </td>
                  <td className={cn(TD, "max-w-56 truncate text-text-2")} title={r.c.audienceDescription}>
                    {r.c.audienceDescription || <Dash />}
                  </td>
                  <td className={cn(TD, "text-right")} title="Enrolled">
                    <Num n={r.c.stats.enrolled} />
                  </td>
                  <td className={cn(TD, "text-right")}>
                    <Num n={r.c.stats.sent} />
                  </td>
                  <td className={cn(TD, "text-right whitespace-nowrap text-text-2 tabular-nums")}>
                    {r.c.stats.replied ? `${formatNumber(r.c.stats.replied)} replied` : <Dash />}
                  </td>
                  <td className={cn(TD, "whitespace-nowrap text-text-3")} title={f.dateTime(r.c.updatedAt)}>
                    {f.smart(r.c.updatedAt)}
                  </td>
                  <td />
                </tr>
              ) : (
                <MarketingRow key={`m-${r.id}`} c={r.c} />
              ),
            )}
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
        description="Outreach sequences sent 1:1 from your mailboxes, and marketing email sent to opted-in lists, in one place."
        actions={create}
      />
      {state.type === "marketing" && (
        <>
          {!ws.hasFeature("marketing") && (
            <Callout tone="warn" title="Your plan does not include email marketing" className="mb-4">
              You can look at past campaigns, but new ones cannot be sent until the plan is upgraded.
            </Callout>
          )}
          <SendingSetupBanner className="mb-4" />
        </>
      )}
      <div className="mb-3 flex flex-col gap-2 lg:flex-row lg:items-center">
        {canOutreach && (canMarketing || showAiCalling) && (
          <div role="tablist" aria-label="Type" className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-1 lg:pb-0">
            {(
              [
                ["", "All", Layers],
                ...(canMarketing ? ([["outreach", "Outreach", Send]] as const) : []),
                ...(showAiCalling ? ([["ai_calling", "AI calling", AudioLines]] as const) : []),
                ...(canMarketing ? ([["marketing", "Marketing", MailPlus]] as const) : []),
              ] as const
            ).map(([value, label, Icon]) => (
              <button
                key={value || "all"}
                type="button"
                role="tab"
                aria-selected={state.type === value}
                onClick={() => update({ type: value })}
                className={cn(
                  "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-sm px-2.5 text-xs font-medium whitespace-nowrap",
                  state.type === value ? "bg-accent-soft text-accent-ink" : "text-text-2 hover:bg-hover hover:text-text",
                )}
              >
                <Icon aria-hidden className="size-3.5 shrink-0 opacity-70" strokeWidth={1.75} />
                {label}
              </button>
            ))}
          </div>
        )}
        <SearchInput value={state.q} onChange={(v) => update({ q: v })} placeholder="Search campaigns" className="lg:ml-auto lg:max-w-xs" />
      </div>
      {truncated && (
        <p className="mb-2 text-xs text-text-3">
          Showing the {formatNumber(OUTREACH_CAP)} most recently updated outreach campaigns of {formatNumber(outreach.data?.total ?? 0)}. Search to find older ones.
        </p>
      )}
      <Card className="overflow-hidden">
        {body}
        {all.length > 0 && (
          <div className="border-t border-line px-3 py-2">
            <Pagination
              page={state.page}
              pageSize={state.pageSize}
              total={all.length}
              pageSizes={PAGE_SIZES}
              onPageChange={(page) => update({ page })}
              onPageSizeChange={(pageSize) => update({ pageSize })}
            />
          </div>
        )}
      </Card>
      <CampaignTypeModal open={creating} onOpenChange={setCreating} />
    </>
  );
}

function MarketingRow({ c }: { c: MarketingCampaign }) {
  const mk = useMarketing();
  const f = useFormat();
  const started = c.status !== "draft" && c.status !== "scheduled";
  const sub =
    c.status === "scheduled" && c.scheduledAt
      ? `Sends ${f.smart(c.scheduledAt)}`
      : c.status === "sent" && c.completedAt
        ? `Sent ${f.smart(c.completedAt)}`
        : c.subject || "No subject yet";
  const lists = c.audience.listIds.length;
  return (
    <tr className="hover:bg-hover">
      <td className={cn(TD, "max-w-64")}>
        <Link href={mk.href(`/campaigns/${c.id}`)} className="group block min-w-0">
          <span className="block truncate font-medium text-text group-hover:text-accent-hi">{c.name}</span>
          <span className={cn("block truncate text-xs text-text-3", !c.subject && c.status === "draft" && "italic")}>{sub}</span>
        </Link>
      </td>
      <td className={TD}>
        <Badge tone="info" quiet>
          Marketing
        </Badge>
      </td>
      <td className={cn(TD, "text-text-2")}>Email</td>
      <td className={cn(TD, "whitespace-nowrap")}>
        <CampaignStatusBadge status={c.status} />
      </td>
      <td className={cn(TD, "max-w-56 truncate", lists ? "text-text-2" : "text-text-3")}>
        {lists ? `${formatNumber(lists)} list${lists === 1 ? "" : "s"}${c.audience.viewId ? " · segment" : ""}` : "No lists chosen"}
      </td>
      <td className={cn(TD, "text-right")} title="Recipients">
        {started ? <Num n={c.stats.recipients} /> : <Dash />}
      </td>
      <td className={cn(TD, "text-right")}>{started ? <Num n={c.stats.sent} /> : <Dash />}</td>
      <td className={cn(TD, "text-right whitespace-nowrap text-text-2 tabular-nums")}>
        {started && c.trackOpens ? `${rateOf(c.stats.uniqueOpens, c.stats.sent)} opened` : <Dash />}
      </td>
      <td className={cn(TD, "whitespace-nowrap text-text-3")} title={f.dateTime(c.updatedAt)}>
        {f.smart(c.updatedAt)}
      </td>
      <td className="px-2 py-2 text-right">
        <CampaignMenu campaign={c} size="sm" />
      </td>
    </tr>
  );
}

