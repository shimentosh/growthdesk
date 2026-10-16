"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, type ReactNode } from "react";
import { FileSignature, Plus, SearchX } from "lucide-react";
import { QUOTE_STATUSES, type QuoteStatus } from "@growthdesk/shared";
import { QUOTE_STATUS_LABEL, QuoteStatusBadge, money } from "@/components/quotes/common";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { IconTile } from "@/components/ui/IconTile";
import { NativeSelect } from "@/components/ui/Input";
import { Page, PageHeader } from "@/components/ui/PageHeader";
import { Pagination } from "@/components/ui/Pagination";
import { RequirePermission } from "@/components/ui/RequirePermission";
import { SearchInput } from "@/components/ui/SearchInput";
import { LoadingBlock, Skeleton } from "@/components/ui/Skeleton";
import { cn } from "@/lib/cn";
import { formatNumber } from "@/lib/format";
import { useApiMutation, useApiQuery } from "@/lib/query";
import { useFormat, useWorkspace } from "@/lib/session";
import type { Paged } from "@/lib/types";
import type { QuoteDetail, QuoteRow } from "@/lib/types/quotes";

export default function QuotesPage() {
  return (
    <RequirePermission permission="quotes.read">
      <Suspense fallback={<LoadingBlock />}>
        <Quotes />
      </Suspense>
    </RequirePermission>
  );
}

const PAGE_SIZES = [25, 50, 100];
const TH = "h-9 px-3 text-left text-xs font-medium whitespace-nowrap text-text-3";
const TD = "px-3 py-2 align-middle";

/** Status, owner, search and page live in the URL (?status=&owner=&q=&page=). */
function useListParams() {
  const sp = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const rawStatus = sp.get("status") ?? "";
  const page = Number(sp.get("page"));
  const pageSize = Number(sp.get("pageSize"));
  const state = {
    q: sp.get("q") ?? "",
    status: ((QUOTE_STATUSES as readonly string[]).includes(rawStatus) ? rawStatus : "") as QuoteStatus | "",
    owner: sp.get("owner") === "me" ? "me" : "",
    page: Number.isInteger(page) && page > 0 ? page : 1,
    pageSize: PAGE_SIZES.includes(pageSize) ? pageSize : 50,
  };
  const update = (patch: Partial<typeof state>, replace = false) => {
    const next = { ...state, ...patch };
    if (!("page" in patch)) next.page = 1;
    const p = new URLSearchParams();
    if (next.q.trim()) p.set("q", next.q.trim());
    if (next.status) p.set("status", next.status);
    if (next.owner) p.set("owner", next.owner);
    if (next.page > 1) p.set("page", String(next.page));
    if (next.pageSize !== 50) p.set("pageSize", String(next.pageSize));
    const qs = p.toString();
    const href = qs ? `${pathname}?${qs}` : pathname;
    if (replace) router.replace(href, { scroll: false });
    else router.push(href, { scroll: false });
  };
  return { state, update };
}

/** The latest thing that happened to a quote, for the "Activity" column. */
function lastStep(q: QuoteRow, f: ReturnType<typeof useFormat>): ReactNode {
  if (q.acceptedAt) return `Accepted ${f.smart(q.acceptedAt)}${q.signerName ? ` by ${q.signerName}` : ""}`;
  if (q.declinedAt && q.status === "declined") return `Declined ${f.smart(q.declinedAt)}`;
  if (q.lastViewedAt) return `Viewed ${q.viewCount > 1 ? `${q.viewCount}× · last ` : ""}${f.smart(q.lastViewedAt)}`;
  if (q.sentAt) return `Sent ${f.smart(q.sentAt)}`;
  return `Created ${f.smart(q.createdAt)}`;
}

