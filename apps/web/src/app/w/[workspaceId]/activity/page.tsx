"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Activity, Cpu, ListFilter, Plug, Sparkles, Users, Workflow, X } from "lucide-react";
import { ACTOR_META, ActorLabel, type ActorType } from "@/components/activity/ActorLabel";
import { DigestCard } from "@/components/activity/DigestCard";
import { Segments } from "@/components/crm/ContactListView";
import { markFor } from "@/components/crm/Timeline";
import { Avatar } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { IconBadge } from "@/components/ui/IconTile";
import { NativeSelect } from "@/components/ui/Input";
import { Page, PageHeader } from "@/components/ui/PageHeader";
import { RequirePermission } from "@/components/ui/RequirePermission";
import { SkeletonText } from "@/components/ui/Skeleton";
import { StatCard } from "@/components/ui/StatCard";
import { EntityTile } from "@/components/ui/icons";
import { get } from "@/lib/api";
import { cn } from "@/lib/cn";
import { formatNumber } from "@/lib/format";
import { useApiQuery } from "@/lib/query";
import { useFormat, useWorkspace } from "@/lib/session";

/* GET /activity and /activity/summary — apps/api/src/crm/activity-feed.service.ts */
type FeedItem = {
  id: string;
  type: string;
  summary: string;
  occurredAt: string;
  actor: { type: string; name: string; id: string | null; ref: string; onBehalfOf: { id: string; name: string } | null };
  contact: { id: string; fullName: string; firstName: string; lastName: string; email: string | null } | null;
  deal: { id: string; name: string } | null;
  company: { id: string; name: string } | null;
};
type FeedPage = { items: FeedItem[]; nextCursor: string | null };
type Summary = { byActorType: Record<ActorType, number>; byPerson: { userId: string; name: string; email: string; own: number; byAi: number }[] };

type Range = "today" | "7d" | "30d";
const RANGES: { value: Range; label: string }[] = [
  { value: "today", label: "Today" },
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
];
const sinceOf = (r: Range) => {
  const d = new Date();
  if (r === "today") d.setHours(0, 0, 0, 0);
  else d.setDate(d.getDate() - (r === "7d" ? 7 : 30));
  return d.toISOString();
};

/** What it was about: a prefix of the activity type ("deal." matches every deal event). */
const KINDS: { value: string; label: string }[] = [
  { value: "", label: "Everything" },
  { value: "deal.", label: "Deals" },
  { value: "contact.", label: "Contacts & leads" },
  { value: "task.", label: "Tasks" },
  { value: "email.", label: "Email" },
  { value: "conversation.", label: "Inbox" },
  { value: "call.", label: "Calls" },
  { value: "meeting.", label: "Meetings" },
  { value: "note.", label: "Notes" },
  { value: "campaign.", label: "Campaigns" },
  { value: "marketing.", label: "Email marketing" },
];

const ACTOR_CARDS: { type: ActorType; icon: React.ReactNode; tint: "blue" | "purple" | "indigo" | "teal" | "gray" }[] = [
  { type: "user", icon: <Users />, tint: "blue" },
  { type: "ai_agent", icon: <Sparkles />, tint: "purple" },
  { type: "workflow", icon: <Workflow />, tint: "indigo" },
  { type: "integration", icon: <Plug />, tint: "teal" },
  { type: "system", icon: <Cpu />, tint: "gray" },
];

function dayLabel(iso: string, f: ReturnType<typeof useFormat>) {
  const d = new Date(iso);
  const today = new Date();
  const y = new Date(today);
  y.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === y.toDateString()) return "Yesterday";
  return f.date(iso, "long");
}

