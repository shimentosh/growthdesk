"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";
import {
  ArrowUpRight,
  CalendarClock,
  CalendarDays,
  CalendarPlus,
  CheckSquare,
  ChevronDown,
  ChevronUp,
  Clock,
  Contact as ContactIcon,
  Flag,
  Gauge,
  Globe,
  Handshake,
  LayoutList,
  Link2,
  Mail,
  MapPin,
  MessageSquare,
  Pencil,
  Phone,
  Radar,
  StickyNote,
  Tag,
  TriangleAlert,
  UserRound,
} from "lucide-react";
import { labelOf } from "@growthdesk/shared";
import { ContactLifecycleMenu, StageBadge } from "@/components/crm/lifecycle";
import { EditContactModal } from "@/components/crm/NewContactModal";
import { NotesPanel } from "@/components/crm/NotesPanel";
import { MarketingListsCard } from "@/components/crm/RelatedCards";
import { TagList } from "@/components/crm/Tags";
import { Timeline } from "@/components/crm/Timeline";
import { contactLabel } from "@/components/pickers/Pickers";
import { Avatar } from "@/components/ui/Avatar";
import { Badge, StatusBadge } from "@/components/ui/Badge";
import { Button, IconButton } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { CopyButton } from "@/components/integrations/Copy";
import { Drawer } from "@/components/ui/Drawer";
import { Fact, FactGrid } from "@/components/ui/Fact";
import { ErrorState } from "@/components/ui/ErrorState";
import { SkeletonText } from "@/components/ui/Skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/Tabs";
import { cn } from "@/lib/cn";
import { useApiQuery } from "@/lib/query";
import { useFormat, useWorkspace } from "@/lib/session";
import type { ActivityEntry, ContactDetail, Note } from "@/lib/types/crm";
import { CompanyMark, OwnerCell, PriorityIndicator, QualificationChip, ScoreMeter, StatusChip } from "./ContactCells";

/*
 * A record at a glance, beside the table: who they are, where they stand,
 * what is open (deals, tasks, meetings, conversations), their lists, the
 * latest activity and notes — with the common actions one click away and
 * the full record a link away. Up / down step through the table's rows.
 */

/** A titled card with a glyph and an optional count. */
function Section({ icon, title, count, action, flush, children }: { icon: ReactNode; title: string; count?: number; action?: ReactNode; flush?: boolean; children: ReactNode }) {
  return (
    <Card>
      <CardHeader
        icon={icon}
        title={
          <span className="flex items-center gap-2">
            {title}
            {count !== undefined && count > 0 && <span className="rounded-xs bg-mute-chip px-1.5 text-2xs text-text-2 tabular-nums">{count}</span>}
          </span>
        }
        actions={action}
        className="py-2.5"
      />
      {flush ? children : <CardBody className="p-3">{children}</CardBody>}
    </Card>
  );
}

/** A copyable line of contact info. */
function InfoLine({ icon, children, copy, href }: { icon: ReactNode; children: ReactNode; copy?: string; href?: string }) {
  return (
    <div className="group flex min-w-0 items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-hover">
      <span aria-hidden className="flex shrink-0 text-text-3 [&_svg]:size-4">
        {icon}
      </span>
      {href ? (
        <a
          href={href}
          {...(/^https?:/i.test(href) ? { target: "_blank", rel: "noopener noreferrer" } : {})}
          className="min-w-0 flex-1 truncate text-sm text-text hover:underline"
        >
          {children}
        </a>
      ) : (
        <span className="min-w-0 flex-1 truncate text-sm text-text">{children}</span>
      )}
      {copy && (
        <span className="opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
          <CopyButton value={copy} label="Copy" />
        </span>
      )}
    </div>
  );
}

