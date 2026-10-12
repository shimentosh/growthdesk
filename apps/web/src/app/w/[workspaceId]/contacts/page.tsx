"use client";

import { useRouter } from "next/navigation";
import { Suspense, useState } from "react";
import { Copy, Download, Plus, Upload, Users } from "lucide-react";
import type { LifecycleStage } from "@growthdesk/shared";
import { ContactListView, Segments, useContactQuery } from "@/components/crm/ContactListView";
import { NewContactModal } from "@/components/crm/NewContactModal";
import { activeFilterCount, useContactListState } from "@/components/crm/contactListState";
import { Button, buttonClass } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { EntityTile } from "@/components/ui/icons";
import { Page, PageHeader } from "@/components/ui/PageHeader";
import { RequirePermission } from "@/components/ui/RequirePermission";
import { LoadingBlock } from "@/components/ui/Skeleton";
import { Switch } from "@/components/ui/Switch";
import { withQuery } from "@/lib/api";
import { formatNumber } from "@/lib/format";
import { useWorkspace } from "@/lib/session";

export default function ContactsPage() {
  return (
    <RequirePermission permission="contacts.read">
      {/* useSearchParams needs a Suspense boundary above it. */}
      <Suspense fallback={<LoadingBlock />}>
        <Contacts />
      </Suspense>
    </RequirePermission>
  );
}

/** Contacts shows people at the contact stage unless the stage control says otherwise. */
const DEFAULTS = { stage: ["contact"] as const satisfies readonly LifecycleStage[] };
type StageChoice = "all" | LifecycleStage;
const STAGE_OPTIONS: { value: StageChoice; label: string }[] = [
  { value: "all", label: "All" },
  { value: "lead", label: "Leads" },
  { value: "sales", label: "In sales" },
  { value: "contact", label: "Contacts" },
];

function Contacts() {
  const ws = useWorkspace();
  const router = useRouter();
  const { state, update, clearFilters } = useContactListState(DEFAULTS);
  const [creating, setCreating] = useState(false);
  const { contacts, query, filter } = useContactQuery(state);
  const canWrite = ws.can("contacts.write");
  const narrowed = activeFilterCount(state) > 0 || Boolean(state.q) || Boolean(state.view);
  const stage: StageChoice = state.stage.length === 1 ? state.stage[0]! : "all";

  const exportHref = withQuery(`/api${ws.path("/contacts/export")}`, {
    filter,
    viewId: state.view || undefined,
  });

  return (
    <Page width="full">
      <PageHeader
        title="Contacts"
        icon={<EntityTile of="contacts" />}
        description={
          contacts.data
            ? `${formatNumber(contacts.data.total)} ${narrowed ? "matching" : state.archived ? "archived" : "in this view"}`
            : "Everyone you are talking to, or plan to."
        }
        actions={
          <>
            <Button icon={<Copy />} href={ws.href("/contacts/duplicates")}>
              Duplicates
            </Button>
            {ws.can("contacts.export") && (
              <a href={exportHref} download className={buttonClass()} title="Download the contacts matching these filters as CSV">
                <Download aria-hidden />
                Export CSV
              </a>
            )}
            {canWrite && (
              <Button variant="primary" icon={<Plus />} onClick={() => setCreating(true)}>
                New contact
              </Button>
            )}
          </>
        }
      />

      <ContactListView
        state={state}
        update={update}
        clearFilters={clearFilters}
        contacts={contacts}
        query={query}
        showStage={stage === "all"}
        controls={
          <>
            <Segments label="Lifecycle stage" value={stage} options={STAGE_OPTIONS} onChange={(v) => update({ stage: v === "all" ? [] : [v] })} />
            <Switch
              size="sm"
              label={<span className="text-xs text-text-2">Archived</span>}
              checked={state.archived === "only"}
              onCheckedChange={(on) => update({ archived: on ? "only" : "" })}
              className="items-center sm:ml-auto"
            />
          </>
        }
        empty={
          <EmptyState
            icon={<Users />}
            tint="indigo"
            title={stage === "contact" ? "No contacts yet" : stage === "all" ? "No people yet" : `No one ${stage === "lead" ? "is a lead" : "is in sales"} yet`}
            description={
              stage === "contact"
                ? "People become contacts after a won deal or a held meeting, or when you add them here. Imported people start as leads."
                : "Add people one at a time, or import a CSV into a lead list."
            }
            action={
              <>
                {canWrite && (
                  <Button size="sm" variant="primary" icon={<Plus />} onClick={() => setCreating(true)}>
                    New contact
                  </Button>
                )}
                {ws.can("contacts.import") && (
                  <Button size="sm" icon={<Upload />} href={ws.href("/imports")}>
                    Import CSV
                  </Button>
                )}
              </>
            }
          />
        }
      />

      <NewContactModal open={creating} onOpenChange={setCreating} onCreated={(c) => router.push(ws.href(`/contacts/${c.id}`))} />
    </Page>
  );
}
