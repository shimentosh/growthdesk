"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";
import { Plus } from "lucide-react";
import { labelOf } from "@growthdesk/shared";
import { AddToListModal } from "@/components/marketing/AddToListModal";
import { MembershipBadge, useMarketing } from "@/components/marketing/common";
import { Badge, StatusBadge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, CardHeader } from "@/components/ui/Card";
import { formatDuration } from "@/lib/format";
import { useApiQuery } from "@/lib/query";
import { useFormat, useWorkspace } from "@/lib/session";
import type { ConsentEntry, ContactDetail, RelatedDeal } from "@/lib/types/crm";
import type { ContactListMembership } from "@/lib/types/marketing";

const ROW = "flex items-start justify-between gap-3 px-4 py-2.5";

/** A titled list on a record's side column. Renders nothing when empty unless `empty` is given. */
export function RelatedCard({ title, count, empty, action, children }: { title: string; count: number; empty?: string; action?: ReactNode; children: ReactNode }) {
  if (!count && !empty) return null;
  return (
    <Card>
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            {title}
            {count > 0 && <span className="rounded-xs bg-mute-chip px-1.5 text-2xs text-text-2 tabular-nums">{count}</span>}
          </span>
        }
        actions={action}
      />
      {count ? <ul className="divide-y divide-line">{children}</ul> : <p className="px-4 py-5 text-center text-xs text-text-3">{empty}</p>}
    </Card>
  );
}

function Row({ href, children }: { href?: string; children: ReactNode }) {
  return <li>{href ? <Link href={href} className={`${ROW} hover:bg-hover`}>{children}</Link> : <div className={ROW}>{children}</div>}</li>;
}

function Lines({ title, sub }: { title: ReactNode; sub?: ReactNode }) {
  return (
    <span className="min-w-0">
      <span className="block truncate text-sm text-text">{title}</span>
      {sub && <span className="block truncate text-xs text-text-3">{sub}</span>}
    </span>
  );
}

export function DealsCard({ deals, empty, action }: { deals: RelatedDeal[]; empty?: string; action?: ReactNode }) {
  const ws = useWorkspace();
  const f = useFormat();
  const canDeals = ws.can("deals.read");
  return (
    <RelatedCard title="Deals" count={deals.length} empty={empty} action={action}>
      {deals.map((d) => (
        <Row key={d.id} href={canDeals ? ws.href(`/deals/${d.id}`) : undefined}>
          <Lines title={d.name} sub={d.stage.name} />
          <span className="flex shrink-0 flex-col items-end gap-1">
            <span className="text-sm text-text tabular-nums">{f.money(d.value, d.currency)}</span>
            <StatusBadge value={d.status} />
          </span>
        </Row>
      ))}
    </RelatedCard>
  );
}

/** Everything else GET /contacts/:id returns about the contact: tasks, meetings, sequences, conversations, calls. */
export function ContactActivityCards({ contact }: { contact: ContactDetail }) {
  const ws = useWorkspace();
  const f = useFormat();
  const now = Date.now();
  const canTasks = ws.can("tasks.read");
  const canMeetings = ws.can("deals.read");
  const canInbox = ws.can("inbox.read");
  return (
    <>
      <RelatedCard title="Open tasks" count={contact.tasks.length}>
        {contact.tasks.map((t) => {
          const overdue = t.dueAt ? new Date(t.dueAt).getTime() < now : false;
          return (
            <Row key={t.id} href={canTasks ? ws.href("/tasks") : undefined}>
              <Lines title={t.title} sub={labelOf(t.type)} />
              <span className={overdue ? "shrink-0 text-xs text-bad-ink" : "shrink-0 text-xs text-text-3"}>{t.dueAt ? f.smart(t.dueAt) : "No due date"}</span>
            </Row>
          );
        })}
      </RelatedCard>

      <RelatedCard title="Meetings" count={contact.meetings.length}>
        {contact.meetings.map((m) => (
          <Row key={m.id} href={canMeetings ? ws.href("/meetings") : undefined}>
            <Lines title={m.title} sub={f.dateTime(m.startsAt)} />
            <StatusBadge value={m.status} />
          </Row>
        ))}
      </RelatedCard>

      <RelatedCard title="Sequences" count={contact.enrollments.length}>
        {contact.enrollments.map((e) => (
          <Row key={e.id}>
            <Lines
              title={e.campaign.name}
              sub={e.stopReason || (e.nextRunAt && e.status === "active" ? `Next step ${f.smart(e.nextRunAt)}` : `Enrolled ${f.date(e.enrolledAt)}`)}
            />
            <StatusBadge value={e.status} />
          </Row>
        ))}
      </RelatedCard>

      <RelatedCard title="Conversations" count={contact.conversations.length}>
        {contact.conversations.map((c) => (
          <Row key={c.id} href={canInbox ? ws.href(`/inbox?c=${c.id}`) : undefined}>
            <Lines title={c.subject || labelOf(c.channel)} sub={`${labelOf(c.channel)}${c.lastMessageAt ? ` · ${f.smart(c.lastMessageAt)}` : ""}`} />
            <span className="flex shrink-0 items-center gap-1">
              {c.unread && <Badge tone="live">Unread</Badge>}
              <Badge quiet>{labelOf(c.status)}</Badge>
            </span>
          </Row>
        ))}
      </RelatedCard>

      <RelatedCard title="Calls" count={contact.calls.length}>
        {contact.calls.map((c) => (
          <Row key={c.id}>
            <Lines
              title={`${labelOf(c.direction)} call${c.outcome ? ` · ${labelOf(c.outcome)}` : ""}`}
              sub={`${f.smart(c.startedAt ?? c.createdAt)}${c.durationSec ? ` · ${formatDuration(c.durationSec)}` : ""}`}
            />
            <StatusBadge value={c.status} />
          </Row>
        ))}
      </RelatedCard>
    </>
  );
}

