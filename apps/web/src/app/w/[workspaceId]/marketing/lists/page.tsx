"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import { Archive, ArchiveRestore, Ellipsis, Pencil, Plus, UserPlus } from "lucide-react";
import { AddToListModal } from "@/components/marketing/AddToListModal";
import { useMarketing, useMarketingLists } from "@/components/marketing/common";
import { ListFormModal } from "@/components/marketing/lists/ListFormModal";
import { useArchiveList } from "@/components/marketing/lists/useArchiveList";
import { Badge } from "@/components/ui/Badge";
import { Button, IconButton } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { ConfirmDialog } from "@/components/ui/Dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/DropdownMenu";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { ENTITY, EntityTile } from "@/components/ui/icons";
import { Page, PageHeader } from "@/components/ui/PageHeader";
import { RequirePermission } from "@/components/ui/RequirePermission";
import { Skeleton } from "@/components/ui/Skeleton";
import { Switch } from "@/components/ui/Switch";
import { cn } from "@/lib/cn";
import { formatNumber } from "@/lib/format";
import { useFormat, useWorkspace } from "@/lib/session";
import type { MarketingList } from "@/lib/types/marketing";

export default function MarketingListsPage() {
  return (
    <Page>
      <RequirePermission permission="marketing.read">
        <Lists />
      </RequirePermission>
    </Page>
  );
}

const ListGlyph = ENTITY.lists.icon;
const TH = "h-9 px-3 text-left text-xs font-medium whitespace-nowrap text-text-3";
const TD = "px-3 py-2.5 align-middle";

const Num = ({ n, tone }: { n: number; tone?: "ok" | "warn" }) => (
  <span className={cn("tabular-nums", !n ? "text-text-3" : tone === "ok" ? "font-medium text-text" : tone === "warn" ? "text-warn-ink" : "text-text-2")}>{formatNumber(n)}</span>
);

