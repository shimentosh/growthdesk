"use client";

import { useParams } from "next/navigation";
import { useState } from "react";
import { Gauge, Mail, MessageCircle, MessagesSquare, Send, Upload, Users } from "lucide-react";
import { labelOf } from "@growthdesk/shared";
import { Badge, StatusBadge } from "@/components/ui/Badge";
import { Callout } from "@/components/ui/Callout";
import { Card, CardHeader } from "@/components/ui/Card";
import { Drawer } from "@/components/ui/Drawer";
import { EmptyState } from "@/components/ui/EmptyState";
import { QueryState } from "@/components/ui/ErrorState";
import { Page, PageHeader } from "@/components/ui/PageHeader";
import { Pagination } from "@/components/ui/Pagination";
import { SearchInput } from "@/components/ui/SearchInput";
import { SkeletonText } from "@/components/ui/Skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/Tabs";
import { cn } from "@/lib/cn";
import { formatNumber } from "@/lib/format";
import { useApiQuery } from "@/lib/query";
import { useFormat } from "@/lib/session";
import type { Paged } from "@/lib/types";
import type { SupportContactRow, SupportConversation, SupportConversationRow, SupportViewSummary } from "@/lib/types/platform";
import { FilterBar, PlatformTile, platformKey, table, TableFooter } from "./common";

/*
 * The support view: a read-only look into a customer workspace, open only
 * while its owner's support access grant is active. The API refuses every
 * request without one, never returns credentials, and writes each look to
 * the workspace's own audit log.
 */

