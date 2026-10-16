"use client";

import { Fragment, useState, type ReactNode } from "react";
import { Archive, ArchiveRestore, Ellipsis, Eye, Package, Pencil, Plus, RefreshCw, SearchX, Trash2 } from "lucide-react";
import { ProductModal } from "@/components/quotes/ProductModal";
import { money, periodLabel, plain } from "@/components/quotes/common";
import { Badge } from "@/components/ui/Badge";
import { Button, IconButton } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { ConfirmDialog } from "@/components/ui/Dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/DropdownMenu";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { IconTile } from "@/components/ui/IconTile";
import { NativeSelect } from "@/components/ui/Input";
import { Page, PageHeader } from "@/components/ui/PageHeader";
import { Pagination } from "@/components/ui/Pagination";
import { RequirePermission } from "@/components/ui/RequirePermission";
import { SearchInput } from "@/components/ui/SearchInput";
import { Skeleton } from "@/components/ui/Skeleton";
import { Tooltip } from "@/components/ui/Tooltip";
import { cn } from "@/lib/cn";
import { formatNumber } from "@/lib/format";
import { useApiMutation, useApiQuery } from "@/lib/query";
import { useFormat, useWorkspace } from "@/lib/session";
import type { Paged } from "@/lib/types";
import type { Product } from "@/lib/types/quotes";

export default function ProductsPage() {
  return (
    <RequirePermission permission={["quotes.read", "products.manage"]}>
      <Products />
    </RequirePermission>
  );
}

type State = "active" | "archived" | "all";
const PAGE_SIZES = [50, 100, 200];

const TH = "h-9 px-3 text-left text-xs font-medium whitespace-nowrap text-text-3";
const TD = "px-3 py-2 align-middle";

/** "Guest Posts · Link building" — the heading a run of rows sits under (the API sorts by group, then category). */
const groupOf = (p: Product) => [p.groupName, p.category].filter(Boolean).join(" · ");

/** (price − cost) ÷ price, as a whole percent; null without a cost or a price. */
function margin(p: Product): number | null {
  const price = Number(p.unitPrice);
  if (p.costPrice === null || !(price > 0)) return null;
  return Math.round(((price - Number(p.costPrice)) / price) * 1000) / 10;
}

