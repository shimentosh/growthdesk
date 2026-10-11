"use client";

import { useState } from "react";
import { Plus, ShieldBan, Trash2 } from "lucide-react";
import { labelOf } from "@growthdesk/shared";
import { SuppressionFormModal } from "@/components/imports/SuppressionFormModal";
import { Table, Td, Th } from "@/components/imports/Table";
import { Badge } from "@/components/ui/Badge";
import { Button, IconButton } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { ConfirmDialog } from "@/components/ui/Dialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { QueryState } from "@/components/ui/ErrorState";
import { EntityTile } from "@/components/ui/icons";
import { PageHeader } from "@/components/ui/PageHeader";
import { Pagination } from "@/components/ui/Pagination";
import { RequirePermission } from "@/components/ui/RequirePermission";
import { SearchInput } from "@/components/ui/SearchInput";
import { useApiMutation, useApiQuery } from "@/lib/query";
import { useFormat, useWorkspace } from "@/lib/session";
import type { Paged } from "@/lib/types";
import { SCOPE_LABELS, type SuppressionRow } from "@/lib/types/crm-settings";

export default function SuppressionsSettingsPage() {
  return (
    <RequirePermission permission="contacts.read">
      <Suppressions />
    </RequirePermission>
  );
}

function Suppressions() {
  const ws = useWorkspace();
  const f = useFormat();
  const canAdd = ws.can("contacts.write");
  const canRemove = ws.can("contacts.delete");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<SuppressionRow | null>(null);

  const list = useApiQuery<Paged<SuppressionRow>>(ws.key("suppressions"), ws.path("/suppressions"), {
    query: { q: q.trim() || undefined, page, pageSize },
    keepPrevious: true,
  });

  const remove = useApiMutation<{ deleted: true }, string>({
    method: "DELETE",
    path: (id) => ws.path(`/suppressions/${id}`),
    invalidate: [ws.key("suppressions")],
    success: "Removed from the suppression list",
    errorToast: false,
  });

  const addButton = canAdd ? (
    <Button variant="primary" icon={<Plus />} onClick={() => setAdding(true)}>
      Add
    </Button>
  ) : undefined;

  return (
    <>
      <PageHeader
        icon={<EntityTile of="suppressions" />}
        title="Suppression list"
        description="Email addresses, domains and phone numbers that are not contacted. Every outbound email, message and call checks this list right before it goes out. An entry can stop all sending, or only outreach or only marketing."
        actions={addButton}
      />

      <div className="flex flex-col gap-3">
        <SearchInput
          value={q}
          onChange={(v) => {
            setQ(v);
            setPage(1);
          }}
          placeholder="Search addresses, domains, numbers"
          className="sm:max-w-sm"
        />

        <QueryState
          query={list}
          isEmpty={(d) => d.total === 0}
          empty={
            <Card>
              {q.trim() ? (
                <p className="px-4 py-8 text-center text-xs text-text-3">Nothing on the list matches &ldquo;{q.trim()}&rdquo;.</p>
              ) : (
                <EmptyState
                  icon={<ShieldBan />}
                  title="The suppression list is empty"
                  description="Unsubscribes, bounces and contacts marked do-not-contact are added here automatically. You can also add entries by hand."
                  action={addButton}
                />
              )}
            </Card>
          }
        >
          {(data) => (
            <>
              <Card>
                <Table>
                  <thead>
                    <tr>
                      <Th>Value</Th>
                      <Th>Kind</Th>
                      <Th>Stops</Th>
                      <Th>Reason</Th>
                      <Th className="hidden md:table-cell">Source</Th>
                      <Th className="hidden sm:table-cell">Added</Th>
                      {canRemove && (
                        <Th className="w-12">
                          <span className="sr-only">Actions</span>
                        </Th>
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {data.items.map((s) => (
                      <tr key={s.id} className="hover:bg-hover">
                        <Td className="max-w-72 truncate font-medium text-text" title={s.value}>
                          {s.value}
                        </Td>
                        <Td>
                          <Badge quiet>{labelOf(s.kind)}</Badge>
                        </Td>
                        <Td className="whitespace-nowrap">
                          <Badge tone={s.scope === "all" ? "bad" : s.scope === "marketing" ? "info" : "warn"}>{SCOPE_LABELS[s.scope]}</Badge>
                        </Td>
                        <Td className="whitespace-nowrap text-text-2">{labelOf(s.reason)}</Td>
                        <Td className="hidden whitespace-nowrap text-text-2 md:table-cell">{s.source ? labelOf(s.source) : <span className="text-text-3">—</span>}</Td>
                        <Td className="hidden whitespace-nowrap text-text-2 sm:table-cell" title={f.dateTime(s.createdAt)}>
                          {f.smart(s.createdAt)}
                        </Td>
                        {canRemove && (
                          <Td className="py-1">
                            <IconButton size="sm" variant="danger" label={`Remove ${s.value}`} icon={<Trash2 />} onClick={() => setRemoving(s)} />
                          </Td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </Card>
              <Pagination
                page={data.page}
                pageSize={data.pageSize}
                total={data.total}
                onPageChange={setPage}
                onPageSizeChange={(n) => {
                  setPageSize(n);
                  setPage(1);
                }}
              />
            </>
          )}
        </QueryState>
      </div>

      {adding && <SuppressionFormModal onClose={() => setAdding(false)} />}

      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={`Remove ${removing?.value ?? ""}?`}
        description="Outbound sends will no longer be blocked by this entry. A contact that is itself marked do-not-contact stays marked."
        confirmLabel="Remove"
        onConfirm={() => (removing ? remove.mutateAsync(removing.id) : undefined)}
      />
    </>
  );
}
