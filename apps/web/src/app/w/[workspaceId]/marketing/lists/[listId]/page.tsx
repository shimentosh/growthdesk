"use client";

import Link from "next/link";
import { useParams, usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState, type ReactNode } from "react";
import { Archive, ArchiveRestore, Clock, Pencil, SearchX, SquareCheckBig, Upload, UserCheck, UserMinus, UserPlus, Users, X } from "lucide-react";
import { LIST_MEMBERSHIP_STATUSES, type ListMembershipStatus } from "@growthdesk/shared";
import { LIST_READ, LIST_WRITE } from "@/components/crm/lifecycle";
import { AddToListModal } from "@/components/marketing/AddToListModal";
import { MembershipBadge, useMarketing } from "@/components/marketing/common";
import { ListFormModal } from "@/components/marketing/lists/ListFormModal";
import { useArchiveList } from "@/components/marketing/lists/useArchiveList";
import { Avatar } from "@/components/ui/Avatar";
import { Badge, StatusBadge } from "@/components/ui/Badge";
import { Button, IconButton } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Card } from "@/components/ui/Card";
import { Checkbox } from "@/components/ui/Checkbox";
import { COL, ColumnLabel } from "@/components/ui/columns";
import { ConfirmDialog } from "@/components/ui/Dialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState, QueryState } from "@/components/ui/ErrorState";
import { ENTITY, EntityTile } from "@/components/ui/icons";
import { Page, PageHeader } from "@/components/ui/PageHeader";
import { Pagination } from "@/components/ui/Pagination";
import { RequirePermission } from "@/components/ui/RequirePermission";
import { SearchInput } from "@/components/ui/SearchInput";
import { LoadingBlock, Skeleton, SkeletonText } from "@/components/ui/Skeleton";
import { StatCard } from "@/components/ui/StatCard";
import { Tooltip } from "@/components/ui/Tooltip";
import { cn } from "@/lib/cn";
import { formatNumber } from "@/lib/format";
import { useApiMutation, useApiQuery } from "@/lib/query";
import { useFormat, useWorkspace } from "@/lib/session";
import type { ListMember, MarketingList, Paged, RemoveMembersResult } from "@/lib/types/marketing";

export default function MarketingListPage() {
  return (
    <Page>
      <RequirePermission permission={LIST_READ}>
        <Suspense fallback={<LoadingBlock />}>
          <ListLoader />
        </Suspense>
      </RequirePermission>
    </Page>
  );
}

const PAGE_SIZES = [25, 50, 100, 200];
const TH = "h-9 px-3 text-left text-xs font-medium whitespace-nowrap text-text-3";
const TD = "px-3 py-2 align-middle";
const STATUS_LABEL: Record<ListMembershipStatus, string> = { subscribed: "Subscribed", unsubscribed: "Unsubscribed", pending: "Pending" };
const STATUS_ICON = { subscribed: COL.subscribed, unsubscribed: COL.unsubscribed, pending: COL.pending } satisfies Record<ListMembershipStatus, unknown>;
const ListGlyph = ENTITY.lists.icon;

const people = (n: number) => `${formatNumber(n)} ${n === 1 ? "person" : "people"}`;

/** Search, status and page of the members table live in the URL (?q=&status=&page=&pageSize=). */
function useMemberParams() {
  const sp = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const page = Number(sp.get("page"));
  const pageSize = Number(sp.get("pageSize"));
  const status = sp.get("status") ?? "";
  const state = {
    q: sp.get("q") ?? "",
    status: ((LIST_MEMBERSHIP_STATUSES as readonly string[]).includes(status) ? status : "") as ListMembershipStatus | "",
    page: Number.isInteger(page) && page > 0 ? page : 1,
    pageSize: PAGE_SIZES.includes(pageSize) ? pageSize : 50,
  };
  const toUrl = (patch: Partial<typeof state>) => {
    const next = { ...state, ...patch };
    if (!("page" in patch)) next.page = 1;
    const p = new URLSearchParams();
    if (next.q.trim()) p.set("q", next.q.trim());
    if (next.status) p.set("status", next.status);
    if (next.page > 1) p.set("page", String(next.page));
    if (next.pageSize !== 50) p.set("pageSize", String(next.pageSize));
    const qs = p.toString();
    return qs ? `${pathname}?${qs}` : pathname;
  };
  const update = (patch: Partial<typeof state>) => router.replace(toUrl(patch), { scroll: false });
  return { state, update, toUrl };
}

