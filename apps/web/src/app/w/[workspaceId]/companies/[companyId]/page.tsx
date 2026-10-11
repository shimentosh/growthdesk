"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { ExternalLink, Info, Pencil, Plus, Trash2, Users } from "lucide-react";
import {
  CompanyConflict,
  CompanyFields,
  companyBody,
  companyDraftFrom,
  companyErrors,
  type CompanyDraft,
  type CompanyInputT,
} from "@/components/crm/CompanyForm";
import { CustomFieldsCard } from "@/components/crm/CustomFieldsCard";
import { NewContactModal } from "@/components/crm/NewContactModal";
import { NotesPanel } from "@/components/crm/NotesPanel";
import { DealsCard } from "@/components/crm/RelatedCards";
import { TagList } from "@/components/crm/Tags";
import { Timeline } from "@/components/crm/Timeline";
import { contactLabel } from "@/components/pickers/Pickers";
import { Avatar } from "@/components/ui/Avatar";
import { StatusBadge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, CardBody, CardFooter, CardHeader } from "@/components/ui/Card";
import { ConfirmDialog } from "@/components/ui/Dialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { FormError } from "@/components/ui/Field";
import { EntityTile } from "@/components/ui/icons";
import { KeyValueList } from "@/components/ui/KeyValue";
import { Page, PageHeader } from "@/components/ui/PageHeader";
import { RequirePermission } from "@/components/ui/RequirePermission";
import { LoadingBlock } from "@/components/ui/Skeleton";
import { formatNumber } from "@/lib/format";
import { useApiMutation, useApiQuery } from "@/lib/query";
import { useFormat, useWorkspace } from "@/lib/session";
import type { CompanyDetail } from "@/lib/types/crm";

export default function CompanyRecordPage() {
  return (
    <RequirePermission permission="contacts.read">
      <CompanyRecord />
    </RequirePermission>
  );
}

function CompanyRecord() {
  const { companyId } = useParams<{ companyId: string }>();
  const ws = useWorkspace();
  const router = useRouter();
  const company = useApiQuery<CompanyDetail>(ws.key("companies", "detail", companyId), ws.path(`/companies/${companyId}`));
  const back = { href: ws.href("/companies"), label: "Companies" };

  if (company.isPending) return <LoadingBlock className="min-h-[50vh]" />;
  if (company.isError) {
    return (
      <Page width="capped">
        <PageHeader back={back} title="Company" icon={<EntityTile of="companies" />} />
        <ErrorState
          error={company.error}
          title={company.error.isNotFound ? "Company not found" : undefined}
          onRetry={company.error.isNotFound ? undefined : () => void company.refetch()}
        />
      </Page>
    );
  }
  return <Loaded company={company.data} onDeleted={() => router.push(ws.href("/companies"))} />;
}

/** PATCH /companies/:id; the answer is the whole record again. */
function useSaveCompany(id: string, success: string) {
  const ws = useWorkspace();
  return useApiMutation<CompanyDetail, Partial<CompanyInputT>>({
    method: "PATCH",
    path: ws.path(`/companies/${id}`),
    invalidate: [ws.key("companies"), ws.key("contacts"), ws.key("tags")],
    success,
    errorToast: false,
  });
}

