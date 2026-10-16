"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState, type ReactNode } from "react";
import { Copy, Ellipsis, Megaphone, Pencil, Plus, SearchX, Trash2, X } from "lucide-react";
import { Button, IconButton } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { COL, ColumnLabel } from "@/components/ui/columns";
import { ConfirmDialog } from "@/components/ui/Dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/DropdownMenu";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { ENTITY } from "@/components/ui/icons";
import { Pagination } from "@/components/ui/Pagination";
import { RequirePermission } from "@/components/ui/RequirePermission";
import { SearchInput } from "@/components/ui/SearchInput";
import { LoadingBlock, Skeleton } from "@/components/ui/Skeleton";
import { toast } from "@/components/ui/Toast";
import { useMembers } from "@/components/pickers/Pickers";
import { NewCampaignModal } from "@/components/campaigns/NewCampaignModal";
import { LibraryActions } from "@/components/templates/library";
import { cn } from "@/lib/cn";
import { formatNumber } from "@/lib/format";
import { useApiMutation, useApiQuery } from "@/lib/query";
import { useFormat, useWorkspace } from "@/lib/session";
import type { Paged } from "@/lib/types";
import type { Sequence, SequenceDetail } from "@/lib/types/sequences";

export default function SequencesPage() {
  return (
    <RequirePermission permission="campaigns.read">
      <Suspense fallback={<LoadingBlock />}>
        <Sequences />
      </Suspense>
    </RequirePermission>
  );
}

const PAGE_SIZES = [25, 50, 100, 200];
const SequenceGlyph = ENTITY.sequences.icon;
const TH = "h-9 px-3 text-left text-xs font-medium whitespace-nowrap text-text-3";
const TD = "px-3 py-2 align-middle";

/** Search and page live in the URL (?q=&page=&pageSize=). */
function useListParams() {
  const sp = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const page = Number(sp.get("page"));
  const pageSize = Number(sp.get("pageSize"));
  const state = {
    q: sp.get("q") ?? "",
    page: Number.isInteger(page) && page > 0 ? page : 1,
    pageSize: PAGE_SIZES.includes(pageSize) ? pageSize : 50,
  };
  const update = (patch: Partial<typeof state>) => {
    const next = { ...state, ...patch };
    if (!("page" in patch)) next.page = 1;
    const p = new URLSearchParams();
    if (next.q.trim()) p.set("q", next.q.trim());
    if (next.page > 1) p.set("page", String(next.page));
    if (next.pageSize !== 50) p.set("pageSize", String(next.pageSize));
    const qs = p.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };
  return { state, update };
}

