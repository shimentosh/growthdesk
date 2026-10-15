"use client";

import { useRouter } from "next/navigation";
import { Suspense, useState } from "react";
import { Copy, Download, ListChecks, Plus, Upload, Users } from "lucide-react";
import type { LifecycleStage } from "@growthdesk/shared";
import { ContactListView, Segments, useContactQuery } from "@/components/crm/ContactListView";
import { LIST_READ } from "@/components/crm/lifecycle";
import { NewContactModal } from "@/components/crm/NewContactModal";
import { activeFilterCount, useContactListState } from "@/components/crm/contactListState";
import { useMarketing, useMarketingLists } from "@/components/marketing/common";
import { Button, buttonClass } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { EntityTile } from "@/components/ui/icons";
import { NativeSelect } from "@/components/ui/Input";
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
  const mk = useMarketing();
  const router = useRouter();
  const canLists = ws.can(LIST_READ);
  const lists = useMarketingLists();
  const { state, update, clearFilters } = useContactListState(DEFAULTS);
  const [creating, setCreating] = useState(false);
  const { contacts, query, filter } = useContactQuery(state);
  const canWrite = ws.can("contacts.write");
  const narrowed = activeFilterCount(state) > 0 || Boolean(state.q) || Boolean(state.view) || Boolean(state.listId);
  const listName = lists.data?.find((l) => l.id === state.listId)?.name;
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
            ? `${formatNumber(contacts.data.total)} ${listName ? `on ${listName}` : narrowed ? "matching" : state.archived ? "archived" : "in this view"}`
            : "Everyone you are talking to, or plan to."
        }
        actions={
          <>
            {canLists && (
              <Button icon={<ListChecks />} href={mk.href("/lists")}>
                Lists
              </Button>
            )}
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
            {canLists && (
              <NativeSelect
                size="sm"
                aria-label="List"
                className="w-full sm:w-64"
                value={state.listId}
                disabled={lists.isPending}
                onChange={(e) => update({ listId: e.target.value })}
                options={[
                  { value: "", label: "All lists" },
                  ...(lists.data ?? []).map((l) => ({ value: l.id, label: l.name })),
                  ...(state.listId && lists.data && !lists.data.some((l) => l.id === state.listId) ? [{ value: state.listId, label: "An archived list" }] : []),
                ]}
              />
            )}
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

      <NewContactModal
        key={state.listId}
        open={creating}
        onOpenChange={setCreating}
        listId={state.listId || undefined}
        onCreated={(c) => router.push(ws.href(`/contacts/${c.id}`))}
      />
    </Page>
  );
}
