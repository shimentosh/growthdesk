"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Suspense, useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, ChevronsUpDown, Copy, Download, FileQuestion, Plus, SearchX, Upload, Users } from "lucide-react";
import { BulkActionsBar } from "@/components/crm/BulkActionsBar";
import { FilterChips, FilterPopover, SavedViewsMenu } from "@/components/crm/ContactFilters";
import { NewContactModal } from "@/components/crm/NewContactModal";
import { TagList } from "@/components/crm/Tags";
import { PAGE_SIZES, activeFilterCount, toFilter, useContactListState, type SortField } from "@/components/crm/contactListState";
import { contactLabel } from "@/components/pickers/Pickers";
import { Avatar } from "@/components/ui/Avatar";
import { StatusBadge } from "@/components/ui/Badge";
import { Button, buttonClass } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Checkbox } from "@/components/ui/Checkbox";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { EntityTile } from "@/components/ui/icons";
import { Page, PageHeader } from "@/components/ui/PageHeader";
import { Pagination } from "@/components/ui/Pagination";
import { RequirePermission } from "@/components/ui/RequirePermission";
import { SearchInput } from "@/components/ui/SearchInput";
import { LoadingBlock, Skeleton } from "@/components/ui/Skeleton";
import { withQuery } from "@/lib/api";
import { cn } from "@/lib/cn";
import { formatNumber } from "@/lib/format";
import { useApiQuery } from "@/lib/query";
import { useFormat, useWorkspace } from "@/lib/session";
import type { Paged } from "@/lib/types";
import type { Contact } from "@/lib/types/crm";

export default function ContactsPage() {
  return (
    <RequirePermission permission="contacts.read">
      {/* useSearchParams needs a Suspense boundary above it. */}
      <Suspense fallback={<LoadingBlock />}>
        <Contacts />
      </Suspense>
    </RequirePermission>
  );
}

function SortHeader({
  field,
  label,
  sort,
  dir,
  onSort,
  className,
}: {
  field: SortField;
  label: string;
  sort: SortField;
  dir: "asc" | "desc";
  onSort: (field: SortField, dir: "asc" | "desc") => void;
  className?: string;
}) {
  const active = sort === field;
  const Icon = !active ? ChevronsUpDown : dir === "asc" ? ArrowUp : ArrowDown;
  return (
    <th scope="col" aria-sort={active ? (dir === "asc" ? "ascending" : "descending") : "none"} className={cn(TH, className)}>
      <button
        type="button"
        onClick={() => onSort(field, active ? (dir === "asc" ? "desc" : "asc") : field === "fullName" ? "asc" : "desc")}
        className={cn("inline-flex items-center gap-1 hover:text-text", active && "text-text")}
      >
        {label}
        <Icon aria-hidden className={cn("size-3", !active && "opacity-50")} />
      </button>
    </th>
  );
}

const TH = "h-9 px-3 text-left text-xs font-medium whitespace-nowrap text-text-3";
const TD = "px-3 py-2 align-middle";

