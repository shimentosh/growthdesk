"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import { Archive, ArchiveRestore, ArrowDown, ArrowUp, ArrowUpRight, ChevronsUpDown, Ellipsis, FileQuestion, ListChecks, Pencil, SearchX } from "lucide-react";
import { BulkActionsBar } from "@/components/crm/BulkActionsBar";
import { FilterChips, FilterPopover, SavedViewsMenu } from "@/components/crm/ContactFilters";
import { LIST_WRITE, StageBadge } from "@/components/crm/lifecycle";
import { EditContactModal } from "@/components/crm/NewContactModal";
import { AddToListModal } from "@/components/marketing/AddToListModal";
import { TagList } from "@/components/crm/Tags";
import { PAGE_SIZES, activeFilterCount, toFilter, type ContactListState, type SortField } from "@/components/crm/contactListState";
import { contactLabel } from "@/components/pickers/Pickers";
import { Avatar } from "@/components/ui/Avatar";
import { Badge, StatusBadge } from "@/components/ui/Badge";
import { Button, IconButton } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Checkbox } from "@/components/ui/Checkbox";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/DropdownMenu";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { Pagination } from "@/components/ui/Pagination";
import { SearchInput } from "@/components/ui/SearchInput";
import { Skeleton } from "@/components/ui/Skeleton";
import { cn } from "@/lib/cn";
import type { ContactFilterT } from "@growthdesk/shared";
import { useApiMutation, useApiQuery } from "@/lib/query";
import { useFormat, useWorkspace } from "@/lib/session";
import type { Paged } from "@/lib/types";
import type { BulkResult, Contact } from "@/lib/types/crm";

type Update = (patch: Partial<ContactListState>, opts?: { replace?: boolean }) => void;

const TH = "h-9 px-3 text-left text-xs font-medium whitespace-nowrap text-text-3";
const TD = "px-3 py-2 align-middle";

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

/** The `filter` the page asks GET /contacts for (also used for the export link). */
export function useContactQuery(state: ContactListState) {
  const ws = useWorkspace();
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
  return { contacts, query, filter: filter as ContactFilterT | undefined };
}

/**
 * The people table shared by Contacts and Leads: search, filters, the bulk
 * bar, the sortable table and pagination. The page owns the header, the
 * stage/list/archived controls (`controls`) and the empty state.
 */
