"use client";

import Link from "next/link";
import { useState } from "react";
import { AlarmClock, CircleAlert, ClipboardPen, Clock, Ellipsis, FileText, Globe, History, ListFilter, ListPlus, ListTodo, Phone, PhoneCall, Plus, Settings2, UserRound, X } from "lucide-react";
import { CALL_OUTCOMES, CALL_STATUSES, labelOf } from "@growthdesk/shared";
import { AddToQueueModal } from "@/components/calls/AddToQueueModal";
import { CallDrawer, type CallDrawerProps } from "@/components/calls/CallDrawer";
import { CallScriptsPanel } from "@/components/calls/CallScripts";
import { useCallSetup } from "@/components/calls/callHooks";
import { useMembers } from "@/components/pickers/Pickers";
import { Segmented, useSearchState, ViewTabs } from "@/components/pipeline/controls";
import { Avatar } from "@/components/ui/Avatar";
import { Badge, StatusBadge } from "@/components/ui/Badge";
import { Button, IconButton } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Card } from "@/components/ui/Card";
import { ConfirmDialog } from "@/components/ui/Dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/DropdownMenu";
import { EmptyState } from "@/components/ui/EmptyState";
import { QueryState } from "@/components/ui/ErrorState";
import { ENTITY, EntityTile } from "@/components/ui/icons";
import { NativeSelect } from "@/components/ui/Input";
import { Page, PageHeader } from "@/components/ui/PageHeader";
import { Pagination } from "@/components/ui/Pagination";
import { RequirePermission } from "@/components/ui/RequirePermission";
import { SkeletonText } from "@/components/ui/Skeleton";
import { cn } from "@/lib/cn";
import { formatDuration } from "@/lib/format";
import { useApiMutation, useApiQuery } from "@/lib/query";
import { useFormat, useWorkspace } from "@/lib/session";
import type { Paged } from "@/lib/types";
import type { CallQueueItem, CallRow } from "@/lib/types/calls";

const PAGE_SIZE = 50;
type Tab = "queue" | "history" | "scripts";

export default function CallsPage() {
  return (
    <Page width="full">
      <RequirePermission permission="calls.read">
        <Calls />
      </RequirePermission>
    </Page>
  );
}

function Calls() {
  const ws = useWorkspace();
  const search = useSearchState();
  const setup = useCallSetup();
  const canCall = ws.can("calls.make");
  const tab: Tab = (["queue", "history", "scripts"] as const).find((t) => t === search.get("tab")) ?? "queue";
  // One drawer for the page: placing a call from the queue, logging one, or recording an outcome from the history.
  const [drawer, setDrawer] = useState<Omit<CallDrawerProps, "open" | "onOpenChange"> | null>(null);
  const [adding, setAdding] = useState(false);

  const reason = setup.data?.clickToCall.reason;
  const notConnected = setup.data && !setup.data.twilio.length;

  return (
    <>
      <PageHeader
        icon={<EntityTile of="calls" />}
        title="Calls"
        description="Work through your call list one contact at a time, read from a script, and record how each call went. Calls are not recorded."
        actions={
          canCall ? (
            <>
              <Button icon={<ListPlus />} onClick={() => setAdding(true)}>
                Add to call list
              </Button>
              <Button variant="primary" icon={<Plus />} onClick={() => setDrawer({})}>
                Log a call
              </Button>
            </>
          ) : undefined
        }
      />

      {canCall && setup.data && !setup.data.clickToCall.available && (
        <Callout
          tone="info"
          className="mb-4"
          title={notConnected ? "Calls are dialled from your own phone" : "Click-to-call is unavailable"}
          action={
            ws.can("integrations.read") ? (
              <Button size="sm" variant="ghost" icon={<Settings2 />} href={ws.href("/settings/calling")}>
                Calling settings
              </Button>
            ) : undefined
          }
        >
          {notConnected
            ? "Connect a Twilio account to place calls from here: Twilio rings your phone and connects you to the contact. Until then, dial from your phone and log each call."
            : reason}
        </Callout>
      )}

      <ViewTabs
        aria-label="Calls"
        value={tab}
        onChange={(v) =>
          search.set({
            tab: v === "queue" ? null : v,
            scope: null,
            window: null,
            outcome: null,
            status: null,
            user: null,
          })
        }
        options={[
          { value: "queue", label: "Call list", icon: <ListTodo /> },
          { value: "history", label: "History", icon: <History /> },
          { value: "scripts", label: "Scripts", icon: <FileText /> },
        ]}
      />

      <div className="mt-4">
        {tab === "queue" && <QueuePanel onCall={setDrawer} onAdd={() => setAdding(true)} />}
        {tab === "history" && <HistoryPanel onOpen={(call) => setDrawer({ call })} />}
        {tab === "scripts" && <CallScriptsPanel />}
      </div>

      <CallDrawer open={drawer !== null} onOpenChange={(o) => !o && setDrawer(null)} {...(drawer ?? {})} />
      <AddToQueueModal open={adding} onOpenChange={setAdding} />
    </>
  );
}

