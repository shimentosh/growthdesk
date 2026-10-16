"use client";

import { StageBadge } from "@/components/crm/lifecycle";
import { OwnerCell, QualificationChip } from "@/components/crm/ContactCells";
import { MarketingListsCard } from "@/components/crm/RelatedCards";
import { TagList } from "@/components/crm/Tags";
import { KeyValueList } from "@/components/ui/KeyValue";
import { Skeleton } from "@/components/ui/Skeleton";
import { useApiQuery } from "@/lib/query";
import { useWorkspace } from "@/lib/session";
import type { ContactDetail } from "@/lib/types/crm";

/*
 * The CRM side of the conversation's contact, for the inbox's context pane:
 * lifecycle stage, owner and tags (ContactRecordFacts) and their marketing
 * lists (ContactListsBlock). Both read GET /contacts/:id under the same query
 * key as the contact page and peek, so they share one request and cache.
 * Without contacts.read they render nothing.
 */

function useContact(id: string) {
  const ws = useWorkspace();
  const can = ws.can("contacts.read");
  return { can, query: useApiQuery<ContactDetail>(ws.key("contacts", "detail", id), can ? ws.path(`/contacts/${id}`) : null) };
}

export function ContactRecordFacts({ contactId }: { contactId: string }) {
  const { can, query } = useContact(contactId);
  if (!can || query.isError) return null;
  const c = query.data;
  if (!c) return <Skeleton className="h-16 w-full" />;
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <StageBadge stage={c.lifecycleStage} />
        <QualificationChip value={c.qualification} />
      </div>
      <KeyValueList
        items={[
          { label: "Owner", value: <OwnerCell owner={c.owner} /> },
          { label: "Tags", value: c.tags.length ? <TagList tags={c.tags} max={6} /> : null },
        ]}
      />
    </div>
  );
}

export function ContactListsBlock({ contactId }: { contactId: string }) {
  const { can, query } = useContact(contactId);
  if (!can || !query.data) return null;
  return (
    <div className="border-b border-line p-3 last:border-b-0">
      <MarketingListsCard contact={query.data} />
    </div>
  );
}