/** Every email and phone on file, and where the contact came from. */
export function IdentityCard({ contact }: { contact: ContactDetail }) {
  const f = useFormat();
  if (!contact.identifiers.length && !contact.sources.length) return null;
  return (
    <Card>
      <CardHeader title="Identifiers & sources" />
      <div className="flex flex-col gap-3 px-4 py-3">
        {contact.identifiers.length > 0 && (
          <ul className="flex flex-col gap-1.5">
            {contact.identifiers.map((i) => (
              <li key={i.id} className="flex items-center justify-between gap-2 text-sm">
                <span className="min-w-0 truncate text-text" title={i.value}>
                  <span className="mr-1.5 text-xs text-text-3">{labelOf(i.kind)}</span>
                  {i.value}
                </span>
                {i.isPrimary && <Badge tone="mute">Primary</Badge>}
              </li>
            ))}
          </ul>
        )}
        {contact.sources.length > 0 && (
          <ul className="flex flex-col gap-1.5 border-t border-line pt-3">
            {contact.sources.map((s) => (
              <li key={s.id} className="flex items-center justify-between gap-2 text-xs">
                <span className="text-text-2">{labelOf(s.source)}</span>
                <span className="text-text-3">{f.date(s.createdAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}

/**
 * Marketing consent: the current answer and every change behind it, newest
 * first. The proof a workspace shows when asked how someone opted in.
 */
export function ConsentCard({ contact }: { contact: ContactDetail }) {
  const ws = useWorkspace();
  const f = useFormat();
  // Keyed under the contact so saving the contact (which may change consent) refetches it.
  const history = useApiQuery<ConsentEntry[]>(ws.key("contacts", contact.id, "consent"), ws.path(`/contacts/${contact.id}/consent`));
  const entries = history.data ?? [];
  return (
    <Card>
      <CardHeader title="Marketing consent" actions={<StatusBadge value={contact.consentStatus} />} />
      {history.isPending ? (
        <p className="px-4 py-5 text-center text-xs text-text-3">Loading…</p>
      ) : history.isError ? (
        <p className="px-4 py-5 text-center text-xs text-text-3">The consent history could not be loaded.</p>
      ) : !entries.length ? (
        <p className="px-4 py-5 text-center text-xs text-text-3">No consent recorded. Marketing emails will not be sent to this contact.</p>
      ) : (
        <ol className="flex flex-col gap-3 px-4 py-3">
          {entries.map((e, i) => (
            <li key={e.id} className="relative flex gap-3 pl-4">
              <span
                aria-hidden
                className={`absolute top-1.5 left-0 size-2 rounded-full ${e.status === "granted" ? "bg-ok" : e.status === "denied" ? "bg-bad" : "bg-text-3"}`}
              />
              {i < entries.length - 1 && <span aria-hidden className="absolute top-4 bottom-[-12px] left-[3.5px] w-px bg-line" />}
              <span className="min-w-0 flex-1">
                <span className="block text-sm text-text">{labelOf(e.status)}</span>
                <span className="block truncate text-xs text-text-3" title={[e.source, e.ip].filter(Boolean).join(" · ")}>
                  {[e.source || labelOf(e.detail.via ?? ""), e.actor?.name].filter(Boolean).join(" · ") || "—"}
                </span>
              </span>
              <span className="shrink-0 text-xs text-text-3" title={f.dateTime(e.createdAt)}>
                {f.date(e.createdAt)}
              </span>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}

/**
 * The marketing lists the contact is on (GET marketing/contacts/:id/lists),
 * with a way to add them to another. Hidden without marketing.read.
 */
export function MarketingListsCard({ contact }: { contact: ContactDetail }) {
  const ws = useWorkspace();
  const mk = useMarketing();
  const f = useFormat();
  const [adding, setAdding] = useState(false);
  const canRead = ws.can("marketing.read");
  const canWrite = ws.can("marketing.write");
  const lists = useApiQuery<ContactListMembership[]>(mk.key("contacts", contact.id, "lists"), canRead ? mk.path(`/contacts/${contact.id}/lists`) : null);
  if (!canRead) return null;
  const rows = lists.data ?? [];
  // Pending memberships can still be completed by adding again; any other list would only come back as "already on it".
  const taken = rows.filter((m) => m.status !== "pending").map((m) => m.list.id);
  const name = contact.fullName || [contact.firstName, contact.lastName].filter(Boolean).join(" ") || contact.email || "this contact";
  return (
    <>
      <RelatedCard
        title="Marketing lists"
        count={rows.length}
        empty={lists.isPending ? "Loading…" : lists.isError ? "The lists could not be loaded." : "Not on any marketing list."}
        action={
          canWrite ? (
            <Button size="sm" variant="ghost" icon={<Plus />} onClick={() => setAdding(true)}>
              Add to list
            </Button>
          ) : undefined
        }
      >
        {rows.map((m) => (
          <Row key={m.id} href={mk.href(`/lists/${m.list.id}`)}>
            <Lines
              title={m.list.name}
              sub={[
                m.status === "unsubscribed" && m.unsubscribedAt
                  ? `Unsubscribed ${f.date(m.unsubscribedAt)}`
                  : m.subscribedAt
                    ? `Since ${f.date(m.subscribedAt)}`
                    : null,
                m.list.archivedAt ? "List archived" : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            />
            <MembershipBadge status={m.status} />
          </Row>
        ))}
      </RelatedCard>
      {canWrite && (
        <AddToListModal open={adding} onOpenChange={setAdding} contactIds={[contact.id]} contactsLabel={name} excludeListIds={taken} />
      )}
    </>
  );
}