function Quotes() {
  const ws = useWorkspace();
  const f = useFormat();
  const router = useRouter();
  const { state, update } = useListParams();
  const canWrite = ws.can("quotes.write");

  const quotes = useApiQuery<Paged<QuoteRow>>(ws.key("quotes", "list"), ws.path("/quotes"), {
    query: { q: state.q || undefined, status: state.status || undefined, ownerId: state.owner || undefined, page: state.page, pageSize: state.pageSize },
    keepPrevious: true,
  });
  const rows = quotes.data?.items ?? [];

  const create = useApiMutation<QuoteDetail, Record<string, unknown>>({
    path: ws.path("/quotes"),
    invalidate: [ws.key("quotes")],
    onSuccess: (q) => router.push(ws.href(`/quotes/${q.id}`)),
  });
  const newButton = canWrite ? (
    <Button variant="primary" icon={<Plus />} loading={create.isPending} onClick={() => create.mutate({})}>
      New quote
    </Button>
  ) : undefined;

  let body: ReactNode;
  if (quotes.isPending) {
    body = (
      <div className="flex flex-col gap-2 p-4" aria-busy>
        {Array.from({ length: 8 }, (_, i) => (
          <Skeleton key={i} className="h-8" />
        ))}
      </div>
    );
  } else if (quotes.isError && !quotes.data) {
    body = <ErrorState error={quotes.error} onRetry={() => void quotes.refetch()} />;
  } else if (!rows.length) {
    body =
      state.q || state.status || state.owner ? (
        <EmptyState
          icon={<SearchX />}
          title="No quotes match"
          description="Search looks at the number (Q-0012), title, deal and contact."
          action={
            <Button size="sm" onClick={() => update({ q: "", status: "", owner: "" })}>
              Clear filters
            </Button>
          }
        />
      ) : (
        <EmptyState
          icon={<FileSignature />}
          tint="green"
          title="No quotes yet"
          description="Put together a quote from your products, send it from your own mailbox, and let the buyer accept and sign it online. Start one here or from a deal."
          action={newButton}
        />
      );
  } else {
    body = (
      <div className={cn("overflow-x-auto transition-opacity", quotes.isFetching && quotes.isPlaceholderData && "opacity-60")}>
        <table className="w-full min-w-[960px] border-collapse text-sm">
          <thead className="border-b border-line bg-s-2">
            <tr>
              <th scope="col" className={TH}>
                Quote
              </th>
              <th scope="col" className={TH}>
                For
              </th>
              <th scope="col" className={TH}>
                Status
              </th>
              <th scope="col" className={cn(TH, "text-right")}>
                Total
              </th>
              <th scope="col" className={TH}>
                Valid until
              </th>
              <th scope="col" className={TH}>
                Activity
              </th>
              <th scope="col" className={TH}>
                Owner
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows.map((q) => (
              <tr key={q.id} className="hover:bg-hover">
                <td className={cn(TD, "max-w-80")}>
                  <Link href={ws.href(`/quotes/${q.id}`)} className="group flex min-w-0 flex-col">
                    <span className="truncate font-medium text-text group-hover:text-accent-hi">
                      <span className="text-text-3 tabular-nums">{q.numberLabel}</span> {q.title}
                    </span>
                    {q.deal && <span className="truncate text-xs text-text-3">{q.deal.name}</span>}
                  </Link>
                </td>
                <td className={cn(TD, "max-w-56")}>
                  {q.contact ? (
                    <Link href={ws.href(`/contacts/${q.contact.id}`)} className="block truncate text-text-2 hover:text-accent-hi">
                      {q.contact.fullName || q.contact.email}
                    </Link>
                  ) : (
                    <span className="text-text-3">—</span>
                  )}
                  {q.company && <span className="block truncate text-xs text-text-3">{q.company.name}</span>}
                </td>
                <td className={TD}>
                  <QuoteStatusBadge status={q.status} />
                </td>
                <td className={cn(TD, "text-right whitespace-nowrap")}>
                  <span className="text-text tabular-nums">{money(q.total, q.currency)}</span>
                  {Object.values(q.recurring).some((v) => Number(v) !== 0) && <span className="block text-xs text-text-3">{q.summary}</span>}
                </td>
                <td className={cn(TD, "whitespace-nowrap text-text-2")}>{q.validUntil ? f.date(`${q.validUntil}T12:00:00Z`) : <span className="text-text-3">—</span>}</td>
                <td className={cn(TD, "whitespace-nowrap text-text-3")}>{lastStep(q, f)}</td>
                <td className={cn(TD, "max-w-40 truncate text-text-2")}>{q.owner?.name ?? <span className="text-text-3">Unassigned</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <Page width="full">
      <PageHeader
        title="Quotes"
        icon={<IconTile icon={<FileSignature />} tint="green" size="lg" />}
        description={quotes.data ? `${formatNumber(quotes.data.total)} ${state.q || state.status || state.owner ? "matching" : "in this workspace"}` : "Proposals your buyers view, accept and sign online."}
        actions={newButton}
      />
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <SearchInput value={state.q} onChange={(q) => update({ q }, true)} placeholder="Search Q-0012, title, deal, contact…" className="w-full sm:w-80" />
        <NativeSelect
          size="sm"
          className="w-40"
          aria-label="Status"
          value={state.status}
          onChange={(e) => update({ status: e.target.value as QuoteStatus | "" })}
          options={[{ value: "", label: "All statuses" }, ...QUOTE_STATUSES.map((s) => ({ value: s, label: QUOTE_STATUS_LABEL(s) }))]}
        />
        <NativeSelect
          size="sm"
          className="w-36"
          aria-label="Owner"
          value={state.owner}
          onChange={(e) => update({ owner: e.target.value })}
          options={[
            { value: "", label: "Everyone's" },
            { value: "me", label: "Mine" },
          ]}
        />
      </div>

      <Card className="overflow-hidden">{body}</Card>

      {quotes.data && quotes.data.total > 0 && (
        <Pagination
          className="mt-3"
          page={state.page}
          pageSize={state.pageSize}
          total={quotes.data.total}
          pageSizes={PAGE_SIZES}
          onPageChange={(page) => update({ page })}
          onPageSizeChange={(pageSize) => update({ pageSize })}
        />
      )}
    </Page>
  );
}
