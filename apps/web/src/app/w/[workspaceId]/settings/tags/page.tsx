"use client";

import Link from "next/link";
import { useState } from "react";
import { Ellipsis, Pencil, Plus, Tag, Trash2 } from "lucide-react";
import { TagFormModal } from "@/components/imports/TagFormModal";
import { Table, Td, Th } from "@/components/imports/Table";
import { tagTone } from "@/components/imports/labels";
import { Badge } from "@/components/ui/Badge";
import { Button, IconButton } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { COL } from "@/components/ui/columns";
import { ConfirmDialog } from "@/components/ui/Dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/DropdownMenu";
import { EmptyState } from "@/components/ui/EmptyState";
import { EntityTile } from "@/components/ui/icons";
import { QueryState } from "@/components/ui/ErrorState";
import { PageHeader } from "@/components/ui/PageHeader";
import { RequirePermission } from "@/components/ui/RequirePermission";
import { SearchInput } from "@/components/ui/SearchInput";
import { formatNumber } from "@/lib/format";
import { useApiMutation, useApiQuery } from "@/lib/query";
import { useWorkspace } from "@/lib/session";
import type { TagRow } from "@/lib/types/crm-settings";

export default function TagsSettingsPage() {
  return (
    <RequirePermission permission="contacts.read">
      <TagsSettings />
    </RequirePermission>
  );
}

function TagsSettings() {
  const ws = useWorkspace();
  const canWrite = ws.can("contacts.write");
  const canDelete = ws.can("contacts.delete");
  const tags = useApiQuery<TagRow[]>(ws.key("tags"), ws.path("/tags"));
  const [q, setQ] = useState("");
  // undefined: closed; null: new; a row: editing it.
  const [editing, setEditing] = useState<TagRow | null | undefined>(undefined);
  const [deleting, setDeleting] = useState<TagRow | null>(null);

  const remove = useApiMutation<{ deleted: true }, string>({
    method: "DELETE",
    path: (id) => ws.path(`/tags/${id}`),
    invalidate: [ws.key("tags"), ws.key("contacts"), ws.key("companies")],
    success: "Tag deleted",
    errorToast: false,
  });

  const newButton = canWrite ? (
    <Button variant="primary" icon={<Plus />} onClick={() => setEditing(null)}>
      New tag
    </Button>
  ) : undefined;

  return (
    <>
      <PageHeader
        icon={<EntityTile of="tags" />}
        title="Tags"
        description="Labels for contacts and companies. Imports and bulk actions also create a tag the first time they use its name."
        actions={newButton}
      />

      <QueryState
        query={tags}
        isEmpty={(d) => d.length === 0}
        empty={
          <Card>
            <EmptyState
              icon={<Tag />}
              tint="yellow"
              title="No tags yet"
              description="Tags group contacts and companies so you can filter lists and act on many contacts at once."
              action={newButton}
            />
          </Card>
        }
      >
        {(rows) => {
          const s = q.trim().toLowerCase();
          const visible = s ? rows.filter((t) => t.name.toLowerCase().includes(s)) : rows;
          return (
            <div className="flex flex-col gap-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <SearchInput value={q} onChange={setQ} placeholder="Search tags" className="sm:max-w-xs" />
                <span className="text-xs text-text-3">
                  {formatNumber(rows.length)} {rows.length === 1 ? "tag" : "tags"}
                </span>
              </div>
              <Card>
                {visible.length === 0 ? (
                  <p className="px-4 py-8 text-center text-xs text-text-3">No tag matches &ldquo;{q}&rdquo;.</p>
                ) : (
                  <Table>
                    <thead>
                      <tr>
                        <Th icon={COL.tags}>Tag</Th>
                        <Th align="right" icon={COL.people}>Contacts</Th>
                        <Th align="right" icon={COL.company}>Companies</Th>
                        {(canWrite || canDelete) && (
                          <Th className="w-12">
                            <span className="sr-only">Actions</span>
                          </Th>
                        )}
                      </tr>
                    </thead>
                    <tbody>
                      {visible.map((t) => (
                        <tr key={t.id} className="hover:bg-hover">
                          <Td>
                            <Badge tone={tagTone(t.color)}>{t.name}</Badge>
                          </Td>
                          <Td align="right">
                            {t.contactCount ? (
                              <Link href={ws.href(`/contacts?tag=${encodeURIComponent(t.name)}`)} className="text-text hover:text-accent-hi">
                                {formatNumber(t.contactCount)}
                              </Link>
                            ) : (
                              <span className="text-text-3">0</span>
                            )}
                          </Td>
                          <Td align="right">{t.companyCount ? formatNumber(t.companyCount) : <span className="text-text-3">0</span>}</Td>
                          {(canWrite || canDelete) && (
                            <Td className="py-1">
                              <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                  <IconButton size="sm" label={`Actions for ${t.name}`} icon={<Ellipsis />} />
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end">
                                  {canWrite && (
                                    <DropdownMenuItem icon={<Pencil />} onSelect={() => setEditing(t)}>
                                      Edit
                                    </DropdownMenuItem>
                                  )}
                                  {canWrite && canDelete && <DropdownMenuSeparator />}
                                  {canDelete && (
                                    <DropdownMenuItem danger icon={<Trash2 />} onSelect={() => setDeleting(t)}>
                                      Delete
                                    </DropdownMenuItem>
                                  )}
                                </DropdownMenuContent>
                              </DropdownMenu>
                            </Td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                )}
              </Card>
            </div>
          );
        }}
      </QueryState>

      {editing !== undefined && <TagFormModal tag={editing} onClose={() => setEditing(undefined)} />}

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={`Delete the tag “${deleting?.name ?? ""}”?`}
        description={
          deleting && (deleting.contactCount || deleting.companyCount)
            ? `It is removed from ${formatNumber(deleting.contactCount)} ${deleting.contactCount === 1 ? "contact" : "contacts"} and ${formatNumber(deleting.companyCount)} ${deleting.companyCount === 1 ? "company" : "companies"}. The records themselves are kept.`
            : "No contact or company uses it."
        }
        confirmLabel="Delete tag"
        onConfirm={() => (deleting ? remove.mutateAsync(deleting.id) : undefined)}
      />
    </>
  );
}