function Subject({ item }: { item: FeedItem }) {
  const ws = useWorkspace();
  const c = item.contact;
  const name = c ? c.fullName || [c.firstName, c.lastName].filter(Boolean).join(" ") || c.email || "a contact" : null;
  return (
    <span className="inline-flex min-w-0 flex-wrap items-center gap-x-1.5">
      {c && name && (
        <Link href={ws.href(`/contacts/${c.id}`)} className="truncate font-medium text-text hover:text-accent-hi hover:underline">
          {name}
        </Link>
      )}
      {item.deal && (
        <Link href={ws.href(`/deals?deal=${item.deal.id}`)} className="truncate text-text-2 hover:text-accent-hi hover:underline">
          {c ? "· " : ""}
          {item.deal.name}
        </Link>
      )}
      {!c && !item.deal && item.company && (
        <Link href={ws.href(`/companies/${item.company.id}`)} className="truncate text-text-2 hover:text-accent-hi hover:underline">
          {item.company.name}
        </Link>
      )}
    </span>
  );
}

function Feed() {
  const ws = useWorkspace();
  const f = useFormat();
  const team = ws.can("analytics.team");
  const [range, setRange] = useState<Range>("7d");
  const [actorType, setActorType] = useState<ActorType | "">("");
  const [userId, setUserId] = useState("");
  const [kind, setKind] = useState("");
  const [teamId, setTeamId] = useState("");
  const teams = useApiQuery<{ teams: { id: string; name: string }[] }>(ws.key("teams"), team ? ws.path("/teams") : null);
  const from = useMemo(() => sinceOf(range), [range]);

  const query = { from, ...(actorType ? { actorType } : {}), ...(userId ? { userId } : {}), ...(teamId ? { teamId } : {}), ...(kind ? { type: kind } : {}) };
  const summary = useApiQuery<Summary>(ws.key("activity", "summary", { from, userId, teamId }), ws.path("/activity/summary"), { query: { from, ...(userId ? { userId } : {}), ...(teamId ? { teamId } : {}) } });
  const feed = useInfiniteQuery({
    queryKey: [...ws.key("activity", "feed"), query],
    queryFn: ({ pageParam, signal }) => get<FeedPage>(ws.path("/activity"), { signal, query: { ...query, limit: 50, ...(pageParam ? { cursor: pageParam } : {}) } }),
    initialPageParam: "" as string,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: 60_000,
  });
  const items = feed.data?.pages.flatMap((p) => p.items) ?? [];
  const person = summary.data?.byPerson.find((p) => p.userId === userId);

  // Grouped by day, newest first (the API's order).
  const days: { label: string; items: FeedItem[] }[] = [];
  for (const it of items) {
    const label = dayLabel(it.occurredAt, f);
    if (days.at(-1)?.label !== label) days.push({ label, items: [] });
    days.at(-1)!.items.push(it);
  }

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Segments label="Period" value={range} options={RANGES} onChange={setRange} />
        <NativeSelect icon={<ListFilter />} aria-label="About" className="w-auto min-w-36" value={kind} onChange={(e) => setKind(e.target.value)} options={KINDS} />
        {team && (teams.data?.teams.length ?? 0) > 0 && (
          <NativeSelect
            icon={<Users />}
            aria-label="Team"
            className="w-auto min-w-36"
            value={teamId}
            onChange={(e) => setTeamId(e.target.value)}
            options={[{ value: "", label: "All teams" }, ...(teams.data?.teams ?? []).map((t) => ({ value: t.id, label: t.name }))]}
          />
        )}
        {(actorType || userId || kind || teamId) && (
          <Button
            size="sm"
            variant="ghost"
            icon={<X />}
            onClick={() => {
              setActorType("");
              setUserId("");
              setKind("");
              setTeamId("");
            }}
          >
            Clear filters
          </Button>
        )}
      </div>

      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {ACTOR_CARDS.map((c) => (
          <button key={c.type} type="button" onClick={() => setActorType(actorType === c.type ? "" : c.type)} className="text-left">
            <StatCard
              label={ACTOR_META[c.type].plural}
              value={summary.data ? formatNumber(summary.data.byActorType[c.type] ?? 0) : "—"}
              loading={summary.isPending}
              icon={c.icon}
              tint={c.tint}
              className={cn("transition-shadow", actorType === c.type && "ring-2 ring-accent")}
            />
          </button>
        ))}
      </div>

      {team && summary.data && summary.data.byPerson.length > 0 && (
        <Card className="mb-4 p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-semibold tracking-wide text-text-3 uppercase">By teammate</span>
            {person && (
              <Button size="sm" variant="ghost" icon={<X />} onClick={() => setUserId("")}>
                Everyone
              </Button>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            {summary.data.byPerson.map((p) => (
              <button
                key={p.userId}
                type="button"
                onClick={() => setUserId(userId === p.userId ? "" : p.userId)}
                className={cn(
                  "inline-flex items-center gap-2 rounded-full border border-line px-2.5 py-1 text-xs transition-colors hover:bg-hover",
                  userId === p.userId && "border-accent bg-tint-pick",
                )}
              >
                <Avatar size="xs" name={p.name} email={p.email} />
                <span className="font-medium text-text">{p.name || p.email}</span>
                <span className="text-text-2 tabular-nums">{formatNumber(p.own)}</span>
                {p.byAi > 0 && (
                  <span className="inline-flex items-center gap-0.5 text-[var(--tint-purple)] tabular-nums" title="Done for them by an AI agent">
                    <Sparkles aria-hidden className="size-3" />
                    {formatNumber(p.byAi)}
                  </span>
                )}
              </button>
            ))}
          </div>
        </Card>
      )}

      <Card>
        {feed.isPending ? (
          <div className="p-4">
            <SkeletonText lines={8} />
          </div>
        ) : feed.isError ? (
          <ErrorState error={feed.error as never} onRetry={() => void feed.refetch()} />
        ) : !items.length ? (
          <EmptyState icon={<Activity />} title="Nothing in this period" description="Changes by teammates, AI agents, workflows and integrations show up here as they happen." />
        ) : (
          <div className="flex flex-col">
            {days.map((d) => (
              <section key={d.label}>
                <h2 className="sticky top-12 z-10 border-b border-line bg-panel/95 px-4 py-2 text-xs font-semibold text-text-3 backdrop-blur">{d.label}</h2>
                <ol className="divide-y divide-line">
                  {d.items.map((it) => {
                    const { icon: Icon, tint } = markFor(it.type);
                    return (
                      <li key={it.id} className="flex items-start gap-3 px-4 py-2.5">
                        <IconBadge icon={<Icon />} tint={tint} className="mt-0.5" />
                        <div className="min-w-0 flex-1">
                          <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-sm">
                            <Subject item={it} />
                            <span className="min-w-0 break-words text-text-2">{it.summary}</span>
                          </div>
                          <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1.5 text-xs text-text-3">
                            <ActorLabel actor={it.actor} />
                            <span aria-hidden>·</span>
                            <time dateTime={it.occurredAt} title={f.dateTime(it.occurredAt)}>
                              {f.time(it.occurredAt)}
                            </time>
                          </div>
                        </div>
                      </li>
                    );
                  })}
                </ol>
              </section>
            ))}
            {feed.hasNextPage && (
              <div className="border-t border-line p-3 text-center">
                <Button size="sm" loading={feed.isFetchingNextPage} onClick={() => void feed.fetchNextPage()}>
                  Show more
                </Button>
              </div>
            )}
          </div>
        )}
      </Card>
    </>
  );
}

export default function TeamActivityPage() {
  const ws = useWorkspace();
  return (
    <Page width="full">
      <RequirePermission permission="contacts.read">
        <PageHeader
          title={ws.can("analytics.team") ? "Team activity" : "My activity"}
          icon={<EntityTile of="reports" />}
          description={
            ws.can("analytics.team")
              ? "Everything that happened across the workspace — and who did it: a teammate, an AI agent for a teammate, a workflow, an integration or Growthdesk itself."
              : "What you did, and what AI agents did for you."
          }
        />
        <DigestCard />
        <Feed />
      </RequirePermission>
    </Page>
  );
}
