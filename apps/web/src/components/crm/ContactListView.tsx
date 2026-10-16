"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState, type MouseEvent, type ReactNode } from "react";
import { Archive, ArchiveRestore, ArrowDown, ArrowUp, ArrowUpRight, ChevronsUpDown, Ellipsis, FileQuestion, ListChecks, Pencil, SearchX, type LucideIcon } from "lucide-react";
import { BulkActionsBar } from "@/components/crm/BulkActionsBar";
import { CompanyMark, OwnerCell, PriorityIndicator, QualificationChip, ScoreMeter, StatusChip } from "@/components/crm/ContactCells";
import { ContactPeek } from "@/components/crm/ContactPeek";
import { FilterChips, FilterPopover, SavedViewsMenu } from "@/components/crm/ContactFilters";
import { LIST_WRITE, StageBadge } from "@/components/crm/lifecycle";
import { EditContactModal } from "@/components/crm/NewContactModal";
import { AddToListModal } from "@/components/marketing/AddToListModal";
import { TagList } from "@/components/crm/Tags";
import { PAGE_SIZES, activeFilterCount, toFilter, type ContactListState, type SortField } from "@/components/crm/contactListState";
import { contactLabel } from "@/components/pickers/Pickers";
import { Avatar } from "@/components/ui/Avatar";
import { Badge } from "@/components/ui/Badge";
import { Button, IconButton } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Checkbox } from "@/components/ui/Checkbox";
import { COL, ColumnLabel } from "@/components/ui/columns";
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
  icon: ColIcon,
  sort,
  dir,
  onSort,
  className,
}: {
  field: SortField;
  label: string;
  icon?: LucideIcon;
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
        <span className="inline-flex items-center gap-1.5">
          {ColIcon && <ColIcon aria-hidden className="size-3.5 shrink-0 opacity-70" strokeWidth={1.75} />}
          {label}
        </span>
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
  const pathname = usePathname();
  const params = useSearchParams();

  // The record open in the side panel lives in the URL (?peek=<id>), so reload and Back keep it.
  const peekId = params.get("peek");
  const setPeek = (id: string | null) => {
    const q = new URLSearchParams(params.toString());
    if (id) q.set("peek", id);
    else q.delete("peek");
    const qs = q.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };
  /** A click anywhere on a row opens the panel — except on its own controls (checkbox, links, menus). */
  const onRowClick = (e: MouseEvent<HTMLTableRowElement>, id: string) => {
    if ((e.target as HTMLElement).closest("a, button, input, label, [role=checkbox], [role=menuitem], [data-no-peek]")) return;
    if (window.getSelection()?.toString()) return;
    setPeek(id);
  };
  /** The name opens the panel too; Cmd/Ctrl/Shift-click or a middle click still opens the full record. */
  const onNameClick = (e: MouseEvent<HTMLAnchorElement>, id: string) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    setPeek(id);
  };

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
              <SortHeader field="fullName" label="Name" icon={COL.name} sort={state.sort} dir={state.dir} onSort={onSort} />
              <th scope="col" className={TH}>
                <ColumnLabel icon={COL.company}>Company</ColumnLabel>
              </th>
              {showStage && (
                <th scope="col" className={TH}>
                  <ColumnLabel icon={COL.stage}>Stage</ColumnLabel>
                </th>
              )}
              <th scope="col" className={TH}>
                <ColumnLabel icon={COL.status}>Status</ColumnLabel>
              </th>
              <th scope="col" className={TH}>
                <ColumnLabel icon={COL.qualification}>Qualification</ColumnLabel>
              </th>
              <SortHeader field="priority" label="Priority" icon={COL.priority} sort={state.sort} dir={state.dir} onSort={onSort} />
              <th scope="col" className={TH}>
                <ColumnLabel icon={COL.owner}>Owner</ColumnLabel>
              </th>
              <th scope="col" className={TH}>
                <ColumnLabel icon={COL.tags}>Tags</ColumnLabel>
              </th>
              <SortHeader field="score" label="Score" icon={COL.score} sort={state.sort} dir={state.dir} onSort={onSort} />
              <SortHeader field="lastContactedAt" label="Last contacted" icon={COL.updated} sort={state.sort} dir={state.dir} onSort={onSort} />
              <SortHeader field="nextActionAt" label="Next action" icon={COL.due} sort={state.sort} dir={state.dir} onSort={onSort} />
              <SortHeader field="createdAt" label="Created" icon={COL.created} sort={state.sort} dir={state.dir} onSort={onSort} />
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
                <tr
                  key={c.id}
                  onClick={(e) => onRowClick(e, c.id)}
                  className={cn("cursor-pointer transition-colors hover:bg-hover", isSel && "bg-tint-pick", peekId === c.id && "bg-tint-pick-hi shadow-[inset_2px_0_0_var(--tint-blue)]")}
                >
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
                    <Link href={ws.href(`/contacts/${c.id}`)} onClick={(e) => onNameClick(e, c.id)} className="group flex min-w-0 items-center gap-2.5">
                      <Avatar size="md" name={c.fullName} email={c.email} />
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
                      <Link href={ws.href(`/companies/${c.company.id}`)} className="flex min-w-0 items-center gap-2 text-text-2 hover:text-accent-hi">
                        <CompanyMark name={c.company.name} />
                        <span className="truncate">{c.company.name}</span>
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
                    <StatusChip value={c.status} />
                  </td>
                  <td className={TD}>
                    <QualificationChip value={c.qualification} />
                  </td>
                  <td className={TD}>
                    <PriorityIndicator value={c.priority} />
                  </td>
                  <td className={cn(TD, "max-w-44")}>
                    <OwnerCell owner={c.owner} />
                  </td>
                  <td className={cn(TD, "max-w-56")}>
                    {/* One tag and a +N count keeps every row one line high. */}
                    <TagList tags={c.tags} max={1} wrap={false} />
                  </td>
                  <td className={TD}>
                    <ScoreMeter value={c.score} />
                  </td>
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

      <ContactPeek
        id={peekId}
        ids={rows.map((r) => r.id)}
        summary={rows.find((r) => r.id === peekId)}
        onOpenChange={(o) => !o && setPeek(null)}
        onMove={(id) => setPeek(id)}
      />

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
  /** `icon`: a small icon before the word (a LucideIcon), shown muted until the tab is chosen. */
  options: { value: V; label: string; icon?: LucideIcon }[];
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
            "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-sm px-2.5 text-xs font-medium whitespace-nowrap",
            value === o.value ? "bg-accent-soft text-accent-ink" : "text-text-2 hover:bg-hover hover:text-text",
          )}
        >
          {o.icon && <o.icon aria-hidden className={cn("size-3.5 shrink-0", value !== o.value && "opacity-70")} strokeWidth={1.75} />}
          {o.label}
        </button>
      ))}
    </div>
  );
}
