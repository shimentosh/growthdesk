"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, Building2, ChevronsUpDown, Plus, SearchX } from "lucide-react";
import { NewCompanyModal } from "@/components/crm/CompanyForm";
import { TagList } from "@/components/crm/Tags";
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
import { cn } from "@/lib/cn";
import { formatNumber } from "@/lib/format";
import { useApiQuery } from "@/lib/query";
import { useFormat, useWorkspace } from "@/lib/session";
import type { Paged } from "@/lib/types";
import type { CompanyRow } from "@/lib/types/crm";

export default function CompaniesPage() {
  return (
    <RequirePermission permission="contacts.read">
      <Suspense fallback={<LoadingBlock />}>
        <Companies />
      </Suspense>
    </RequirePermission>
  );
}

/** The fields companies.service.ts `list()` sorts by. */
const SORTS = ["createdAt", "name", "updatedAt"] as const;
type Sort = (typeof SORTS)[number];
const PAGE_SIZES = [25, 50, 100, 200];

const TH = "h-9 px-3 text-left text-xs font-medium whitespace-nowrap text-text-3";
const TD = "px-3 py-2 align-middle";

/** Search, sort and page live in the URL (?q=&sort=&dir=&page=&pageSize=). */
function useListParams() {
  const sp = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const rawSort = sp.get("sort") ?? "";
  const page = Number(sp.get("page"));
  const pageSize = Number(sp.get("pageSize"));
  const state = {
    q: sp.get("q") ?? "",
    sort: ((SORTS as readonly string[]).includes(rawSort) ? rawSort : "createdAt") as Sort,
    dir: (sp.get("dir") === "asc" ? "asc" : "desc") as "asc" | "desc",
    page: Number.isInteger(page) && page > 0 ? page : 1,
    pageSize: PAGE_SIZES.includes(pageSize) ? pageSize : 50,
  };
  const update = (patch: Partial<typeof state>, replace = false) => {
    const next = { ...state, ...patch };
    if (!("page" in patch)) next.page = 1;
    const p = new URLSearchParams();
    if (next.q.trim()) p.set("q", next.q.trim());
    if (next.sort !== "createdAt") p.set("sort", next.sort);
    if (next.dir !== "desc") p.set("dir", next.dir);
    if (next.page > 1) p.set("page", String(next.page));
    if (next.pageSize !== 50) p.set("pageSize", String(next.pageSize));
    const qs = p.toString();
    const href = qs ? `${pathname}?${qs}` : pathname;
    if (replace) router.replace(href, { scroll: false });
    else router.push(href, { scroll: false });
  };
  return { state, update };
}