function ListLoader() {
  const mk = useMarketing();
  const { listId } = useParams<{ listId: string }>();
  const list = useApiQuery<MarketingList>(mk.key("lists", listId), mk.path(`/lists/${listId}`));
  return (
    <QueryState
      query={list}
      loading={
        <Card className="p-4">
          <SkeletonText lines={6} />
        </Card>
      }
    >
      {(l) => <ListWorkspace list={l} />}
    </QueryState>
  );
}

function ListWorkspace({ list }: { list: MarketingList }) {
  const ws = useWorkspace();
  const mk = useMarketing();
  const f = useFormat();
  const { state, update, toUrl } = useMemberParams();
  const canWrite = ws.can(LIST_WRITE);
  const archived = Boolean(list.archivedAt);
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [removing, setRemoving] = useState<string[] | null>(null);
  const archive = useArchiveList();

  const members = useApiQuery<Paged<ListMember>>(mk.key("lists", list.id, "members"), mk.path(`/lists/${list.id}/members`), {
    query: { q: state.q || undefined, status: state.status || undefined, page: state.page, pageSize: state.pageSize },
    keepPrevious: true,
  });
  const rows = members.data?.items ?? [];

  // Selection holds contact ids and belongs to one filter + page; changing either starts afresh.
  const scope = JSON.stringify(state);
  const [selection, setSelection] = useState<{ scope: string; ids: Set<string> }>({ scope, ids: new Set() });
  const selected = selection.scope === scope ? selection.ids : new Set<string>();
  const setSelected = (ids: Set<string>) => setSelection({ scope, ids });
  // Unsubscribed rows stay as the record that keeps them off the list, so they are not removable.
  const selectable = rows.filter((m) => m.status !== "unsubscribed");
  const allOnPage = selectable.length > 0 && selectable.every((m) => selected.has(m.contact.id));
  const someOnPage = selectable.some((m) => selected.has(m.contact.id));

  const remove = useApiMutation<RemoveMembersResult, { contactIds: string[] }>({
    path: mk.path(`/lists/${list.id}/members/remove`),
    invalidate: [mk.key("lists"), mk.key("contacts")],
    success: (r) =>
      r.keptUnsubscribed > 0
        ? `Removed ${formatNumber(r.removed)}. ${formatNumber(r.keptUnsubscribed)} kept because they unsubscribed themselves.`
        : `${people(r.removed)} removed from ${list.name}`,
    errorToast: false,
    onSuccess: () => setSelected(new Set()),
  });

  const total = list.counts.subscribed + list.counts.unsubscribed + list.counts.pending;
  const showPending = list.doubleOptIn || list.counts.pending > 0 || state.status === "pending";
  const filtered = Boolean(state.q || state.status);

  let body: ReactNode;
  if (members.isPending) {
    body = (
      <div className="flex flex-col gap-2 p-4" aria-busy>
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="h-9" />
        ))}
      </div>
    );
  } else if (members.isError && !members.data) {
    body = <ErrorState error={members.error} onRetry={() => void members.refetch()} />;
  } else if (!rows.length) {
    body = filtered ? (
      <EmptyState
        compact
        icon={<SearchX />}
        title="No members match"
        description="Search looks at the contact's name and email."
        action={
          <Button size="sm" icon={<X />} onClick={() => update({ q: "", status: "" })}>
            Clear filters
          </Button>
        }
      />
    ) : (
      <EmptyState
        icon={<ListGlyph />}
        tint={ENTITY.lists.tint}
        title="No one on this list yet"
        description={
          canWrite && !archived
            ? "Import a CSV into this list, or add people here, from the Leads or Contacts table, or from a contact's page."
            : "Nobody has been added to this list."
        }
        action={
          canWrite && !archived ? (
            <Button variant="primary" icon={<UserPlus />} onClick={() => setAdding(true)}>
              Add contacts
            </Button>
          ) : undefined
        }
      />
    );
  } else {
    body = (
      <div className={cn("overflow-x-auto transition-opacity", members.isFetching && members.isPlaceholderData && "opacity-60")}>
        <table className="w-full min-w-[820px] border-collapse text-sm">
          <thead className="border-b border-line bg-s-2">
            <tr>
              {canWrite && (
                <th scope="col" className="w-10 px-3">
                  <Checkbox
                    aria-label="Select all on this page"
                    disabled={!selectable.length}
                    checked={allOnPage ? true : someOnPage ? "indeterminate" : false}
                    onCheckedChange={(c) => setSelected(c ? new Set(selectable.map((m) => m.contact.id)) : new Set())}
                  />
                </th>
              )}
              <th scope="col" className={TH}>
                <ColumnLabel icon={COL.person}>Contact</ColumnLabel>
              </th>
              <th scope="col" className={TH}>
                <ColumnLabel icon={COL.status}>Status</ColumnLabel>
              </th>
              <th scope="col" className={TH}>
                <ColumnLabel icon={COL.consent}>Consent</ColumnLabel>
              </th>
              <th scope="col" className={TH}>
                <ColumnLabel icon={COL.source}>Source</ColumnLabel>
              </th>
              <th scope="col" className={TH}>
                <ColumnLabel icon={COL.date}>Since</ColumnLabel>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows.map((m) => {
              const isSel = selected.has(m.contact.id);
              const since = m.status === "unsubscribed" ? m.unsubscribedAt : (m.subscribedAt ?? m.createdAt);
              const name = m.contact.fullName || m.contact.email || "Unnamed contact";
              return (
                <tr key={m.id} className={cn("hover:bg-hover", isSel && "bg-tint-pick")}>
                  {canWrite && (
                    <td className="w-10 px-3">
                      {m.status === "unsubscribed" ? (
                        <Tooltip content="They unsubscribed. The record stays so they can't be added back by mistake.">
                          <span className="inline-flex">
                            <Checkbox aria-label={`${name} unsubscribed and can't be removed`} checked={false} disabled onCheckedChange={() => undefined} />
                          </span>
                        </Tooltip>
                      ) : (
                        <Checkbox
                          aria-label={`Select ${name}`}
                          checked={isSel}
                          onCheckedChange={(v) => {
                            const next = new Set(selected);
                            if (v) next.add(m.contact.id);
                            else next.delete(m.contact.id);
                            setSelected(next);
                          }}
                        />
                      )}
                    </td>
                  )}
                  <td className={cn(TD, "max-w-72")}>
                    <Link href={ws.href(`/contacts/${m.contact.id}`)} className="group flex min-w-0 items-center gap-2">
                      <Avatar size="sm" name={m.contact.fullName} email={m.contact.email} />
                      <span className="min-w-0">
                        <span className="block truncate font-medium text-text group-hover:text-accent-hi">{name}</span>
                        <span className="block truncate text-xs text-text-3">{m.contact.email || "No email address"}</span>
                      </span>
                    </Link>
                  </td>
                  <td className={cn(TD, "whitespace-nowrap")}>
                    <MembershipBadge status={m.status} />
                  </td>
                  <td className={cn(TD, "whitespace-nowrap")}>
                    <StatusBadge value={m.contact.consentStatus} dot={false} />
                  </td>
                  <td className={cn(TD, "max-w-72 truncate text-text-2")} title={m.source}>
                    {m.source || <span className="text-text-3">—</span>}
                  </td>
                  <td className={cn(TD, "whitespace-nowrap text-text-3")} title={since ? f.dateTime(since) : undefined}>
                    {since ? f.date(since) : "—"}
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
        back={{ href: mk.href("/lists"), label: "Lead lists" }}
        icon={<EntityTile of="lists" />}
        title={list.name}
        meta={archived ? <Badge>Archived</Badge> : undefined}
        description={list.description || `Created ${f.date(list.createdAt)}`}
        actions={
          canWrite ? (
            <>
              <Button icon={<Pencil />} onClick={() => setEditing(true)}>
                Edit
              </Button>
              {archived ? (
                <Button icon={<ArchiveRestore />} loading={archive.isPending} onClick={() => archive.restore(list)}>
                  Restore
                </Button>
              ) : (
                <>
                  <Button icon={<Archive />} onClick={() => setArchiving(true)}>
                    Archive
                  </Button>
                  <Button icon={<Users />} href={ws.href(`/leads?list=${list.id}`)}>
                    View as leads
                  </Button>
                  {ws.can("contacts.import") && (
                    <Button icon={<Upload />} href={ws.href(`/imports?listId=${list.id}`)}>
                      Import CSV into this list
                    </Button>
                  )}
                  <Button variant="primary" icon={<UserPlus />} onClick={() => setAdding(true)}>
                    Add contacts
                  </Button>
                </>
              )}
            </>
          ) : undefined
        }
      />

      {archived && (
        <Callout tone="warn" title={`Archived ${f.date(list.archivedAt)}`} className="mb-5">
          It keeps its members and history, but campaigns can't be sent to it and nobody can be added. Restore it to use it again.
        </Callout>
      )}

      {/* "Pending" is set by double opt-in: it shows on such a list, or while anyone is still waiting to confirm. */}
      <div className={cn("mb-5 grid grid-cols-1 gap-3", showPending ? "sm:grid-cols-3" : "sm:grid-cols-2")}>
        <StatCard
          label="Subscribed"
          value={formatNumber(list.counts.subscribed)}
          hint="On the list; marketing email needs their consent too"
          icon={<UserCheck />}
          tint="green"
          href={toUrl({ status: "subscribed" })}
        />
        <StatCard
          label="Unsubscribed"
          value={formatNumber(list.counts.unsubscribed)}
          hint="Opted out; never added back"
          icon={<UserMinus />}
          tint="gray"
          href={toUrl({ status: "unsubscribed" })}
        />
        {showPending && (
          <StatCard
            label="Pending"
            value={formatNumber(list.counts.pending)}
            hint={list.doubleOptIn ? "Emailed a link; joins once they confirm" : "Waiting to confirm"}
            icon={<Clock />}
            tint="orange"
            href={toUrl({ status: "pending" })}
          />
        )}
      </div>

      <div className="mb-3 flex flex-col gap-2 lg:flex-row lg:items-center">
        <div role="tablist" aria-label="Status" className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-1 lg:pb-0">
          {(["", ...LIST_MEMBERSHIP_STATUSES] as const).filter((s) => s !== "pending" || showPending).map((s) => {
            const n = s ? list.counts[s] : total;
            const Icon = s ? STATUS_ICON[s] : COL.people;
            return (
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
                <Icon aria-hidden className="size-3.5 shrink-0 opacity-70" strokeWidth={1.75} />
                {s ? STATUS_LABEL[s] : "All"}
                <span className={cn("tabular-nums", state.status === s ? "text-accent-ink/70" : "text-text-3")}>{formatNumber(n)}</span>
              </button>
            );
          })}
        </div>
        <SearchInput value={state.q} onChange={(q) => update({ q })} placeholder="Search name or email" className="lg:ml-auto lg:max-w-xs" />
      </div>

      {selected.size > 0 && canWrite && (
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-md border border-accent/30 bg-tint-pick px-3 py-2" role="region" aria-label="Selected members">
          <span className="mr-1 inline-flex items-center gap-1.5 text-sm font-medium text-text tabular-nums">
            <SquareCheckBig aria-hidden className="size-4 text-accent-ink" />
            {people(selected.size)} selected
          </span>
          <Button size="sm" variant="danger" icon={<UserMinus />} onClick={() => setRemoving([...selected])}>
            Remove from list
          </Button>
          <IconButton size="sm" label="Clear selection" icon={<X />} onClick={() => setSelected(new Set())} className="ml-auto" />
        </div>
      )}

      <Card className="overflow-hidden">
        {body}
        {members.data && members.data.total > 0 && (
          <div className="border-t border-line px-3 py-2">
            <Pagination
              page={state.page}
              pageSize={state.pageSize}
              total={members.data.total}
              pageSizes={PAGE_SIZES}
              onPageChange={(page) => update({ page })}
              onPageSizeChange={(pageSize) => update({ pageSize })}
            />
          </div>
        )}
      </Card>

      {canWrite && (
        <>
          {editing && <ListFormModal open onOpenChange={setEditing} list={list} />}
          <AddToListModal open={adding} onOpenChange={setAdding} listId={list.id} listName={list.name} />
          <ConfirmDialog
            open={archiving}
            onOpenChange={setArchiving}
            tone="default"
            title={`Archive ${list.name}?`}
            description="It keeps its members and history, but campaigns can no longer be sent to it and nobody can be added. You can restore it later."
            confirmLabel="Archive list"
            onConfirm={() => archive.mutateAsync({ list, archived: true })}
          />
          <ConfirmDialog
            open={removing !== null}
            onOpenChange={(o) => !o && setRemoving(null)}
            title={`Remove ${people(removing?.length ?? 0)} from ${list.name}?`}
            description="They stop receiving campaigns sent to this list. Their marketing consent and other lists stay as they are, and they can be added again later."
            confirmLabel="Remove"
            onConfirm={() => removing && remove.mutateAsync({ contactIds: removing })}
          />
        </>
      )}
    </>
  );
}