function Lists() {
  const ws = useWorkspace();
  const mk = useMarketing();
  const f = useFormat();
  const router = useRouter();
  const canWrite = ws.can("marketing.write");
  const [showArchived, setShowArchived] = useState(false);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<MarketingList | null>(null);
  const [adding, setAdding] = useState<MarketingList | null>(null);
  const [archiving, setArchiving] = useState<MarketingList | null>(null);
  const archive = useArchiveList();
  // ?archived=true returns active and archived lists together; the switch only filters, so it never reloads.
  const lists = useMarketingLists(true);
  const all = lists.data ?? [];
  const archivedCount = all.filter((l) => l.archivedAt).length;
  const rows = showArchived ? all : all.filter((l) => !l.archivedAt);

  const create = canWrite ? (
    <Button variant="primary" icon={<Plus />} onClick={() => setCreating(true)}>
      New list
    </Button>
  ) : undefined;

  let body: ReactNode;
  if (lists.isPending) {
    body = (
      <div className="flex flex-col gap-2 p-4" aria-busy>
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-10" />
        ))}
      </div>
    );
  } else if (lists.isError && !lists.data) {
    body = <ErrorState error={lists.error} onRetry={() => void lists.refetch()} />;
  } else if (!rows.length) {
    body = (
      <EmptyState
        icon={<ListGlyph />}
        tint={ENTITY.lists.tint}
        title={archivedCount ? "No active lists" : "No lists yet"}
        description={
          canWrite
            ? archivedCount
              ? "Every list is archived. Turn on Show archived to restore one, or create a new list."
              : "A list is a group of people who agreed to hear from you, like a newsletter or a product's beta. Campaigns are sent to lists."
            : "Nobody has created a marketing list yet."
        }
        action={create}
      />
    );
  } else {
    body = (
      <div className="overflow-x-auto">
        <table className="w-full min-w-[760px] border-collapse text-sm">
          <thead className="border-b border-line bg-s-2">
            <tr>
              <th scope="col" className={TH}>
                List
              </th>
              <th scope="col" className={cn(TH, "text-right")}>
                Subscribed
              </th>
              <th scope="col" className={cn(TH, "text-right")}>
                Unsubscribed
              </th>
              <th scope="col" className={cn(TH, "text-right")}>
                Pending
              </th>
              <th scope="col" className={TH}>
                Created
              </th>
              {canWrite && (
                <th scope="col" className="w-12 px-3">
                  <span className="sr-only">Actions</span>
                </th>
              )}
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows.map((l) => (
              <tr key={l.id} className="hover:bg-hover">
                <td className={cn(TD, "max-w-[28rem]")}>
                  <Link href={mk.href(`/lists/${l.id}`)} className="group flex min-w-0 items-center gap-3">
                    <EntityTile of="lists" size="md" className={cn(l.archivedAt && "opacity-50")} />
                    <span className="min-w-0">
                      <span className="flex items-center gap-2">
                        <span className="truncate font-medium text-text group-hover:text-accent-hi">{l.name}</span>
                        {l.archivedAt && <Badge>Archived</Badge>}
                      </span>
                      <span className="block truncate text-xs text-text-3">{l.description || "No description"}</span>
                    </span>
                  </Link>
                </td>
                <td className={cn(TD, "text-right")}>
                  <Num n={l.counts.subscribed} tone="ok" />
                </td>
                <td className={cn(TD, "text-right")}>
                  <Num n={l.counts.unsubscribed} />
                </td>
                <td className={cn(TD, "text-right")}>
                  <Num n={l.counts.pending} tone="warn" />
                </td>
                <td className={cn(TD, "whitespace-nowrap text-text-3")} title={f.dateTime(l.createdAt)}>
                  {f.date(l.createdAt)}
                </td>
                {canWrite && (
                  <td className="w-12 px-3 text-right">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <IconButton size="sm" label={`Actions for ${l.name}`} icon={<Ellipsis />} />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        {!l.archivedAt && (
                          <DropdownMenuItem icon={<UserPlus />} onSelect={() => setAdding(l)}>
                            Add contacts…
                          </DropdownMenuItem>
                        )}
                        <DropdownMenuItem icon={<Pencil />} onSelect={() => setEditing(l)}>
                          Edit…
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        {l.archivedAt ? (
                          <DropdownMenuItem icon={<ArchiveRestore />} onSelect={() => archive.restore(l)}>
                            Restore
                          </DropdownMenuItem>
                        ) : (
                          <DropdownMenuItem icon={<Archive />} onSelect={() => setArchiving(l)}>
                            Archive…
                          </DropdownMenuItem>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
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
      <PageHeader
        icon={<EntityTile of="lists" />}
        title="Lists"
        description="Who receives your marketing email. People join with recorded consent, and anyone who unsubscribes stays off the list."
        actions={create}
      />
      <div className="mb-3 flex items-center justify-between gap-3">
        <p className="text-xs text-text-3 tabular-nums">
          {lists.data
            ? `${formatNumber(all.length - archivedCount)} active list${all.length - archivedCount === 1 ? "" : "s"}${archivedCount ? ` · ${formatNumber(archivedCount)} archived` : ""}`
            : " "}
        </p>
        <Switch size="sm" label={<span className="text-xs text-text-2">Show archived</span>} checked={showArchived} onCheckedChange={setShowArchived} className="items-center" />
      </div>
      <Card className="overflow-hidden">{body}</Card>

      {canWrite && (
        <>
          <ListFormModal open={creating} onOpenChange={setCreating} onSaved={(l) => router.push(mk.href(`/lists/${l.id}`))} />
          {editing && <ListFormModal key={editing.id} open onOpenChange={(o) => !o && setEditing(null)} list={editing} />}
          {adding && <AddToListModal open onOpenChange={(o) => !o && setAdding(null)} listId={adding.id} listName={adding.name} />}
          <ConfirmDialog
            open={archiving !== null}
            onOpenChange={(o) => !o && setArchiving(null)}
            tone="default"
            title={`Archive ${archiving?.name ?? "this list"}?`}
            description="It keeps its members and history, but campaigns can no longer be sent to it and nobody can be added. You can restore it later."
            confirmLabel="Archive list"
            onConfirm={() => archiving && archive.mutateAsync({ list: archiving, archived: true })}
          />
        </>
      )}
    </>
  );
}