function Loaded({ company: c, onDeleted }: { company: CompanyDetail; onDeleted: () => void }) {
  const ws = useWorkspace();
  const f = useFormat();
  const canWrite = ws.can("contacts.write");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<CompanyDraft | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [addingContact, setAddingContact] = useState(false);

  const save = useSaveCompany(c.id, "Company saved");
  const custom = useSaveCompany(c.id, "Custom fields saved");
  const remove = useApiMutation<{ deleted: boolean }, void>({
    method: "DELETE",
    path: ws.path(`/companies/${c.id}`),
    invalidate: [ws.key("companies"), ws.key("contacts")],
    success: "Company deleted",
    errorToast: false,
    onSuccess: onDeleted,
  });

  const { fields, message } = companyErrors(save.error);
  const detailKey = ws.key("companies", "detail", c.id);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (draft) save.mutate(companyBody(draft), { onSuccess: () => setEditing(false) });
  };

  const website = c.website ? (/^https?:\/\//i.test(c.website) ? c.website : `https://${c.website}`) : null;
  const location = [c.city, c.region, c.country].filter(Boolean).join(", ");

  return (
    <Page width="capped">
      <PageHeader
        back={{ href: ws.href("/companies"), label: "Companies" }}
        title={c.name}
        icon={<EntityTile of="companies" />}
        description={
          website ? (
            <a href={website} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 text-text-2 hover:text-accent-hi hover:underline">
              {c.domain ?? c.website.replace(/^https?:\/\//i, "")}
              <ExternalLink aria-hidden className="size-3" />
            </a>
          ) : (
            (c.domain ?? undefined)
          )
        }
        actions={
          ws.can("contacts.delete") ? (
            <Button variant="danger" icon={<Trash2 />} onClick={() => setConfirmDelete(true)}>
              Delete
            </Button>
          ) : undefined
        }
      />

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="flex min-w-0 flex-col gap-5">
          {editing && draft ? (
            <Card>
              <CardHeader icon={<Info />} title="Details" />
              <form onSubmit={submit} noValidate>
                <CardBody className="flex flex-col gap-3">
                  <FormError error={message} />
                  <CompanyConflict error={save.error} />
                  <CompanyFields draft={draft} onChange={setDraft} fields={fields} />
                </CardBody>
                <CardFooter>
                  <Button size="sm" onClick={() => setEditing(false)}>
                    Cancel
                  </Button>
                  <Button size="sm" variant="primary" type="submit" loading={save.isPending}>
                    Save changes
                  </Button>
                </CardFooter>
              </form>
            </Card>
          ) : (
            <Card>
              <CardHeader
                icon={<Info />}
                title="Details"
                actions={
                  canWrite ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      icon={<Pencil />}
                      onClick={() => {
                        save.reset();
                        setDraft(companyDraftFrom(c));
                        setEditing(true);
                      }}
                    >
                      Edit
                    </Button>
                  ) : undefined
                }
              />
              <CardBody className="flex flex-col gap-4">
                <KeyValueList
                  columns={2}
                  items={[
                    { label: "Domain", value: c.domain },
                    { label: "Industry", value: c.industry },
                    { label: "Size", value: c.size },
                    { label: "Phone", value: c.phone ? <a href={`tel:${c.phone}`} className="text-accent-hi hover:underline">{c.phone}</a> : null },
                    { label: "Location", value: location },
                    { label: "Owner", value: c.owner?.name ?? "Unassigned" },
                    { label: "Tags", value: c.tags.length ? <TagList tags={c.tags} max={10} /> : null },
                    { label: "Created", value: f.dateTime(c.createdAt) },
                  ]}
                />
                {c.description && <p className="border-t border-line pt-3 text-sm break-words whitespace-pre-wrap text-text-2">{c.description}</p>}
              </CardBody>
            </Card>
          )}

          <CustomFieldsCard
            entity="company"
            values={c.customFields ?? {}}
            onSave={(customFields) => custom.mutateAsync({ customFields })}
            saving={custom.isPending}
            error={custom.error}
          />

          <Card>
            <CardHeader
              icon={<Users />}
              title={
                <span className="flex items-center gap-2">
                  Contacts
                  {c.contacts.length > 0 && <span className="rounded-xs bg-mute-chip px-1.5 text-2xs text-text-2 tabular-nums">{formatNumber(c.contacts.length)}{c.contacts.length >= 200 ? "+" : ""}</span>}
                </span>
              }
              description={c.contacts.length >= 200 ? "Showing the 200 newest. Open the list to see them all." : undefined}
              actions={
                <>
                  {c.contacts.length > 0 && (
                    <Button size="sm" variant="ghost" icon={<Users />} href={ws.href(`/contacts?companyId=${c.id}`)}>
                      Open in list
                    </Button>
                  )}
                  {canWrite && (
                    <Button size="sm" icon={<Plus />} onClick={() => setAddingContact(true)}>
                      Add contact
                    </Button>
                  )}
                </>
              }
            />
            {!c.contacts.length ? (
              <EmptyState compact icon={<Users />} title="No contacts at this company yet" />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[560px] border-collapse text-sm">
                  <thead className="border-b border-line bg-s-2">
                    <tr>
                      {["Name", "Job title", "Status", "Owner", "Last contacted"].map((h) => (
                        <th key={h} scope="col" className="h-9 px-3 text-left text-xs font-medium whitespace-nowrap text-text-3">
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {c.contacts.map((p) => (
                      <tr key={p.id} className="hover:bg-hover">
                        <td className="max-w-60 px-3 py-2">
                          <Link href={ws.href(`/contacts/${p.id}`)} className="group flex min-w-0 items-center gap-2">
                            <Avatar size="sm" name={p.fullName} email={p.email} />
                            <span className="min-w-0">
                              <span className="block truncate font-medium text-text group-hover:text-accent-hi">{contactLabel(p)}</span>
                              {p.email && <span className="block truncate text-xs text-text-3">{p.email}</span>}
                            </span>
                          </Link>
                        </td>
                        <td className="max-w-48 truncate px-3 py-2 text-text-2">{p.jobTitle || <span className="text-text-3">—</span>}</td>
                        <td className="px-3 py-2">
                          <StatusBadge value={p.status} />
                        </td>
                        <td className="max-w-40 truncate px-3 py-2 text-text-2">{p.owner?.name ?? <span className="text-text-3">Unassigned</span>}</td>
                        <td className="px-3 py-2 whitespace-nowrap text-text-2">{p.lastContactedAt ? f.relative(p.lastContactedAt) : <span className="text-text-3">Never</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <NotesPanel notes={c.notes} addPath={ws.path(`/companies/${c.id}/notes`)} invalidate={[detailKey]} />
          <Timeline entries={c.activities} limitNote={c.activities.length >= 100 ? "The latest 100 events." : undefined} />
        </div>

        <aside className="flex min-w-0 flex-col gap-5">
          <DealsCard deals={c.deals} empty="No deals with this company." />
        </aside>
      </div>

      <NewContactModal open={addingContact} onOpenChange={setAddingContact} company={{ id: c.id, name: c.name }} />

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete ${c.name}?`}
        description={
          c.contacts.length
            ? `Its ${formatNumber(c.contacts.length)}${c.contacts.length >= 200 ? "+" : ""} contact${c.contacts.length === 1 ? "" : "s"} stay in the CRM with no company. The domain is freed for another company.`
            : "The domain is freed for another company."
        }
        onConfirm={() => remove.mutateAsync()}
      />
    </Page>
  );
}
