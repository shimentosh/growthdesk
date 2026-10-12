"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useState } from "react";
import { Handshake, Link2, Plus, Trash2 } from "lucide-react";
import type { ContactInputT } from "@growthdesk/shared";
import { AiSummaryCard } from "@/components/ai/AiSummaryCard";
import { ContactCallActions } from "@/components/calls/ContactCallActions";
import { ContactDetailsCard } from "@/components/crm/ContactDetailsCard";
import { ContactPrivacyMenu } from "@/components/crm/ContactPrivacyMenu";
import { CustomFieldsCard } from "@/components/crm/CustomFieldsCard";
import { ArchivedBanner, ContactLifecycleMenu, StageBadge } from "@/components/crm/lifecycle";
import { NotesPanel } from "@/components/crm/NotesPanel";
import { ConsentCard, ContactActivityCards, DealsCard, IdentityCard, MarketingListsCard } from "@/components/crm/RelatedCards";
import { TagEditor } from "@/components/crm/Tags";
import { Timeline } from "@/components/crm/Timeline";
import { CompanyPicker, MemberPicker, contactLabel } from "@/components/pickers/Pickers";
import { useContactDealActions } from "@/components/pipeline/ContactDealActions";
import { Avatar } from "@/components/ui/Avatar";
import { StatusBadge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { ConfirmDialog } from "@/components/ui/Dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/DropdownMenu";
import { ErrorState } from "@/components/ui/ErrorState";
import { Field } from "@/components/ui/Field";
import { Page, PageHeader } from "@/components/ui/PageHeader";
import { RequirePermission } from "@/components/ui/RequirePermission";
import { LoadingBlock } from "@/components/ui/Skeleton";
import { useApiMutation, useApiQuery } from "@/lib/query";
import { useFormat, useWorkspace } from "@/lib/session";
import type { ActivityEntry, ContactDetail, Note } from "@/lib/types/crm";

export default function ContactRecordPage() {
  return (
    <RequirePermission permission="contacts.read">
      <ContactRecord />
    </RequirePermission>
  );
}

function ContactRecord() {
  const { contactId } = useParams<{ contactId: string }>();
  const ws = useWorkspace();
  const router = useRouter();
  const detailKey = ws.key("contacts", "detail", contactId);
  const contact = useApiQuery<ContactDetail>(detailKey, ws.path(`/contacts/${contactId}`));
  const back = { href: ws.href("/contacts"), label: "Contacts" };

  if (contact.isPending) return <LoadingBlock className="min-h-[50vh]" />;
  if (contact.isError) {
    return (
      <Page width="capped">
        <PageHeader back={back} title="Contact" />
        <ErrorState
          error={contact.error}
          title={contact.error.isNotFound ? "Contact not found" : undefined}
          onRetry={contact.error.isNotFound ? undefined : () => void contact.refetch()}
        />
      </Page>
    );
  }
  return <Loaded contact={contact.data} onDeleted={() => router.push(ws.href("/contacts"))} />;
}

/** One PATCH mutation per surface, so each shows its own errors (inline or as a toast). */
function useSaveContact(id: string, opts: { success?: string; inline?: boolean } = {}) {
  const ws = useWorkspace();
  return useApiMutation<ContactDetail, ContactInputT>({
    method: "PATCH",
    path: ws.path(`/contacts/${id}`),
    // The record, its notes and timeline, lists, and companies (contact counts) all read this contact.
    invalidate: [ws.key("contacts"), ws.key("companies"), ws.key("tags")],
    success: opts.success ?? "Contact saved",
    errorToast: !opts.inline,
  });
}

function Loaded({ contact: c, onDeleted }: { contact: ContactDetail; onDeleted: () => void }) {
  const ws = useWorkspace();
  const f = useFormat();
  const canWrite = ws.can("contacts.write");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [pendingTags, setPendingTags] = useState<string[] | null>(null);

  const details = useSaveContact(c.id, { inline: true });
  const custom = useSaveContact(c.id, { inline: true, success: "Custom fields saved" });
  const quick = useSaveContact(c.id);

  const notes = useApiQuery<Note[]>(ws.key("contacts", "notes", c.id), ws.path(`/contacts/${c.id}/notes`));
  const timeline = useApiQuery<ActivityEntry[]>(ws.key("contacts", "timeline", c.id), ws.path(`/contacts/${c.id}/timeline`));

  const remove = useApiMutation<{ deleted: number }, void>({
    method: "DELETE",
    path: ws.path(`/contacts/${c.id}`),
    invalidate: [ws.key("contacts"), ws.key("companies")],
    success: "Contact deleted",
    errorToast: false,
    onSuccess: onDeleted,
  });

  const name = contactLabel(c);
  const dealActions = useContactDealActions({ id: c.id, label: name, company: c.company });
  const subtitle = [c.jobTitle, c.company?.name].filter(Boolean).join(" at ");
  const tags = pendingTags ?? c.tags.map((t) => t.name);

  // Why this person may not be contacted, in the API's own words.
  const warnings = [
    c.doNotContact ? "Marked do not contact." : null,
    c.suppressed,
    c.unsubscribedAt ? `Unsubscribed ${f.date(c.unsubscribedAt)}.` : null,
    c.bouncedAt ? `Email bounced ${f.date(c.bouncedAt)}.` : null,
  ].filter((w): w is string => Boolean(w));

  return (
    <Page width="capped">
      <PageHeader
        back={c.lifecycleStage === "lead" || c.lifecycleStage === "sales" ? { href: ws.href(c.lifecycleStage === "sales" ? "/leads?stage=sales" : "/leads"), label: "Leads" } : { href: ws.href("/contacts"), label: "Contacts" }}
        title={
          <span className="flex items-center gap-2.5">
            <Avatar size="md" name={c.fullName} email={c.email} />
            {name}
          </span>
        }
        meta={
          <>
            <StageBadge stage={c.lifecycleStage} />
            <StatusBadge value={c.status} />
          </>
        }
        description={
          subtitle || c.company ? (
            <>
              {c.jobTitle}
              {c.jobTitle && c.company ? " at " : ""}
              {c.company && (
                <Link href={ws.href(`/companies/${c.company.id}`)} className="text-text-2 hover:text-accent-hi hover:underline">
                  {c.company.name}
                </Link>
              )}
            </>
          ) : undefined
        }
        actions={
          ws.can(["calls.make", "contacts.write", "contacts.delete", "contacts.export", "contacts.erase"]) ? (
            <>
              <ContactCallActions contact={c} />
              <ContactLifecycleMenu contact={c} name={name} />
              <ContactPrivacyMenu contactId={c.id} name={name} />
              {ws.can("contacts.delete") && (
                <Button variant="danger" icon={<Trash2 />} onClick={() => setConfirmDelete(true)}>
                  Delete
                </Button>
              )}
            </>
          ) : undefined
        }
      />

      <ArchivedBanner contact={c} className="mb-5" />

      {warnings.length > 0 && (
        <Callout tone="warn" title="Contact restrictions" className="mb-5">
          {warnings.join(" ")}
        </Callout>
      )}

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="flex min-w-0 flex-col gap-5">
          <ContactDetailsCard
            contact={c}
            onSave={(body) => details.mutateAsync(body)}
            saving={details.isPending}
            error={details.error}
            onResetError={details.reset}
          />
          <CustomFieldsCard
            entity="contact"
            values={c.customFields ?? {}}
            onSave={(customFields) => custom.mutateAsync({ customFields })}
            saving={custom.isPending}
            error={custom.error}
          />
          <NotesPanel
            notes={notes.data}
            loading={notes.isPending}
            addPath={ws.path(`/contacts/${c.id}/notes`)}
            invalidate={[ws.key("contacts", "notes", c.id), ws.key("contacts", "timeline", c.id)]}
          />
          {timeline.isError ? (
            <Card>
              <ErrorState compact error={timeline.error} onRetry={() => void timeline.refetch()} />
            </Card>
          ) : (
            <Timeline entries={timeline.data} loading={timeline.isPending} limitNote="The latest 200 events." />
          )}
        </div>

        <aside className="flex min-w-0 flex-col gap-5">
          <AiSummaryCard kind="contact" id={c.id} />
          <Card>
            <CardHeader title="Ownership" />
            <CardBody className="flex flex-col gap-3">
              <Field label="Owner">
                {canWrite && ws.can("members.read") ? (
                  <MemberPicker
                    value={c.owner?.id ?? null}
                    valueLabel={c.owner?.name}
                    placeholder="Unassigned"
                    disabled={quick.isPending}
                    onChange={(id) => quick.mutate({ ownerId: id })}
                  />
                ) : (
                  <span className="text-sm text-text">{c.owner?.name ?? "Unassigned"}</span>
                )}
              </Field>
              <Field label="Company">
                {canWrite ? (
                  <CompanyPicker
                    value={c.company?.id ?? null}
                    valueLabel={c.company?.name}
                    placeholder="None"
                    disabled={quick.isPending}
                    onChange={(id) => quick.mutate({ companyId: id })}
                  />
                ) : c.company ? (
                  <Link href={ws.href(`/companies/${c.company.id}`)} className="text-sm text-accent-hi hover:underline">
                    {c.company.name}
                  </Link>
                ) : (
                  <span className="text-sm text-text-3">None</span>
                )}
              </Field>
              <Field label="Tags">
                <TagEditor
                  value={tags}
                  disabled={!canWrite}
                  onChange={(next) => {
                    setPendingTags(next);
                    quick.mutate({ tags: next }, { onSettled: () => setPendingTags(null) });
                  }}
                />
                {!canWrite && !tags.length && <span className="text-sm text-text-3">None</span>}
              </Field>
            </CardBody>
          </Card>

          <DealsCard
            deals={c.deals}
            empty={dealActions.canWrite ? "No deals yet." : undefined}
            action={
              dealActions.canWrite ? (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button size="sm" variant="ghost" icon={<Plus />}>
                      Deal
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem icon={<Handshake />} disabled={dealActions.pipelinesLoading || dealActions.noPipeline} onSelect={dealActions.openNew}>
                      {dealActions.noPipeline ? "New deal (set up a pipeline first)" : "New deal"}
                    </DropdownMenuItem>
                    <DropdownMenuItem icon={<Link2 />} onSelect={dealActions.openLink}>
                      Link to existing deal
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : undefined
            }
          />
          <ContactActivityCards contact={c} />
          <ConsentCard contact={c} />
          <MarketingListsCard contact={c} />
          <IdentityCard contact={c} />
        </aside>
      </div>

      {dealActions.dialogs}
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete ${name}?`}
        description="The contact leaves the CRM and any running sequences for them stop. Their email address and phone number are released, so they can be imported again."
        onConfirm={() => remove.mutateAsync()}
      />
    </Page>
  );
}
