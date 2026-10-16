"use client";

import { useState } from "react";
import { Ellipsis, ListPlus, Pencil, Plus, Trash2 } from "lucide-react";
import { CustomFieldFormModal, FIELD_ENTITIES, fieldTypeLabel } from "@/components/imports/CustomFieldFormModal";
import { Table, Td, Th } from "@/components/imports/Table";
import { Badge } from "@/components/ui/Badge";
import { Button, IconButton } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { COL } from "@/components/ui/columns";
import { ConfirmDialog } from "@/components/ui/Dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/DropdownMenu";
import { EmptyState } from "@/components/ui/EmptyState";
import { ENTITY, EntityTile, type Entity } from "@/components/ui/icons";
import { QueryState } from "@/components/ui/ErrorState";
import { PageHeader } from "@/components/ui/PageHeader";
import { RequirePermission } from "@/components/ui/RequirePermission";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/Tabs";
import { useApiMutation, useApiQuery } from "@/lib/query";
import { useWorkspace } from "@/lib/session";
import type { CustomFieldDefinition, CustomFieldEntity } from "@/lib/types/crm-settings";

/** Each record type's glyph on its tab. */
const RECORD_ENTITY: Record<CustomFieldEntity, Entity> = { contact: "contacts", company: "companies", deal: "deals" };

export default function CustomFieldsSettingsPage() {
  return (
    <RequirePermission permission="contacts.read">
      <CustomFieldsSettings />
    </RequirePermission>
  );
}

function CustomFieldsSettings() {
  const ws = useWorkspace();
  // The API takes field changes from settings.manage, not contacts.write.
  const canManage = ws.can("settings.manage");
  const list = useApiQuery<CustomFieldDefinition[]>(ws.key("custom-fields"), ws.path("/custom-fields"));
  const [entity, setEntity] = useState<CustomFieldEntity>("contact");
  // undefined: closed; null: new; a row: editing it.
  const [editing, setEditing] = useState<CustomFieldDefinition | null | undefined>(undefined);
  const [deleting, setDeleting] = useState<CustomFieldDefinition | null>(null);

  const remove = useApiMutation<{ deleted: true }, string>({
    method: "DELETE",
    path: (id) => ws.path(`/custom-fields/${id}`),
    invalidate: [ws.key("custom-fields")],
    success: "Field deleted",
    errorToast: false,
  });

  const entityLabel = FIELD_ENTITIES.find((e) => e.value === entity)?.label.toLowerCase() ?? entity;
  const newButton = canManage ? (
    <Button variant="primary" icon={<Plus />} onClick={() => setEditing(null)}>
      New field
    </Button>
  ) : undefined;

  return (
    <>
      <PageHeader
        icon={<EntityTile of="fields" />}
        title="Custom fields"
        description="Extra fields on contacts, companies and deals, for what your team tracks beyond the built-in ones."
        actions={newButton}
      />

      <QueryState query={list}>
        {(rows) => {
          const visible = rows.filter((r) => r.entity === entity).sort((a, b) => a.position - b.position);
          return (
            <div className="flex flex-col gap-3">
              <Tabs value={entity} onValueChange={(v) => setEntity(v as CustomFieldEntity)}>
                <TabsList aria-label="Record type">
                  {FIELD_ENTITIES.map((e) => {
                    const n = rows.filter((r) => r.entity === e.value).length;
                    const Icon = ENTITY[RECORD_ENTITY[e.value]].icon;
                    return (
                      <TabsTrigger key={e.value} value={e.value}>
                        <Icon aria-hidden />
                        {e.plural}
                        <span className="rounded-xs bg-mute-chip px-1.5 text-2xs text-text-2 tabular-nums">{n}</span>
                      </TabsTrigger>
                    );
                  })}
                </TabsList>
              </Tabs>

              <Card>
                {visible.length === 0 ? (
                  <EmptyState
                    compact
                    icon={<ListPlus />}
                    title={`No ${entityLabel} fields yet`}
                    description={
                      entity === "contact"
                        ? "Contact fields can be filled from a CSV import and used in message templates."
                        : `Add a field to record something every ${entityLabel} should carry.`
                    }
                    action={newButton}
                  />
                ) : (
                  <Table>
                    <thead>
                      <tr>
                        <Th icon={COL.name}>Label</Th>
                        <Th icon={COL.key}>Key</Th>
                        <Th icon={COL.type}>Type</Th>
                        <Th icon={COL.list} className="hidden sm:table-cell">Options</Th>
                        {canManage && (
                          <Th className="w-12">
                            <span className="sr-only">Actions</span>
                          </Th>
                        )}
                      </tr>
                    </thead>
                    <tbody>
                      {visible.map((f) => (
                        <tr key={f.id} className="hover:bg-hover">
                          <Td className="font-medium text-text">{f.label}</Td>
                          <Td>
                            <code className="font-mono text-xs text-text-2">{f.key}</code>
                          </Td>
                          <Td className="whitespace-nowrap text-text-2">{fieldTypeLabel(f.type)}</Td>
                          <Td className="hidden sm:table-cell">
                            {f.type === "select" && f.options.length ? (
                              <span className="flex flex-wrap gap-1">
                                {f.options.slice(0, 4).map((o) => (
                                  <Badge key={o} quiet>
                                    {o}
                                  </Badge>
                                ))}
                                {f.options.length > 4 && <span className="text-xs text-text-3">+{f.options.length - 4} more</span>}
                              </span>
                            ) : (
                              <span className="text-text-3">—</span>
                            )}
                          </Td>
                          {canManage && (
                            <Td className="py-1">
                              <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                  <IconButton size="sm" label={`Actions for ${f.label}`} icon={<Ellipsis />} />
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end">
                                  <DropdownMenuItem icon={<Pencil />} onSelect={() => setEditing(f)}>
                                    Edit
                                  </DropdownMenuItem>
                                  <DropdownMenuSeparator />
                                  <DropdownMenuItem danger icon={<Trash2 />} onSelect={() => setDeleting(f)}>
                                    Delete
                                  </DropdownMenuItem>
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
              {!canManage && <p className="text-xs text-text-3">Only roles that manage workspace settings can add or change fields.</p>}
            </div>
          );
        }}
      </QueryState>

      {editing !== undefined && <CustomFieldFormModal field={editing} defaultEntity={entity} onClose={() => setEditing(undefined)} />}

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={`Delete the field “${deleting?.label ?? ""}”?`}
        description="The field is removed from forms, imports and exports. Values already saved on records are not erased: a new field with the same key shows them again."
        confirmLabel="Delete field"
        onConfirm={() => (deleting ? remove.mutateAsync(deleting.id) : undefined)}
      />
    </>
  );
}