function Companies() {
  const ws = useWorkspace();
  const f = useFormat();
  const router = useRouter();
  const { state, update } = useListParams();
  const [creating, setCreating] = useState(false);
  const canWrite = ws.can("contacts.write");

  const companies = useApiQuery<Paged<CompanyRow>>(ws.key("companies", "list"), ws.path("/companies"), {
    query: {
      q: state.q || undefined,
      sort: state.sort,
      dir: state.dir,
      page: state.page,
      pageSize: state.pageSize,
    },
    keepPrevious: true,
  });
  const rows = companies.data?.items ?? [];

  const sortHeader = (field: Sort, label: string) => {
    const active = state.sort === field;
    const Icon = !active ? ChevronsUpDown : state.dir === "asc" ? ArrowUp : ArrowDown;
    return (
      <th scope="col" aria-sort={active ? (state.dir === "asc" ? "ascending" : "descending") : "none"} className={TH}>
        <button
          type="button"
          onClick={() =>
            update({
              sort: field,
              dir: active ? (state.dir === "asc" ? "desc" : "asc") : field === "name" ? "asc" : "desc",
            })
          }
          className={cn("inline-flex items-center gap-1 hover:text-text", active && "text-text")}
        >
          {label}
          <Icon aria-hidden className={cn("size-3", !active && "opacity-50")} />
        </button>
      </th>
    );
  };

  let body: ReactNode;
  if (companies.isPending) {
    body = (
      <div className="flex flex-col gap-2 p-4" aria-busy>
        {Array.from({ length: 8 }, (_, i) => (
          <Skeleton key={i} className="h-8" />
        ))}
      </div>
    );
  } else if (companies.isError && !companies.data) {
    body = <ErrorState error={companies.error} onRetry={() => void companies.refetch()} />;
  } else if (!rows.length) {
    body = state.q ? (
      <EmptyState
        icon={<SearchX />}
        title="No companies match"
        description="Search looks at the name, domain and industry."
        action={
          <Button size="sm" onClick={() => update({ q: "" })}>
            Clear search
          </Button>
        }
      />
    ) : (
      <EmptyState
        icon={<Building2 />}
        tint={ENTITY.companies.tint}
        title="No companies yet"
        description="Companies are created when you add one here, or when a contact arrives with a company name."
        action={
          canWrite ? (
            <Button size="sm" variant="primary" icon={<Plus />} onClick={() => setCreating(true)}>
              New company
            </Button>
          ) : undefined
        }
      />
    );
  } else {
    body = (
      <div className={cn("overflow-x-auto transition-opacity", companies.isFetching && companies.isPlaceholderData && "opacity-60")}>
        <table className="w-full min-w-[920px] border-collapse text-sm">
          <thead className="border-b border-line bg-s-2">
            <tr>
              {sortHeader("name", "Name")}
              <th scope="col" className={TH}>
                Industry
              </th>
              <th scope="col" className={TH}>
                Size
              </th>
              <th scope="col" className={TH}>
                Location
              </th>
              <th scope="col" className={TH}>
                Owner
              </th>
              <th scope="col" className={cn(TH, "text-right")}>
                Contacts
              </th>
              <th scope="col" className={cn(TH, "text-right")}>
                Deals
              </th>
              <th scope="col" className={TH}>
                Tags
              </th>
              {sortHeader("createdAt", "Created")}
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows.map((c) => (
              <tr key={c.id} className="hover:bg-hover">
                <td className={cn(TD, "max-w-72")}>
                  <Link href={ws.href(`/companies/${c.id}`)} className="group flex min-w-0 items-center gap-2">
                    {/* A neutral building mark, the company's counterpart to a contact's initials. */}
                    <span aria-hidden className="flex size-6 shrink-0 items-center justify-center rounded-[7px] bg-s-5 text-text-2 [&_svg]:size-3.5">
                      <Building2 />
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate font-medium text-text group-hover:text-accent-hi">{c.name}</span>
                      {c.domain && <span className="block truncate text-xs text-text-3">{c.domain}</span>}
                    </span>
                  </Link>
                </td>
                <td className={cn(TD, "max-w-40 truncate text-text-2")}>{c.industry || <span className="text-text-3">—</span>}</td>
                <td className={cn(TD, "whitespace-nowrap text-text-2")}>{c.size || <span className="text-text-3">—</span>}</td>
                <td className={cn(TD, "max-w-48 truncate text-text-2")}>
                  {[c.city, c.region, c.country].filter(Boolean).join(", ") || <span className="text-text-3">—</span>}
                </td>
                <td className={cn(TD, "max-w-40 truncate text-text-2")}>{c.owner?.name ?? <span className="text-text-3">Unassigned</span>}</td>
                <td className={cn(TD, "text-right text-text-2 tabular-nums")}>{formatNumber(c.contactCount)}</td>
                <td className={cn(TD, "text-right text-text-2 tabular-nums")}>{formatNumber(c.dealCount)}</td>
                <td className={cn(TD, "max-w-56")}>
                  <TagList tags={c.tags} max={2} />
                </td>
                <td className={cn(TD, "whitespace-nowrap text-text-3")} title={f.dateTime(c.createdAt)}>
                  {f.smart(c.createdAt)}
                </td>
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
        title="Companies"
        icon={<EntityTile of="companies" />}
        description={
          companies.data ? `${formatNumber(companies.data.total)} ${state.q ? "matching" : "in this workspace"}` : "The organisations your contacts work for."
        }
        actions={
          canWrite ? (
            <Button variant="primary" icon={<Plus />} onClick={() => setCreating(true)}>
              New company
            </Button>
          ) : undefined
        }
      />
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <SearchInput value={state.q} onChange={(q) => update({ q }, true)} placeholder="Search name, domain, industry…" className="w-full sm:w-80" />
        <label className="flex items-center gap-1.5 text-xs text-text-3">
          Sort
          <select
            value={state.sort}
            onChange={(e) => update({ sort: e.target.value as Sort })}
            className="h-8 rounded-sm border border-line-strong bg-field px-2 text-sm text-text"
          >
            <option value="createdAt">Created</option>
            <option value="updatedAt">Last updated</option>
            <option value="name">Name</option>
          </select>
        </label>
      </div>

      <Card className="overflow-hidden">{body}</Card>

      {companies.data && companies.data.total > 0 && (
        <Pagination
          className="mt-3"
          page={state.page}
          pageSize={state.pageSize}
          total={companies.data.total}
          pageSizes={PAGE_SIZES}
          onPageChange={(page) => update({ page })}
          onPageSizeChange={(pageSize) => update({ pageSize })}
        />
      )}

      <NewCompanyModal open={creating} onOpenChange={setCreating} onCreated={(c) => router.push(ws.href(`/companies/${c.id}`))} />
    </Page>
  );
}