function RelatedRow({ icon, title, sub, right, href }: { icon: ReactNode; title: ReactNode; sub?: ReactNode; right?: ReactNode; href?: string }) {
  const inner = (
    <>
      <span aria-hidden className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-s-3 text-text-2 [&_svg]:size-4">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm text-text">{title}</span>
        {sub && <span className="block truncate text-xs text-text-3">{sub}</span>}
      </span>
      {right && <span className="shrink-0">{right}</span>}
    </>
  );
  const cls = "flex items-center gap-2.5 rounded-md px-2 py-2";
  return href ? (
    <Link href={href} className={cn(cls, "hover:bg-hover")}>
      {inner}
    </Link>
  ) : (
    <div className={cls}>{inner}</div>
  );
}

function Overview({ c, notes }: { c: ContactDetail; notes: { data: Note[] | undefined; loading: boolean } }) {
  const ws = useWorkspace();
  const f = useFormat();
  const now = Date.now();
  const overdue = c.nextActionAt ? new Date(c.nextActionAt).getTime() < now : false;
  const openDeals = c.deals.filter((d) => d.status === "open");
  const upcoming = c.meetings.filter((m) => new Date(m.startsAt).getTime() >= now - 60 * 60_000);
  const openCount = c.deals.length + c.tasks.length + upcoming.length + Math.min(c.conversations.length, 3);
  const location = [c.city, c.country].filter(Boolean).join(", ");
  const website = c.website ? (/^https?:\/\//i.test(c.website) ? c.website : `https://${c.website}`) : null;

  return (
    <div className="flex flex-col gap-4">
      {(c.email || c.phone || location || website) && (
        <Section icon={<ContactIcon />} title="Contact">
          <div className="-mx-1 flex flex-col">
            {c.email && (
              <InfoLine icon={<Mail />} copy={c.email} href={`mailto:${c.email}`}>
                {c.email}
              </InfoLine>
            )}
            {c.phone && (
              <InfoLine icon={<Phone />} copy={c.phone} href={`tel:${c.phone}`}>
                <span className="tabular-nums">{c.phone}</span>
              </InfoLine>
            )}
            {website && (
              <InfoLine icon={<Globe />} href={website}>
                {c.website}
              </InfoLine>
            )}
            {location && <InfoLine icon={<MapPin />}>{location}</InfoLine>}
          </div>
        </Section>
      )}

      <Section icon={<LayoutList />} title="At a glance" flush>
        <FactGrid className="rounded-b-xl">
          <Fact icon={<UserRound />} label="Owner">
            {c.owner ? <OwnerCell owner={c.owner} /> : null}
          </Fact>
          <Fact icon={<Gauge />} label="Score">
            {c.score !== null && c.score !== undefined ? <ScoreMeter value={c.score} /> : null}
          </Fact>
          <Fact icon={<Flag />} label="Priority">
            {c.priority ? <PriorityIndicator value={c.priority} /> : null}
          </Fact>
          <Fact icon={<Radar />} label="Lead source">
            {c.leadSource || null}
          </Fact>
          <Fact icon={<Clock />} label="Last contacted">
            {c.lastContactedAt ? f.relative(c.lastContactedAt) : "Never"}
          </Fact>
          <Fact icon={<CalendarClock />} label={overdue ? "Next action · overdue" : "Next action"} hint={c.nextActionNote || null} tone={overdue ? "bad" : undefined}>
            {c.nextActionAt ? f.smart(c.nextActionAt) : null}
          </Fact>
          <Fact icon={<CalendarPlus />} label="Added">
            {f.date(c.createdAt)}
          </Fact>
          <Fact icon={<Handshake />} label="Open deals">
            {openDeals.length ? `${openDeals.length} · ${f.money(openDeals.reduce((n, d) => n + d.value, 0), openDeals[0]!.currency)}` : "None"}
          </Fact>
        </FactGrid>
      </Section>

      <Section icon={<Tag />} title="Tags" count={c.tags.length}>
        {c.tags.length ? <TagList tags={c.tags} max={20} /> : <p className="text-xs text-text-3">No tags yet.</p>}
      </Section>

      <Section icon={<CheckSquare />} title="Open now" count={openCount}>
        {!openCount ? (
          <p className="text-xs text-text-3">No deals, tasks, meetings or conversations yet.</p>
        ) : (
          <div className="-mx-1 flex flex-col">
            {c.deals.map((d) => (
              <RelatedRow
                key={d.id}
                icon={<Handshake />}
                title={d.name}
                sub={`${d.stage.name} · ${f.money(d.value, d.currency)}`}
                right={<StatusBadge value={d.status} />}
                href={ws.can("deals.read") ? ws.href(`/deals?deal=${d.id}`) : undefined}
              />
            ))}
            {c.tasks.map((t) => {
              const late = t.dueAt ? new Date(t.dueAt).getTime() < now : false;
              return (
                <RelatedRow
                  key={t.id}
                  icon={<CheckSquare />}
                  title={t.title}
                  sub={labelOf(t.type)}
                  right={<span className={cn("text-xs", late ? "text-bad-ink" : "text-text-3")}>{t.dueAt ? f.smart(t.dueAt) : "No due date"}</span>}
                  href={ws.can("tasks.read") ? ws.href(`/tasks?task=${t.id}`) : undefined}
                />
              );
            })}
            {upcoming.map((m) => (
              <RelatedRow key={m.id} icon={<CalendarDays />} title={m.title} sub={f.dateTime(m.startsAt)} right={<StatusBadge value={m.status} />} href={ws.href("/meetings")} />
            ))}
            {c.conversations.slice(0, 3).map((cv) => (
              <RelatedRow
                key={cv.id}
                icon={<MessageSquare />}
                title={cv.subject || labelOf(cv.channel)}
                sub={`${labelOf(cv.channel)}${cv.lastMessageAt ? ` · ${f.smart(cv.lastMessageAt)}` : ""}`}
                right={cv.unread ? <Badge tone="live">Unread</Badge> : undefined}
                href={ws.can("inbox.read") ? ws.href(`/inbox?c=${cv.id}`) : undefined}
              />
            ))}
          </div>
        )}
      </Section>

      <MarketingListsCard contact={c} />

      <Section icon={<StickyNote />} title="Notes" count={notes.data?.length}>
        <NotesPanel
          notes={notes.data}
          loading={notes.loading}
          addPath={ws.path(`/contacts/${c.id}/notes`)}
          invalidate={[ws.key("contacts", "notes", c.id), ws.key("contacts", "timeline", c.id)]}
        />
      </Section>
    </div>
  );
}

function Body({ id, onEdit }: { id: string; onEdit: (c: ContactDetail) => void }) {
  const ws = useWorkspace();
  const f = useFormat();
  const contact = useApiQuery<ContactDetail>(ws.key("contacts", "detail", id), ws.path(`/contacts/${id}`));
  const notes = useApiQuery<Note[]>(ws.key("contacts", "notes", id), ws.path(`/contacts/${id}/notes`));
  const timeline = useApiQuery<ActivityEntry[]>(ws.key("contacts", "timeline", id), ws.path(`/contacts/${id}/timeline`));

  if (contact.isPending) return <SkeletonText lines={8} />;
  if (contact.isError) return <ErrorState compact error={contact.error} onRetry={() => void contact.refetch()} />;
  const c = contact.data;
  const name = contactLabel(c);
  const warnings = [
    c.doNotContact ? "Marked do not contact." : null,
    c.suppressed,
    c.unsubscribedAt ? `Unsubscribed ${f.date(c.unsubscribedAt)}.` : null,
    c.bouncedAt ? `Email bounced ${f.date(c.bouncedAt)}.` : null,
  ].filter((w): w is string => Boolean(w));
  const website = c.website ? (/^https?:\/\//i.test(c.website) ? c.website : `https://${c.website}`) : null;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-1.5">
        <StageBadge stage={c.lifecycleStage} />
        <StatusChip value={c.status} />
        <QualificationChip value={c.qualification} />
        {c.archivedAt && <Badge>Archived</Badge>}
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {c.email && (
          <Button size="sm" icon={<Mail />} href={`mailto:${c.email}`} title={c.email}>
            Email
          </Button>
        )}
        {c.phone && (
          <Button size="sm" icon={<Phone />} href={`tel:${c.phone}`} title={c.phone}>
            Call
          </Button>
        )}
        {website && (
          <Button size="sm" icon={<Globe />} href={website} external title={website}>
            Website
          </Button>
        )}
        {c.linkedinUrl && (
          <Button size="sm" icon={<Link2 />} href={c.linkedinUrl} external>
            LinkedIn
          </Button>
        )}
        <span className="flex-1" />
        {ws.can("contacts.write") && (
          <Button size="sm" variant="ghost" icon={<Pencil />} onClick={() => onEdit(c)}>
            Edit
          </Button>
        )}
        <ContactLifecycleMenu contact={c} name={name} />
      </div>

      {warnings.length > 0 && (
        <Callout tone="warn" title="Contact restrictions">
          <span className="inline-flex items-start gap-1.5">
            <TriangleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />
            {warnings.join(" ")}
          </span>
        </Callout>
      )}

      <Tabs defaultValue="overview">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="activity">Activity</TabsTrigger>
        </TabsList>
        <TabsContent value="overview" className="pt-4">
          <Overview c={c} notes={{ data: notes.data, loading: notes.isPending }} />
        </TabsContent>
        <TabsContent value="activity" className="pt-4">
          {timeline.isError ? (
            <ErrorState compact error={timeline.error} onRetry={() => void timeline.refetch()} />
          ) : (
            <Timeline entries={timeline.data?.slice(0, 30)} loading={timeline.isPending} limitNote="The latest 30 events — the full record shows more." />
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}

/**
 * The side panel. `ids` is the order of the rows on screen, for previous /
 * next; `summary` is the row already loaded, so the header shows at once.
 */
export function ContactPeek({
  id,
  ids,
  summary,
  onOpenChange,
  onMove,
}: {
  id: string | null;
  ids: string[];
  summary?: { fullName: string; firstName: string; lastName: string; email: string | null; phone: string | null; jobTitle: string; company: { name: string } | null };
  onOpenChange: (open: boolean) => void;
  onMove: (id: string) => void;
}) {
  const ws = useWorkspace();
  const [editing, setEditing] = useState<ContactDetail | null>(null);
  const at = id ? ids.indexOf(id) : -1;
  const prev = at > 0 ? ids[at - 1] : undefined;
  const next = at >= 0 && at < ids.length - 1 ? ids[at + 1] : undefined;
  const name = summary ? contactLabel(summary) : "Contact";
  const subtitle = summary ? [summary.jobTitle, summary.company?.name].filter(Boolean).join(" at ") : "";

  return (
    <>
      <Drawer
        open={Boolean(id)}
        onOpenChange={onOpenChange}
        width="lg"
        modal={false}
        dismissOnOutside={false}
        icon={<Avatar size="lg" name={summary?.fullName} email={summary?.email} colored />}
        title={name}
        description={
          subtitle ? (
            <span className="inline-flex items-center gap-1.5">
              {summary?.company && <CompanyMark name={summary.company.name} />}
              {subtitle}
            </span>
          ) : undefined
        }
        actions={
          <>
            <IconButton size="sm" label="Previous" icon={<ChevronUp />} disabled={!prev} onClick={() => prev && onMove(prev)} />
            <IconButton size="sm" label="Next" icon={<ChevronDown />} disabled={!next} onClick={() => next && onMove(next)} />
            {id && (
              <Button size="sm" icon={<ArrowUpRight />} href={ws.href(`/contacts/${id}`)}>
                Open
              </Button>
            )}
          </>
        }
      >
        {id && <Body key={id} id={id} onEdit={setEditing} />}
      </Drawer>
      {editing && <EditContactModal key={editing.id} open onOpenChange={(o) => !o && setEditing(null)} contact={editing} />}
    </>
  );
}