function RowActions({ seq, onDelete, onUse }: { seq: Sequence; onDelete: () => void; onUse: () => void }) {
  const ws = useWorkspace();
  const router = useRouter();
  const duplicate = useApiMutation<SequenceDetail, void>({
    path: ws.path(`/sequences/${seq.id}/duplicate`),
    invalidate: [ws.key("sequences", "list")],
    onSuccess: (copy) => {
      toast.success(`Duplicated as “${copy.name}”`, { action: { label: "Open", href: ws.href(`/sequences/${copy.id}`) } });
    },
  });
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <IconButton size="sm" label={`Actions for ${seq.name}`} icon={<Ellipsis />} disabled={duplicate.isPending} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem icon={<Pencil />} onSelect={() => router.push(ws.href(`/sequences/${seq.id}`))}>
          Edit
        </DropdownMenuItem>
        <DropdownMenuItem icon={<Copy />} onSelect={() => duplicate.mutate()}>
          Duplicate
        </DropdownMenuItem>
        <DropdownMenuItem icon={<Megaphone />} onSelect={onUse}>
          Use in campaign
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem danger icon={<Trash2 />} onSelect={onDelete}>
          Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function Sequences() {
  const ws = useWorkspace();
  const f = useFormat();
  const members = useMembers();
  const { state, update } = useListParams();
  const canWrite = ws.can("campaigns.write");
  const [deleting, setDeleting] = useState<Sequence | null>(null);
  const [using, setUsing] = useState<Sequence | null>(null);
  const list = useApiQuery<Paged<Sequence>>(ws.key("sequences", "list"), ws.path("/sequences"), {
    query: { q: state.q || undefined, page: state.page, pageSize: state.pageSize },
    keepPrevious: true,
  });
  const remove = useApiMutation<{ deleted: boolean }, string>({
    method: "DELETE",
    path: (id) => ws.path(`/sequences/${id}`),
    invalidate: [ws.key("sequences")],
    success: "Sequence deleted",
    errorToast: false,
  });
  const rows = list.data?.items ?? [];
  const author = (id: string | null) => {
    const m = id ? members.data?.members.find((x) => x.userId === id) : undefined;
    return m ? m.name || m.email : null;
  };
  const create = canWrite ? (
    <Button variant="primary" icon={<Plus />} href={ws.href("/sequences/new")}>
      New sequence
    </Button>
  ) : undefined;

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
    body = state.q ? (
      <EmptyState
        icon={<SearchX />}
        title="No sequences match"
        description="Search looks at the sequence name."
        action={
          <Button size="sm" icon={<X />} onClick={() => update({ q: "" })}>
            Clear search
          </Button>
        }
      />
    ) : (
      <EmptyState
        icon={<SequenceGlyph />}
        tint={ENTITY.sequences.tint}
        title="No sequences yet"
        description={canWrite ? "A sequence is a reusable series of steps (emails, waits, tasks, branches) that a campaign starts from." : "Nobody has built a sequence yet."}
        action={create}
      />
    );
  } else {
    body = (
      <div className={cn("overflow-x-auto transition-opacity", list.isFetching && list.isPlaceholderData && "opacity-60")}>
        <table className="w-full min-w-[640px] border-collapse text-sm">
          <thead className="border-b border-line bg-s-2">
            <tr>
              <th scope="col" className={TH}>
                <ColumnLabel icon={COL.name}>Name</ColumnLabel>
              </th>
              <th scope="col" className={cn(TH, "text-right")}>
                <ColumnLabel icon={COL.steps}>Steps</ColumnLabel>
              </th>
              <th scope="col" className={TH}>
                <ColumnLabel icon={COL.person}>Created by</ColumnLabel>
              </th>
              <th scope="col" className={TH}>
                <ColumnLabel icon={COL.updated}>Updated</ColumnLabel>
              </th>
              {canWrite && (
                <th scope="col" className={cn(TH, "w-10")}>
                  <span className="sr-only">Actions</span>
                </th>
              )}
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows.map((s) => (
              <tr key={s.id} className="hover:bg-hover">
                <td className={cn(TD, "max-w-[28rem]")}>
                  <Link href={ws.href(`/sequences/${s.id}`)} className="group block min-w-0">
                    <span className="block truncate font-medium text-text group-hover:text-accent-hi">{s.name}</span>
                    {s.description && <span className="block truncate text-xs text-text-3">{s.description}</span>}
                  </Link>
                </td>
                <td className={cn(TD, "text-right text-text-2 tabular-nums")}>{formatNumber(s.stepCount)}</td>
                <td className={cn(TD, "max-w-40 truncate text-text-2")}>{author(s.createdById) ?? <span className="text-text-3">—</span>}</td>
                <td className={cn(TD, "whitespace-nowrap text-text-3")} title={f.dateTime(s.updatedAt)}>
                  {f.smart(s.updatedAt)}
                </td>
                {canWrite && (
                  <td className={cn(TD, "text-right")}>
                    <RowActions seq={s} onDelete={() => setDeleting(s)} onUse={() => setUsing(s)} />
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <>
      <LibraryActions>{create}</LibraryActions>
      <div className="mb-3">
        <SearchInput value={state.q} onChange={(q) => update({ q })} placeholder="Search sequences" className="sm:max-w-xs" />
      </div>
      <Card>
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
      {using && <NewCampaignModal key={using.id} open initialSequenceId={using.id} onOpenChange={(o) => !o && setUsing(null)} />}
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={deleting ? `Delete “${deleting.name}”?` : "Delete sequence?"}
        description="Campaigns made from it keep their own copy of the steps, so nothing they send changes."
        onConfirm={async () => {
          if (deleting) await remove.mutateAsync(deleting.id);
        }}
      />
    </>
  );
}