function Products() {
  const ws = useWorkspace();
  const f = useFormat();
  const canManage = ws.can("products.manage");
  const [q, setQ] = useState("");
  const [state, setState] = useState<State>("active");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(100);
  const [editing, setEditing] = useState<Product | null>(null);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<Product | null>(null);

  const list = useApiQuery<Paged<Product>>(ws.key("products", "list"), ws.path("/products"), { query: { q: q || undefined, state, page, pageSize }, keepPrevious: true });
  const rows = list.data?.items ?? [];
  const showCost = canManage && rows.some((p) => p.costPrice !== null);
  const columns = 6 + (showCost ? 2 : 0);

  const archive = useApiMutation<Product, { id: string; archived: boolean }>({
    method: "PATCH",
    path: (v) => ws.path(`/products/${v.id}`),
    body: (v) => ({ archived: v.archived }),
    invalidate: [ws.key("products")],
    success: (_d, v) => (v.archived ? "Product archived" : "Product restored"),
  });
  const remove = useApiMutation<unknown, string>({ method: "DELETE", path: (id) => ws.path(`/products/${id}`), invalidate: [ws.key("products")], success: "Product deleted", errorToast: false });

  let body: ReactNode;
  if (list.isPending) {
    body = (
      <div className="flex flex-col gap-2 p-4" aria-busy>
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="h-8" />
        ))}
      </div>
    );
  } else if (list.isError && !list.data) {
    body = <ErrorState error={list.error} onRetry={() => void list.refetch()} />;
  } else if (!rows.length) {
    body = q ? (
      <EmptyState icon={<SearchX />} title="No products match" description="Search looks at the name, SKU, description, group and category." action={<Button size="sm" onClick={() => setQ("")}>Clear search</Button>} />
    ) : (
      <EmptyState
        icon={<Package />}
        tint="brown"
        title={state === "archived" ? "No archived products" : "No products yet"}
        description="Add what you sell once — name, price, tax and billing period — and pick it on any quote line."
        action={
          canManage && state !== "archived" ? (
            <Button size="sm" variant="primary" icon={<Plus />} onClick={() => setCreating(true)}>
              New product
            </Button>
          ) : undefined
        }
      />
    );
  } else {
    body = (
      <div className={cn("overflow-x-auto transition-opacity", list.isFetching && list.isPlaceholderData && "opacity-60")}>
        <table className="w-full min-w-[760px] border-collapse text-sm">
          <thead className="border-b border-line bg-s-2">
            <tr>
              <th scope="col" className={TH}>
                Product
              </th>
              <th scope="col" className={TH}>
                Billing
              </th>
              <th scope="col" className={cn(TH, "text-right")}>
                Price
              </th>
              {showCost && (
                <>
                  <th scope="col" className={cn(TH, "text-right")}>
                    Cost
                  </th>
                  <th scope="col" className={cn(TH, "text-right")}>
                    Margin
                  </th>
                </>
              )}
              <th scope="col" className={cn(TH, "text-right")}>
                Tax
              </th>
              <th scope="col" className={TH}>
                Updated
              </th>
              <th scope="col" className={TH}>
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows.map((p, i) => {
              const group = groupOf(p);
              const heading = group && (i === 0 || groupOf(rows[i - 1]!) !== group) ? group : !group && i > 0 && groupOf(rows[i - 1]!) ? "Other" : null;
              const m = margin(p);
              return (
                <Fragment key={p.id}>
                  {heading && (
                    <tr className="bg-s-2">
                      <th scope="colgroup" colSpan={columns} className="px-3 py-1.5 text-left text-xs font-semibold text-text-2">
                        {heading}
                      </th>
                    </tr>
                  )}
                  <tr className="hover:bg-hover">
                    <td className={cn(TD, "max-w-96")}>
                      <button type="button" onClick={() => setEditing(p)} className="group flex min-w-0 flex-col text-left">
                        <span className="flex min-w-0 items-center gap-2">
                          <span className="truncate font-medium text-text group-hover:text-accent-hi">{p.name}</span>
                          {p.synced && (
                            <Badge tone="live" title={p.syncedAt ? `Last synced ${f.dateTime(p.syncedAt)}` : undefined}>
                              Synced from client portal
                            </Badge>
                          )}
                          {p.archived && <Badge tone="warn">Archived</Badge>}
                        </span>
                        <span className="truncate text-xs text-text-3">{[p.sku, p.unit && `per ${p.unit}`, p.description].filter(Boolean).join(" · ") || "—"}</span>
                      </button>
                    </td>
                    <td className={cn(TD, "whitespace-nowrap text-text-2")}>{periodLabel(p.billingPeriod)}</td>
                    <td className={cn(TD, "text-right whitespace-nowrap text-text tabular-nums")}>{money(p.unitPrice, p.currency)}</td>
                    {showCost && (
                      <>
                        <td className={cn(TD, "text-right whitespace-nowrap text-text-2 tabular-nums")}>{p.costPrice !== null ? money(p.costPrice, p.currency) : <span className="text-text-3">—</span>}</td>
                        <td className={cn(TD, "text-right whitespace-nowrap tabular-nums", m !== null && m < 0 ? "text-bad-ink" : "text-text-2")}>{m !== null ? `${formatNumber(m)}%` : <span className="text-text-3">—</span>}</td>
                      </>
                    )}
                    <td className={cn(TD, "text-right text-text-2 tabular-nums")}>{Number(p.taxRate) ? `${plain(p.taxRate)}%` : <span className="text-text-3">—</span>}</td>
                    <td className={cn(TD, "whitespace-nowrap text-text-3")} title={f.dateTime(p.updatedAt)}>
                      {f.smart(p.updatedAt)}
                    </td>
                    <td className={cn(TD, "w-10 text-right")}>
                      {canManage && (
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <IconButton size="sm" label={`More for ${p.name}`} icon={<Ellipsis />} />
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem icon={p.synced ? <Eye /> : <Pencil />} onSelect={() => setEditing(p)}>
                              {p.synced ? "View" : "Edit"}
                            </DropdownMenuItem>
                            {!p.synced && (
                              <>
                                <DropdownMenuItem icon={p.archived ? <ArchiveRestore /> : <Archive />} onSelect={() => archive.mutate({ id: p.id, archived: !p.archived })}>
                                  {p.archived ? "Restore" : "Archive"}
                                </DropdownMenuItem>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem danger icon={<Trash2 />} onSelect={() => setDeleting(p)}>
                                  Delete
                                </DropdownMenuItem>
                              </>
                            )}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      )}
                    </td>
                  </tr>
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  }

  const synced = rows.some((p) => p.synced);

  return (
    <Page width="full">
      <PageHeader
        title="Products"
        icon={<IconTile icon={<Package />} tint="brown" size="lg" />}
        description={list.data ? `${formatNumber(list.data.total)} ${state === "archived" ? "archived" : q ? "matching" : "in the catalogue"}` : "What you sell, ready to pick on a quote."}
        actions={
          canManage ? (
            <Button variant="primary" icon={<Plus />} onClick={() => setCreating(true)}>
              New product
            </Button>
          ) : undefined
        }
      />
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <SearchInput
          value={q}
          onChange={(v) => {
            setQ(v);
            setPage(1);
          }}
          placeholder="Search name, SKU, group…"
          className="w-full sm:w-80"
        />
        <NativeSelect
          size="sm"
          className="w-36"
          aria-label="Show"
          value={state}
          onChange={(e) => {
            setState(e.target.value as State);
            setPage(1);
          }}
          options={[
            { value: "active", label: "Active" },
            { value: "archived", label: "Archived" },
            { value: "all", label: "All" },
          ]}
        />
        {synced && (
          <Tooltip content="Products from the client portal are kept in step by its catalog sync. Change them there; quote lines use them like any product.">
            <span className="inline-flex items-center gap-1.5 text-xs text-text-3">
              <RefreshCw aria-hidden className="size-3.5" />
              Some products are synced
            </span>
          </Tooltip>
        )}
      </div>

      <Card className="overflow-hidden">{body}</Card>

      {list.data && list.data.total > pageSize && (
        <Pagination className="mt-3" page={page} pageSize={pageSize} total={list.data.total} pageSizes={PAGE_SIZES} onPageChange={setPage} onPageSizeChange={(n) => (setPageSize(n), setPage(1))} />
      )}

      <ProductModal open={creating || editing !== null} onOpenChange={(o) => (o ? undefined : (setCreating(false), setEditing(null)))} product={editing} />
      {deleting && (
        <ConfirmDialog
          open
          onOpenChange={(o) => !o && setDeleting(null)}
          title={`Delete “${deleting.name}”?`}
          description="Quotes that used it keep their lines as written. To hide it from the quote editor but keep it, archive it instead."
          onConfirm={() => remove.mutateAsync(deleting.id)}
        />
      )}
    </Page>
  );
}