// ─── Call list ─────────────────────────────────────────────────────────────────

/** One item in a row's detail line: a small glyph, then the text. */
const meta = "inline-flex items-center gap-1";

function QueuePanel({ onCall, onAdd }: { onCall: (d: Omit<CallDrawerProps, "open" | "onOpenChange">) => void; onAdd: () => void }) {
  const ws = useWorkspace();
  const f = useFormat();
  const search = useSearchState();
  const canCall = ws.can("calls.make");
  const scope = search.get("scope") === "team" ? "team" : "mine";
  const when = search.get("window") === "all" ? "all" : "today";
  const [page, setPage] = useState(1);
  const [removing, setRemoving] = useState<CallQueueItem | null>(null);
  const query = { scope, window: when, page, pageSize: PAGE_SIZE };
  const list = useApiQuery<Paged<CallQueueItem>>(ws.key("calls", "queue"), ws.path("/calls/queue"), { query, keepPrevious: true });
  const remove = useApiMutation<unknown, CallQueueItem>({
    method: "DELETE",
    path: (i) => ws.path(`/calls/queue/${i.taskId}`),
    invalidate: [ws.key("calls"), ws.key("tasks")],
    success: "Removed from the call list",
    errorToast: false,
  });

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Segmented
          aria-label="Whose calls"
          value={scope}
          onChange={(v) => {
            setPage(1);
            search.set({ scope: v === "mine" ? null : v });
          }}
          options={[
            { value: "mine", label: "Mine" },
            { value: "team", label: "Everyone's" },
          ]}
        />
        <Segmented
          aria-label="When"
          value={when}
          onChange={(v) => {
            setPage(1);
            search.set({ window: v === "today" ? null : v });
          }}
          options={[
            { value: "today", label: "Due today" },
            { value: "all", label: "All open" },
          ]}
        />
        <span className="text-xs text-text-3">Call tasks from sequences, callbacks and contacts you add. Times in {ws.timezone}.</span>
      </div>

      <Card>
        <QueryState
          query={list}
          loading={<SkeletonText lines={6} className="p-4" />}
          isEmpty={(d) => d.items.length === 0}
          empty={
            <EmptyState
              icon={<Phone />}
              tint={ENTITY.calls.tint}
              title={when === "today" ? "Nobody left to call today" : "Your call list is empty"}
              description="Add contacts here or from a contact's page. Sequences with call steps and callbacks you schedule land here too."
              action={
                canCall ? (
                  <Button icon={<ListPlus />} onClick={onAdd}>
                    Add to call list
                  </Button>
                ) : undefined
              }
            />
          }
        >
          {(data) => (
            <>
              <ul className="divide-y divide-line">
                {data.items.map((i) => {
                  const overdue = i.dueAt !== null && new Date(i.dueAt).getTime() < Date.now();
                  const who = i.contact ? i.contact.fullName || i.contact.email || i.contact.phone || "Unnamed contact" : "No contact";
                  return (
                    <li key={i.taskId} className="flex flex-wrap items-start gap-3 px-4 py-3 hover:bg-hover">
                      <Avatar name={i.contact?.fullName} email={i.contact?.email} className="mt-0.5" />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          {i.contact ? (
                            <Link href={ws.href(`/contacts/${i.contact.id}`)} className="text-sm font-medium text-text hover:text-accent-hi">
                              {who}
                            </Link>
                          ) : (
                            <span className="text-sm font-medium text-text-3">{who}</span>
                          )}
                          {i.contact?.jobTitle || i.contact?.company ? (
                            <span className="text-xs text-text-3">{[i.contact.jobTitle, i.contact.company?.name].filter(Boolean).join(" at ")}</span>
                          ) : null}
                          {i.source !== "manual" && <Badge quiet>{labelOf(i.source)}</Badge>}
                        </div>
                        <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-text-3">
                          <span className={cn(meta, "text-text-2 tabular-nums")}>
                            <Phone aria-hidden className="size-3" />
                            {i.contact?.phone || "No phone"}
                          </span>
                          <span className={cn(meta, overdue && "font-medium text-bad-ink")}>
                            {overdue ? <AlarmClock aria-hidden className="size-3" /> : <Clock aria-hidden className="size-3" />}
                            {i.dueAt ? `${overdue ? "Overdue · " : "Due "}${f.smart(i.dueAt)}` : "No due date"}
                          </span>
                          {i.contact?.timezone && (
                            <span className={meta}>
                              <Globe aria-hidden className="size-3" />
                              Their time zone: {i.contact.timezone}
                            </span>
                          )}
                          {i.lastCall && (
                            <span className={meta}>
                              <History aria-hidden className="size-3" />
                              Last call {f.relative(i.lastCall.createdAt)} · {labelOf(i.lastCall.outcome || i.lastCall.status)}
                            </span>
                          )}
                          {scope === "team" && (
                            <span className={meta}>
                              <UserRound aria-hidden className="size-3" />
                              {i.assignee?.name ?? "Unassigned"}
                            </span>
                          )}
                        </div>
                        {i.title !== `Call ${who}` && <p className="mt-0.5 text-xs text-text-2">{i.title}</p>}
                        {i.description && <p className="mt-0.5 line-clamp-2 text-xs text-text-2">{i.description}</p>}
                        {i.blocked && (
                          <p className="mt-1 flex items-center gap-1 text-xs text-bad-ink">
                            <CircleAlert aria-hidden className="size-3.5" />
                            {i.blocked}
                          </p>
                        )}
                      </div>
                      {canCall && (
                        <div className="flex shrink-0 items-center gap-1">
                          <Button
                            size="sm"
                            variant="primary"
                            icon={<PhoneCall />}
                            disabled={Boolean(i.blocked)}
                            onClick={() =>
                              i.contact &&
                              onCall({
                                contact: i.contact,
                                taskId: i.taskId,
                                dealId: i.deal?.id ?? null,
                                blocked: i.blocked,
                              })
                            }
                          >
                            Call
                          </Button>
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <IconButton size="sm" label={`More for ${who}`} icon={<Ellipsis />} />
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem icon={<X />} onSelect={() => setRemoving(i)}>
                                Remove from list
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
              {data.total > data.pageSize && (
                <Pagination className="border-t border-line px-4 py-2" page={data.page} pageSize={data.pageSize} total={data.total} onPageChange={setPage} />
              )}
            </>
          )}
        </QueryState>
      </Card>

      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(o) => !o && setRemoving(null)}
        title="Remove from the call list?"
        description="The call task is canceled, not deleted, so it stays on the record. Nobody is called."
        confirmLabel="Remove"
        onConfirm={() => (removing ? remove.mutateAsync(removing) : undefined)}
      />
    </>
  );
}

// ─── History ───────────────────────────────────────────────────────────────────

function HistoryPanel({ onOpen }: { onOpen: (call: CallRow) => void }) {
  const ws = useWorkspace();
  const f = useFormat();
  const search = useSearchState();
  const members = useMembers();
  const seeAll = ws.can("records.view_all");
  const outcome = search.get("outcome");
  const status = search.get("status");
  const user = search.get("user");
  const [page, setPage] = useState(1);
  const query = { outcome, status, userId: user, page, pageSize: PAGE_SIZE };
  const list = useApiQuery<Paged<CallRow>>(ws.key("calls", "list"), ws.path("/calls"), { query, keepPrevious: true });
  const setFilter = (patch: Record<string, string | null>) => {
    setPage(1);
    search.set(patch);
  };
  const filtered = Boolean(outcome || status || user);

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <NativeSelect
          aria-label="Outcome"
          className="w-auto min-w-40"
          value={outcome}
          onChange={(e) => setFilter({ outcome: e.target.value || null })}
          options={[{ value: "", label: "Any outcome" }, { value: "none", label: "Needs an outcome" }, ...CALL_OUTCOMES.map((o) => ({ value: o, label: labelOf(o) }))]}
        />
        <NativeSelect
          aria-label="Status"
          className="w-auto min-w-36"
          value={status}
          onChange={(e) => setFilter({ status: e.target.value || null })}
          options={[{ value: "", label: "Any status" }, ...CALL_STATUSES.map((s) => ({ value: s, label: labelOf(s) }))]}
        />
        {seeAll && (
          <NativeSelect
            aria-label="Caller"
            className="w-auto min-w-36"
            value={user}
            onChange={(e) => setFilter({ user: e.target.value || null })}
            options={[
              { value: "", label: "Anyone" },
              { value: "me", label: "Me" },
              ...(members.data?.members ?? []).map((m) => ({
                value: m.userId,
                label: m.name || m.email,
              })),
            ]}
          />
        )}
        {filtered && (
          <Button variant="ghost" size="sm" icon={<X />} onClick={() => setFilter({ outcome: null, status: null, user: null })}>
            Clear filters
          </Button>
        )}
      </div>

      <Card>
        <QueryState
          query={list}
          loading={<SkeletonText lines={6} className="p-4" />}
          isEmpty={(d) => d.items.length === 0}
          empty={
            filtered ? (
              <EmptyState compact icon={<ListFilter />} title="No calls match these filters" description="Try another outcome, status or caller, or clear the filters." />
            ) : (
              <EmptyState icon={<History />} tint={ENTITY.calls.tint} title="No calls yet" description="Calls you place or log appear here, with their outcome and notes." />
            )
          }
        >
          {(data) => (
            <>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[760px] text-sm">
                  <thead>
                    <tr className="border-b border-line text-left text-xs text-text-3">
                      <th className="px-4 py-2 font-medium">When</th>
                      <th className="px-4 py-2 font-medium">Contact</th>
                      <th className="px-4 py-2 font-medium">Status</th>
                      <th className="px-4 py-2 font-medium">Outcome</th>
                      <th className="px-4 py-2 text-right font-medium">Length</th>
                      <th className="px-4 py-2 font-medium">By</th>
                      <th className="px-4 py-2" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {data.items.map((c) => (
                      <tr key={c.id} className="hover:bg-hover">
                        <td className="px-4 py-2.5 whitespace-nowrap text-text-2" title={f.dateTime(c.startedAt ?? c.createdAt)}>
                          {f.smart(c.startedAt ?? c.createdAt)}
                        </td>
                        <td className="px-4 py-2.5">
                          {c.contact ? (
                            <Link href={ws.href(`/contacts/${c.contact.id}`)} className="text-text hover:text-accent-hi">
                              {c.contact.fullName || c.contact.email || c.contact.phone}
                            </Link>
                          ) : (
                            <span className="text-text-3">No contact</span>
                          )}
                          <div className="text-xs text-text-3 tabular-nums">{c.toNumber}</div>
                        </td>
                        <td className="px-4 py-2.5">
                          <span className="flex items-center gap-1.5">
                            <StatusBadge value={c.status} />
                            <Badge quiet>{c.provider === "twilio" ? "Twilio" : "Logged"}</Badge>
                          </span>
                        </td>
                        <td className="px-4 py-2.5">{c.outcome ? <StatusBadge value={c.outcome} dot={false} /> : <span className="text-xs text-text-3">Not recorded</span>}</td>
                        <td className="px-4 py-2.5 text-right text-text-2 tabular-nums">{c.durationSec ? formatDuration(c.durationSec) : "—"}</td>
                        <td className="px-4 py-2.5 text-text-2">{c.user?.name ?? "—"}</td>
                        <td className="px-4 py-2.5 text-right">
                          <Button
                            size="sm"
                            variant={c.outcome ? "ghost" : "secondary"}
                            icon={!c.outcome && ws.can("calls.make") ? <ClipboardPen /> : undefined}
                            onClick={() => onOpen(c)}
                          >
                            {c.outcome ? "View" : ws.can("calls.make") ? "Record outcome" : "View"}
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {data.total > data.pageSize && (
                <Pagination className="border-t border-line px-4 py-2" page={data.page} pageSize={data.pageSize} total={data.total} onPageChange={setPage} />
              )}
            </>
          )}
        </QueryState>
      </Card>
    </>
  );
}