function Overview({ data }: { data: SupportViewSummary }) {
  const f = useFormat();
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader icon={<Mail />} title="Mailboxes" description="Connection and sync state. Passwords, tokens and sign-in user names are never shown." />
        {data.mailboxes.length ? (
          <div className={table.wrap}>
            <table className={table.table}>
              <thead>
                <tr>
                  <th className={table.th}>Mailbox</th>
                  <th className={table.th}>Status</th>
                  <th className={table.th}>Servers</th>
                  <th className={table.th}>Daily limit</th>
                  <th className={table.th}>Last sync</th>
                  <th className={table.th}>Errors</th>
                </tr>
              </thead>
              <tbody>
                {data.mailboxes.map((m) => (
                  <tr key={m.id} className="align-top">
                    <td className={cn(table.td, "max-w-60")}>
                      <div className="truncate">{m.email}</div>
                      <div className="text-xs text-text-3">{labelOf(m.provider)}</div>
                    </td>
                    <td className={table.td}>
                      <StatusBadge value={m.status} />
                    </td>
                    <td className={cn(table.td, "font-mono text-xs text-text-2")}>
                      {m.smtpHost ? `SMTP ${m.smtpHost}:${m.smtpPort}` : "—"}
                      {m.imapEnabled && m.imapHost && <div>IMAP {m.imapHost}:{m.imapPort}</div>}
                    </td>
                    <td className={cn(table.td, "tabular-nums")}>{m.dailyLimit}</td>
                    <td className={cn(table.td, "whitespace-nowrap text-text-2")}>{m.lastSyncedAt ? f.relative(m.lastSyncedAt) : "Never"}</td>
                    <td className={cn(table.td, "max-w-72 text-xs text-bad-ink")}>{[m.lastError, m.syncError].filter(Boolean).join(" · ") || <span className="text-text-3">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState compact icon={<Mail />} title="No mailboxes connected" />
        )}
      </Card>

      <Card>
        <CardHeader icon={<MessageCircle />} title="Channel integrations" description="Secrets and webhook keys are never shown." />
        {data.integrations.length ? (
          <div className={table.wrap}>
            <table className={table.table}>
              <thead>
                <tr>
                  <th className={table.th}>Integration</th>
                  <th className={table.th}>Status</th>
                  <th className={table.th}>Last event</th>
                  <th className={table.th}>Error</th>
                </tr>
              </thead>
              <tbody>
                {data.integrations.map((i) => (
                  <tr key={i.id}>
                    <td className={table.td}>
                      {i.name || labelOf(i.channel)}
                      <div className="text-xs text-text-3">
                        {labelOf(i.channel)} · {labelOf(i.provider)}
                      </div>
                    </td>
                    <td className={table.td}>
                      <StatusBadge value={i.status} />
                    </td>
                    <td className={cn(table.td, "text-text-2")}>{i.lastEventAt ? f.relative(i.lastEventAt) : "Never"}</td>
                    <td className={cn(table.td, "max-w-72 text-xs text-bad-ink")}>{i.lastError || <span className="text-text-3">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState compact icon={<MessageCircle />} title="No integrations connected" />
        )}
      </Card>

      <Card>
        <CardHeader icon={<Send />} title="Campaigns" description="The 25 most recently changed." />
        {data.campaigns.length ? (
          <div className={table.wrap}>
            <table className={table.table}>
              <thead>
                <tr>
                  <th className={table.th}>Campaign</th>
                  <th className={table.th}>Status</th>
                  <th className={table.th}>Enrolled</th>
                  <th className={table.th}>Sent</th>
                  <th className={table.th}>Replies</th>
                  <th className={table.th}>Bounced</th>
                  <th className={table.th}>Failed</th>
                </tr>
              </thead>
              <tbody>
                {data.campaigns.map((c) => (
                  <tr key={c.id}>
                    <td className={cn(table.td, "max-w-72 truncate")}>{c.name}</td>
                    <td className={table.td}>
                      <StatusBadge value={c.status} />
                    </td>
                    <td className={cn(table.td, "tabular-nums")}>{formatNumber(c.enrolledCount)}</td>
                    <td className={cn(table.td, "tabular-nums")}>{formatNumber(c.sentCount)}</td>
                    <td className={cn(table.td, "tabular-nums")}>{formatNumber(c.replyCount)}</td>
                    <td className={cn(table.td, "tabular-nums")}>{formatNumber(c.bounceCount)}</td>
                    <td className={cn(table.td, "tabular-nums")}>{formatNumber(c.failedCount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState compact icon={<Send />} title="No campaigns" />
        )}
      </Card>

      <Card>
        <CardHeader icon={<Upload />} title="Recent imports" />
        {data.imports.length ? (
          <div className={table.wrap}>
            <table className={table.table}>
              <thead>
                <tr>
                  <th className={table.th}>Import</th>
                  <th className={table.th}>Status</th>
                  <th className={table.th}>Rows</th>
                  <th className={table.th}>Created / updated / skipped / failed</th>
                  <th className={table.th}>First errors</th>
                </tr>
              </thead>
              <tbody>
                {data.imports.map((i) => (
                  <tr key={i.id} className="align-top">
                    <td className={table.td}>
                      {i.fileName || labelOf(i.source)}
                      <div className="text-xs text-text-3">{f.dateTime(i.createdAt)}</div>
                    </td>
                    <td className={table.td}>
                      <StatusBadge value={i.status} />
                    </td>
                    <td className={cn(table.td, "tabular-nums")}>
                      {formatNumber(i.processedRows)} / {formatNumber(i.totalRows)}
                    </td>
                    <td className={cn(table.td, "tabular-nums")}>
                      {i.createdCount} / {i.updatedCount} / {i.skippedCount} / {i.failedCount}
                    </td>
                    <td className={cn(table.td, "max-w-80 text-xs text-text-2")}>
                      {i.errors.length ? (
                        <ul className="flex flex-col gap-0.5">
                          {i.errors.map((e, n) => (
                            <li key={n} className="truncate" title={typeof e === "string" ? e : JSON.stringify(e)}>
                              {typeof e === "string" ? e : JSON.stringify(e)}
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <span className="text-text-3">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState compact icon={<Upload />} title="No imports" />
        )}
      </Card>
    </div>
  );
}

function Contacts({ workspaceId }: { workspaceId: string }) {
  const f = useFormat();
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const list = useApiQuery<Paged<SupportContactRow>>(platformKey("support-view", workspaceId, "contacts"), `/admin/support/workspaces/${workspaceId}/contacts`, {
    query: { q, page, pageSize: 25 },
    keepPrevious: true,
  });
  return (
    <>
      <FilterBar>
        <SearchInput
          value={q}
          onChange={(v) => {
            setQ(v);
            setPage(1);
          }}
          placeholder="Search name, email or phone…"
          className="sm:w-72"
        />
      </FilterBar>
      <QueryState
        query={list}
        loading={<SkeletonText lines={6} />}
        isEmpty={(d) => d.total === 0}
        empty={
          <Card>
            <EmptyState compact icon={<Users />} title={q ? "No contacts match" : "No contacts"} />
          </Card>
        }
      >
        {(data) => (
          <Card className={cn("overflow-hidden", list.isPlaceholderData && "opacity-60")}>
            <div className={table.wrap}>
              <table className={table.table}>
                <thead>
                  <tr>
                    <th className={table.th}>Contact</th>
                    <th className={table.th}>Company</th>
                    <th className={table.th}>Status</th>
                    <th className={table.th}>Deliverability</th>
                    <th className={table.th}>Last contacted</th>
                    <th className={table.th}>Added</th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((c) => (
                    <tr key={c.id}>
                      <td className={cn(table.td, "max-w-64")}>
                        <div className="truncate">{c.fullName || c.email || c.phone || "Unnamed"}</div>
                        <div className="truncate text-xs text-text-3">{[c.email, c.phone].filter(Boolean).join(" · ")}</div>
                      </td>
                      <td className={cn(table.td, "max-w-48 truncate text-text-2")}>{c.company?.name ?? "—"}</td>
                      <td className={table.td}>
                        <StatusBadge value={c.status} />
                      </td>
                      <td className={table.td}>
                        <span className="flex flex-wrap gap-1">
                          {c.doNotContact && <Badge tone="bad">Do not contact</Badge>}
                          {c.unsubscribedAt && <Badge tone="warn">Unsubscribed</Badge>}
                          {c.bouncedAt && <Badge tone="bad">Bounced</Badge>}
                          {!c.doNotContact && !c.unsubscribedAt && !c.bouncedAt && <span className="text-text-3">—</span>}
                        </span>
                      </td>
                      <td className={cn(table.td, "text-text-2")}>{c.lastContactedAt ? f.relative(c.lastContactedAt) : "Never"}</td>
                      <td className={cn(table.td, "text-text-2")}>{f.date(c.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <TableFooter>
              <Pagination page={data.page} pageSize={data.pageSize} total={data.total} onPageChange={setPage} />
            </TableFooter>
          </Card>
        )}
      </QueryState>
    </>
  );
}

function ConversationDrawer({ workspaceId, conversationId, onClose }: { workspaceId: string; conversationId: string | null; onClose: () => void }) {
  const f = useFormat();
  const q = useApiQuery<SupportConversation>(
    platformKey("support-view", workspaceId, "conversation", conversationId),
    conversationId ? `/admin/support/workspaces/${workspaceId}/conversations/${conversationId}` : null,
  );
  return (
    <Drawer open={Boolean(conversationId)} onOpenChange={(v) => !v && onClose()} title={q.data?.subject || q.data?.displayName || q.data?.handle || "Conversation"} description="Plain-text bodies, oldest first (up to 200 messages)." width="lg">
      <QueryState query={q} loading={<SkeletonText lines={8} />}>
        {(c) =>
          c.messages.length ? (
            <ol className="flex flex-col gap-3">
              {c.messages.map((m) => (
                <li key={m.id} className={cn("rounded-lg border border-line p-3", m.direction === "outbound" ? "bg-s-2" : "bg-panel")}>
                  <div className="mb-1.5 flex flex-wrap items-center gap-2 text-xs text-text-3">
                    <Badge tone={m.direction === "outbound" ? "live" : "info"} quiet>
                      {m.direction === "outbound" ? "Sent" : "Received"}
                    </Badge>
                    <StatusBadge value={m.status} />
                    {m.isAutoReply && <Badge>Auto-reply</Badge>}
                    <span>{f.dateTime(m.sentAt ?? m.receivedAt ?? m.createdAt)}</span>
                  </div>
                  <div className="text-xs text-text-2">
                    {m.fromAddress} → {m.toAddress}
                  </div>
                  {m.subject && <div className="mt-1 text-sm font-medium text-text">{m.subject}</div>}
                  <pre className="mt-2 max-h-80 overflow-y-auto font-sans text-sm whitespace-pre-wrap text-text">{m.bodyText || "(no text body)"}</pre>
                  {m.error && <p className="mt-2 text-xs text-bad-ink">{m.error}</p>}
                </li>
              ))}
            </ol>
          ) : (
            <EmptyState compact icon={<MessagesSquare />} title="No messages" />
          )
        }
      </QueryState>
    </Drawer>
  );
}

function Conversations({ workspaceId }: { workspaceId: string }) {
  const f = useFormat();
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<string | null>(null);
  const list = useApiQuery<Paged<SupportConversationRow>>(platformKey("support-view", workspaceId, "conversations"), `/admin/support/workspaces/${workspaceId}/conversations`, {
    query: { q, page, pageSize: 25 },
    keepPrevious: true,
  });
  return (
    <>
      <FilterBar>
        <SearchInput
          value={q}
          onChange={(v) => {
            setQ(v);
            setPage(1);
          }}
          placeholder="Search subject or participant…"
          className="sm:w-72"
        />
      </FilterBar>
      <QueryState
        query={list}
        loading={<SkeletonText lines={6} />}
        isEmpty={(d) => d.total === 0}
        empty={
          <Card>
            <EmptyState compact icon={<MessagesSquare />} title={q ? "No conversations match" : "No conversations"} />
          </Card>
        }
      >
        {(data) => (
          <Card className={cn("overflow-hidden", list.isPlaceholderData && "opacity-60")}>
            <div className={table.wrap}>
              <table className={table.table}>
                <thead>
                  <tr>
                    <th className={table.th}>Conversation</th>
                    <th className={table.th}>Channel</th>
                    <th className={table.th}>Status</th>
                    <th className={table.th}>Messages</th>
                    <th className={table.th}>Last message</th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((c) => (
                    <tr key={c.id} className="cursor-pointer hover:bg-hover" onClick={() => setOpen(c.id)}>
                      <td className={cn(table.td, "max-w-80")}>
                        <button type="button" className="block w-full min-w-0 text-left hover:underline" onClick={() => setOpen(c.id)}>
                          <div className="truncate">{c.subject || c.displayName || c.handle || "Untitled"}</div>
                          <div className="truncate text-xs text-text-3">
                            {[c.displayName || c.handle, c.mailbox?.email && `via ${c.mailbox.email}`].filter(Boolean).join(" · ")}
                          </div>
                        </button>
                      </td>
                      <td className={table.td}>{labelOf(c.channel)}</td>
                      <td className={table.td}>
                        <StatusBadge value={c.status} />
                      </td>
                      <td className={cn(table.td, "tabular-nums")}>{c.messages}</td>
                      <td className={cn(table.td, "text-text-2")}>{c.lastMessageAt ? f.relative(c.lastMessageAt) : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <TableFooter>
              <Pagination page={data.page} pageSize={data.pageSize} total={data.total} onPageChange={setPage} />
            </TableFooter>
          </Card>
        )}
      </QueryState>
      <ConversationDrawer workspaceId={workspaceId} conversationId={open} onClose={() => setOpen(null)} />
    </>
  );
}

/** /admin/workspaces/:id/support */
export function SupportView() {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const f = useFormat();
  const summary = useApiQuery<SupportViewSummary>(platformKey("support-view", workspaceId, "summary"), `/admin/support/workspaces/${workspaceId}`, { staleTime: 60_000 });

  return (
    <Page width="capped">
      <QueryState query={summary} loading={<SkeletonText lines={10} />} errorTitle="Support view unavailable">
        {(data) => (
          <>
            <PageHeader
              back={{ href: `/admin/workspaces/${workspaceId}`, label: data.workspace.name }}
              icon={<PlatformTile of="support" />}
              title="Support view"
              meta={<Badge tone="ok" dot>Read only</Badge>}
              description={`${data.workspace.name} · ${formatNumber(data.counts.contacts)} contacts · ${formatNumber(data.counts.deals)} deals · ${formatNumber(data.counts.conversations)} conversations`}
            />
            <Callout tone="info" title={`Access granted until ${f.dateTime(data.grant.expiresAt)}`} className="mb-4">
              {data.grant.grantedBy?.name || data.grant.grantedBy?.email || "The owner"}: “{data.grant.reason}”. Everything you open here is recorded in the workspace&apos;s audit log.
            </Callout>
            <Tabs defaultValue="overview">
              <TabsList className="mb-4">
                <TabsTrigger value="overview">
                  <Gauge />
                  Overview
                </TabsTrigger>
                <TabsTrigger value="contacts">
                  <Users />
                  Contacts
                </TabsTrigger>
                <TabsTrigger value="conversations">
                  <MessagesSquare />
                  Conversations
                </TabsTrigger>
              </TabsList>
              <TabsContent value="overview">
                <Overview data={data} />
              </TabsContent>
              <TabsContent value="contacts">
                <Contacts workspaceId={workspaceId} />
              </TabsContent>
              <TabsContent value="conversations">
                <Conversations workspaceId={workspaceId} />
              </TabsContent>
            </Tabs>
          </>
        )}
      </QueryState>
    </Page>
  );
}