function Contacts() {
  const ws = useWorkspace();
  const f = useFormat();
  const router = useRouter();
  const { state, update, clearFilters } = useContactListState();
  const [creating, setCreating] = useState(false);

  const filter = toFilter(state);
  const query = {
    page: state.page,
    pageSize: state.pageSize,
    sort: state.sort,
    dir: state.dir,
    filter,
    viewId: state.view || undefined,
  };
  const contacts = useApiQuery<Paged<Contact>>(ws.key("contacts", "list"), ws.path("/contacts"), { query, keepPrevious: true });

  // Selection belongs to one page of one query; a new query starts empty.
  const scope = JSON.stringify(query);
  const [selection, setSelection] = useState<{
    scope: string;
    ids: Set<string>;
  }>({ scope, ids: new Set() });
  const selected = selection.scope === scope ? selection.ids : new Set<string>();
  const setSelected = (ids: Set<string>) => setSelection({ scope, ids });

  const rows = contacts.data?.items ?? [];
  const allOnPage = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const someOnPage = rows.some((r) => selected.has(r.id));
  const canWrite = ws.can("contacts.write");
  const narrowed = activeFilterCount(state) > 0 || Boolean(state.q) || Boolean(state.view);

  const exportHref = withQuery(`/api${ws.path("/contacts/export")}`, {
    filter,
    viewId: state.view || undefined,
  });

  const onSort = (field: SortField, dir: "asc" | "desc") => update({ sort: field, dir });

  let body: ReactNode;
  if (contacts.isPending) {
    body = (
      <div className="flex flex-col gap-2 p-4" aria-busy>
        {Array.from({ length: 8 }, (_, i) => (
          <Skeleton key={i} className="h-8" />
        ))}
      </div>
    );
  } else if (contacts.isError && !contacts.data) {
    body = <ErrorState error={contacts.error} onRetry={() => void contacts.refetch()} />;
  } else if (!rows.length && state.page > 1 && (contacts.data?.total ?? 0) > 0) {
    // Past the last page (e.g. after deleting the rows that were on it).
    body = (
      <EmptyState
        icon={<FileQuestion />}
        title="This page is empty"
        action={
          <Button size="sm" onClick={() => update({ page: 1 })}>
            Go to the first page
          </Button>
        }
      />
    );
  } else if (!rows.length) {
    body = narrowed ? (
      <EmptyState
        icon={<SearchX />}
        title="No contacts match"
        description="Try a different search or remove a filter."
        action={
          <Button size="sm" onClick={() => (state.view ? update({ view: "" }) : clearFilters())}>
            {state.view && !activeFilterCount(state) && !state.q ? "Show all contacts" : "Clear filters"}
          </Button>
        }
      />
    ) : (
      <EmptyState
        icon={<Users />}
        tint="indigo"
        title="No contacts yet"
        description="Add people one at a time, or import a CSV from another tool."
        action={
          <>
            {canWrite && (
              <Button size="sm" variant="primary" icon={<Plus />} onClick={() => setCreating(true)}>
                New contact
              </Button>
            )}
            {ws.can("contacts.import") && (
              <Button size="sm" icon={<Upload />} href={ws.href("/imports")}>
                Import CSV
              </Button>
            )}
          </>
        }
      />
    );
  } else {
    body = (
      <div className={cn("overflow-x-auto transition-opacity", contacts.isFetching && contacts.isPlaceholderData && "opacity-60")}>
        <table className="w-full min-w-[1080px] border-collapse text-sm">
          <thead className="border-b border-line bg-s-2">
            <tr>
              {canWrite && (
                <th scope="col" className="w-10 px-3">
                  <Checkbox
                    aria-label="Select all on this page"
                    checked={allOnPage ? true : someOnPage ? "indeterminate" : false}
                    onCheckedChange={(c) => setSelected(c ? new Set(rows.map((r) => r.id)) : new Set())}
                  />
                </th>
              )}
              <SortHeader field="fullName" label="Name" sort={state.sort} dir={state.dir} onSort={onSort} />
              <th scope="col" className={TH}>
                Company
              </th>
              <th scope="col" className={TH}>
                Status
              </th>
              <th scope="col" className={TH}>
                Qualification
              </th>
              <SortHeader field="priority" label="Priority" sort={state.sort} dir={state.dir} onSort={onSort} />
              <th scope="col" className={TH}>
                Owner
              </th>
              <th scope="col" className={TH}>
                Tags
              </th>
              <SortHeader field="score" label="Score" sort={state.sort} dir={state.dir} onSort={onSort} />
              <SortHeader field="lastContactedAt" label="Last contacted" sort={state.sort} dir={state.dir} onSort={onSort} />
              <SortHeader field="nextActionAt" label="Next action" sort={state.sort} dir={state.dir} onSort={onSort} />
              <SortHeader field="createdAt" label="Created" sort={state.sort} dir={state.dir} onSort={onSort} />
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows.map((c) => {
              const isSel = selected.has(c.id);
              const overdue = c.nextActionAt ? new Date(c.nextActionAt).getTime() < Date.now() : false;
              return (
                <tr key={c.id} className={cn("hover:bg-hover", isSel && "bg-tint-pick")}>
                  {canWrite && (
                    <td className="w-10 px-3">
                      <Checkbox
                        aria-label={`Select ${contactLabel(c)}`}
                        checked={isSel}
                        onCheckedChange={(v) => {
                          const next = new Set(selected);
                          if (v) next.add(c.id);
                          else next.delete(c.id);
                          setSelected(next);
                        }}
                      />
                    </td>
                  )}
                  <td className={cn(TD, "max-w-64")}>
                    <Link href={ws.href(`/contacts/${c.id}`)} className="group flex min-w-0 items-center gap-2">
                      <Avatar size="sm" name={c.fullName} email={c.email} />
                      <span className="min-w-0">
                        <span className="block truncate font-medium text-text group-hover:text-accent-hi">{contactLabel(c)}</span>
                        {(c.email || c.jobTitle) && <span className="block truncate text-xs text-text-3">{c.email || c.jobTitle}</span>}
                      </span>
                    </Link>
                  </td>
                  <td className={cn(TD, "max-w-48")}>
                    {c.company ? (
                      <Link href={ws.href(`/companies/${c.company.id}`)} className="block truncate text-text-2 hover:text-accent-hi">
                        {c.company.name}
                      </Link>
                    ) : (
                      <span className="text-text-3">—</span>
                    )}
                  </td>
                  <td className={TD}>
                    <StatusBadge value={c.status} />
                  </td>
                  <td className={TD}>
                    <StatusBadge value={c.qualification} dot={false} />
                  </td>
                  <td className={TD}>
                    <StatusBadge value={c.priority} dot={false} />
                  </td>
                  <td className={cn(TD, "max-w-40 truncate text-text-2")}>{c.owner?.name ?? <span className="text-text-3">Unassigned</span>}</td>
                  <td className={cn(TD, "max-w-56")}>
                    <TagList tags={c.tags} max={2} />
                  </td>
                  <td className={cn(TD, "text-text-2 tabular-nums")}>{c.score ?? <span className="text-text-3">—</span>}</td>
                  <td className={cn(TD, "whitespace-nowrap text-text-2")} title={c.lastContactedAt ? f.dateTime(c.lastContactedAt) : undefined}>
                    {c.lastContactedAt ? f.relative(c.lastContactedAt) : <span className="text-text-3">Never</span>}
                  </td>
                  <td className={cn(TD, "whitespace-nowrap", overdue ? "text-bad-ink" : "text-text-2")} title={c.nextActionNote || undefined}>
                    {c.nextActionAt ? f.smart(c.nextActionAt) : <span className="text-text-3">—</span>}
                  </td>
                  <td className={cn(TD, "whitespace-nowrap text-text-3")} title={f.dateTime(c.createdAt)}>
                    {f.smart(c.createdAt)}
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
    <Page width="full">
      <PageHeader
        title="Contacts"
        icon={<EntityTile of="contacts" />}
        description={
          contacts.data ? `${formatNumber(contacts.data.total)} ${narrowed ? "matching" : "in this workspace"}` : "Everyone you are talking to, or plan to."
        }
        actions={
          <>
            <Button icon={<Copy />} href={ws.href("/contacts/duplicates")}>
              Duplicates
            </Button>
            {ws.can("contacts.export") && (
              <a href={exportHref} download className={buttonClass()} title="Download the contacts matching these filters as CSV">
                <Download aria-hidden />
                Export CSV
              </a>
            )}
            {canWrite && (
              <Button variant="primary" icon={<Plus />} onClick={() => setCreating(true)}>
                New contact
              </Button>
            )}
          </>
        }
      />

      <div className="mb-3 flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <SearchInput
            value={state.q}
            onChange={(q) => update({ q }, { replace: true })}
            placeholder="Search name, email, phone, title, company…"
            className="w-full sm:w-80"
          />
          <FilterPopover state={state} update={update} />
          <SavedViewsMenu state={state} update={update} />
        </div>
        <FilterChips state={state} update={update} clear={clearFilters} />
      </div>

      {selected.size > 0 && canWrite && (
        <div className="mb-3">
          <BulkActionsBar ids={[...selected]} onDone={() => setSelected(new Set())} onClear={() => setSelected(new Set())} />
        </div>
      )}

      <Card className="overflow-hidden">{body}</Card>

      {contacts.data && contacts.data.total > 0 && (
        <Pagination
          className="mt-3"
          page={state.page}
          pageSize={state.pageSize}
          total={contacts.data.total}
          pageSizes={PAGE_SIZES}
          onPageChange={(page) => update({ page })}
          onPageSizeChange={(pageSize) => update({ pageSize })}
        />
      )}

      <NewContactModal open={creating} onOpenChange={setCreating} onCreated={(c) => router.push(ws.href(`/contacts/${c.id}`))} />
    </Page>
  );
}
