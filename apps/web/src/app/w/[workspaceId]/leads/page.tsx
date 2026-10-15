"use client";

import { useRouter } from "next/navigation";
import { Suspense, useState } from "react";
import { ListChecks, Plus, Upload, UserPlus } from "lucide-react";
import type { LifecycleStage } from "@growthdesk/shared";
import { ContactListView, Segments, useContactQuery } from "@/components/crm/ContactListView";
import { LIST_READ } from "@/components/crm/lifecycle";
import { NewContactModal } from "@/components/crm/NewContactModal";
import { activeFilterCount, useContactListState } from "@/components/crm/contactListState";
import { useMarketing, useMarketingLists } from "@/components/marketing/common";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { EntityTile } from "@/components/ui/icons";
import { NativeSelect } from "@/components/ui/Input";
import { Page, PageHeader } from "@/components/ui/PageHeader";
import { RequirePermission } from "@/components/ui/RequirePermission";
import { LoadingBlock } from "@/components/ui/Skeleton";
import { Switch } from "@/components/ui/Switch";
import { formatNumber } from "@/lib/format";
import { useWorkspace } from "@/lib/session";

export default function LeadsPage() {
  return (
    <RequirePermission permission="contacts.read">
      <Suspense fallback={<LoadingBlock />}>
        <Leads />
      </Suspense>
    </RequirePermission>
  );
}

/** Leads shows the lead stage unless the tabs say In sales. */
const DEFAULTS = { stage: ["lead"] as const satisfies readonly LifecycleStage[] };
type Tab = "lead" | "sales";
const TABS: { value: Tab; label: string }[] = [
  { value: "lead", label: "Leads" },
  { value: "sales", label: "In sales" },
];

/**
 * People not yet customers: imported leads (by lead list) and the ones handed
 * to sales. The same table as Contacts, narrowed by stage.
 */
function Leads() {
  const ws = useWorkspace();
  const router = useRouter();
  const mk = useMarketing();
  const [creating, setCreating] = useState(false);
  const canWrite = ws.can("contacts.write");
  const { state, update, clearFilters } = useContactListState(DEFAULTS);
  const { contacts, query } = useContactQuery(state);
  const canLists = ws.can(LIST_READ);
  const lists = useMarketingLists();
  const tab: Tab = state.stage.length === 1 && state.stage[0] === "sales" ? "sales" : "lead";
  const narrowed = activeFilterCount(state) > 0 || Boolean(state.q) || Boolean(state.listId);
  const listName = lists.data?.find((l) => l.id === state.listId)?.name;

  return (
    <Page width="full">
      <PageHeader
        title="Leads"
        icon={<EntityTile of="leads" />}
        description={
          contacts.data
            ? `${formatNumber(contacts.data.total)} ${tab === "sales" ? "handed to sales" : "leads"}${listName ? ` on ${listName}` : narrowed ? " matching" : ""}`
            : "People you are prospecting. Qualified leads are transferred to sales; a won deal or a held meeting makes them contacts."
        }
        actions={
          <>
            {canLists && (
              <Button icon={<ListChecks />} href={mk.href("/lists")}>
                Lead lists
              </Button>
            )}
            {ws.can("contacts.import") && (
              <Button icon={<Upload />} href={ws.href(state.listId ? `/imports?listId=${state.listId}` : "/imports")}>
                Import leads
              </Button>
            )}
            {canWrite && (
              <Button variant="primary" icon={<Plus />} onClick={() => setCreating(true)}>
                New lead
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
        noun="leads"
        leads={tab === "lead"}
        savedViews={false}
        controls={
          <>
            <Segments label="Stage" value={tab} options={TABS} onChange={(v) => update({ stage: [v] })} />
            {canLists && (
              <NativeSelect
                size="sm"
                aria-label="Lead list"
                className="w-full sm:w-64"
                value={state.listId}
                disabled={lists.isPending}
                onChange={(e) => update({ listId: e.target.value })}
                options={[
                  { value: "", label: "All lead lists" },
                  ...(lists.data ?? []).map((l) => ({ value: l.id, label: l.name })),
                  // A list from the URL that is archived (not in the active lists) still shows by name.
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
            icon={<UserPlus />}
            tint="mint"
            title={tab === "sales" ? "Nobody is with sales yet" : "No leads yet"}
            description={
              tab === "sales"
                ? "Select leads and choose Transfer to sales to hand them over. Their outreach sequences stop and they show here."
                : "Add leads one at a time, or import a CSV into a lead list, then enroll the list in an outreach campaign."
            }
            action={
              tab === "lead" ? (
                <>
                  {canWrite && (
                    <Button size="sm" variant="primary" icon={<Plus />} onClick={() => setCreating(true)}>
                      New lead
                    </Button>
                  )}
                  {ws.can("contacts.import") && (
                    <Button size="sm" icon={<Upload />} href={ws.href("/imports")}>
                      Import leads
                    </Button>
                  )}
                </>
              ) : undefined
            }
          />
        }
      />

      {/* Keyed by tab and list so a new lead starts at the stage and on the list being looked at. */}
      <NewContactModal
        key={`${tab}:${state.listId}`}
        open={creating}
        onOpenChange={setCreating}
        stage={tab === "sales" ? "sales" : "lead"}
        listId={state.listId || undefined}
        onCreated={(c) => router.push(ws.href(`/contacts/${c.id}`))}
      />
    </Page>
  );
}