export function ContactListView({
  state,
  update,
  clearFilters,
  contacts,
  query,
  controls,
  empty,
  noun = "contacts",
  leads = false,
  showStage = false,
  savedViews = true,
}: {
  state: ContactListState;
  update: Update;
  clearFilters: () => void;
  contacts: ReturnType<typeof useContactQuery>["contacts"];
  query: ReturnType<typeof useContactQuery>["query"];
  /** Page-specific controls in the toolbar (stage tabs, list picker, archived switch). */
  controls?: ReactNode;
  /** Shown when nothing exists at all (no search or filter narrowing). */
  empty: ReactNode;
  noun?: string;
  leads?: boolean;
  /** Show the lifecycle stage column (when more than one stage is listed). */
  showStage?: boolean;
  savedViews?: boolean;
}) {
  const ws = useWorkspace();
  const f = useFormat();
  const router = useRouter();

  // Selection belongs to one page of one query; a new query starts empty.
  const scope = JSON.stringify(query);
  const [selection, setSelection] = useState<{ scope: string; ids: Set<string> }>({ scope, ids: new Set() });
  const selected = selection.scope === scope ? selection.ids : new Set<string>();
  const setSelected = (ids: Set<string>) => setSelection({ scope, ids });

  const rows = contacts.data?.items ?? [];
  const allOnPage = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const someOnPage = rows.some((r) => selected.has(r.id));
  const canWrite = ws.can("contacts.write");
  const canList = ws.can(LIST_WRITE);
  const narrowed = activeFilterCount(state) > 0 || Boolean(state.q) || Boolean(state.view) || Boolean(state.listId) || state.archived === "only";
  const onSort = (field: SortField, dir: "asc" | "desc") => update({ sort: field, dir });

  // Row actions: one dialog of each kind for the whole table, opened for the row's contact.
  const [editing, setEditing] = useState<Contact | null>(null);
  const [listing, setListing] = useState<Contact | null>(null);
  const archive = useApiMutation<BulkResult, { action: "archive" | "unarchive"; ids: string[] }>({
    path: ws.path("/contacts/bulk"),
    invalidate: [ws.key("contacts"), ws.key("companies")],
    success: (_r, v) => (v.action === "archive" ? "Archived" : "Restored"),
  });

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
        title={state.archived === "only" && !activeFilterCount(state) && !state.q ? `No archived ${noun}` : `No ${noun} match`}
        description="Try a different search or remove a filter."
        action={
          <Button
            size="sm"
            onClick={() => (state.view ? update({ view: "" }) : state.archived && !activeFilterCount(state) && !state.q ? update({ archived: "" }) : clearFilters())}
          >
            {state.view && !activeFilterCount(state) && !state.q ? `Show all ${noun}` : state.archived && !activeFilterCount(state) && !state.q ? "Hide archived" : "Clear filters"}
          </Button>
        }
      />
    ) : (
      empty
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
              {showStage && (
                <th scope="col" className={TH}>
                  Stage
                </th>
              )}
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
              <th scope="col" className="w-10 px-2">
                <span className="sr-only">Actions</span>
              </th>
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
                        <span className="flex min-w-0 items-center gap-1.5">
                          <span className="truncate font-medium text-text group-hover:text-accent-hi">{contactLabel(c)}</span>
                          {c.archivedAt && <Badge>Archived</Badge>}
                        </span>
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
                  {showStage && (
                    <td className={TD}>
                      <StageBadge stage={c.lifecycleStage} />
                    </td>
                  )}
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
                  <td className="w-10 px-2 text-right">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <IconButton size="sm" label={`Actions for ${contactLabel(c)}`} icon={<Ellipsis />} />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        {canWrite && (
                          <DropdownMenuItem icon={<Pencil />} onSelect={() => setEditing(c)}>
                            Edit…
                          </DropdownMenuItem>
                        )}
                        {canList && !c.archivedAt && (
                          <DropdownMenuItem icon={<ListChecks />} onSelect={() => setListing(c)}>
                            Add to list…
                          </DropdownMenuItem>
                        )}
                        <DropdownMenuItem icon={<ArrowUpRight />} onSelect={() => router.push(ws.href(`/contacts/${c.id}`))}>
                          Open record
                        </DropdownMenuItem>
                        {canWrite && (
                          <>
                            <DropdownMenuSeparator />
                            {c.archivedAt ? (
                              <DropdownMenuItem icon={<ArchiveRestore />} onSelect={() => archive.mutate({ action: "unarchive", ids: [c.id] })}>
                                Restore
                              </DropdownMenuItem>
                            ) : (
                              <DropdownMenuItem icon={<Archive />} onSelect={() => archive.mutate({ action: "archive", ids: [c.id] })}>
                                Archive
                              </DropdownMenuItem>
                            )}
                          </>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
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
      <div className="mb-3 flex flex-col gap-2">
        {controls && <div className="flex flex-wrap items-center gap-2">{controls}</div>}
        <div className="flex flex-wrap items-center gap-2">
          <SearchInput
            value={state.q}
            onChange={(q) => update({ q }, { replace: true })}
            placeholder="Search name, email, phone, title, company…"
            className="w-full sm:w-80"
          />
          <FilterPopover state={state} update={update} />
          {savedViews && <SavedViewsMenu state={state} update={update} />}
        </div>
        <FilterChips state={state} update={update} clear={clearFilters} />
      </div>

      {selected.size > 0 && canWrite && (
        <div className="mb-3">
          <BulkActionsBar
            ids={[...selected]}
            archived={state.archived === "only"}
            leads={leads}
            onDone={() => setSelected(new Set())}
            onClear={() => setSelected(new Set())}
          />
        </div>
      )}

      <Card className="overflow-hidden">{body}</Card>

      {editing && <EditContactModal key={editing.id} open onOpenChange={(o) => !o && setEditing(null)} contact={editing} />}
      {canList && (
        <AddToListModal
          key={listing?.id ?? "none"}
          open={listing !== null}
          onOpenChange={(o) => !o && setListing(null)}
          contactIds={listing ? [listing.id] : []}
          contactsLabel={listing ? contactLabel(listing) : undefined}
        />
      )}

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
    </>
  );
}

/** A row of segment buttons (the status-tab look used across list pages). */
export function Segments<V extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: V;
  options: { value: V; label: string }[];
  onChange: (value: V) => void;
}) {
  return (
    <div role="tablist" aria-label={label} className="-mx-1 flex gap-1 overflow-x-auto px-1">
      {options.map((o) => (
        <button
          key={o.value || "all"}
          type="button"
          role="tab"
          aria-selected={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            "h-7 shrink-0 rounded-sm px-2.5 text-xs font-medium whitespace-nowrap",
            value === o.value ? "bg-accent-soft text-accent-ink" : "text-text-2 hover:bg-hover hover:text-text",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
