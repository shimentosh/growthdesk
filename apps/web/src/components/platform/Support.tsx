"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Eye, LifeBuoy, Plus, ShieldCheck, X } from "lucide-react";
import { labelOf, SUPPORT_CASE_PRIORITIES, SUPPORT_CASE_STATUSES } from "@growthdesk/shared";
import { Badge, type Tone } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, CardHeader } from "@/components/ui/Card";
import { Modal } from "@/components/ui/Dialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { QueryState } from "@/components/ui/ErrorState";
import { Field, FormError } from "@/components/ui/Field";
import { Input, NativeSelect, Textarea } from "@/components/ui/Input";
import { Page, PageHeader } from "@/components/ui/PageHeader";
import { Pagination } from "@/components/ui/Pagination";
import { SearchInput } from "@/components/ui/SearchInput";
import { SkeletonText } from "@/components/ui/Skeleton";
import { cn } from "@/lib/cn";
import { useApiMutation, useApiQuery } from "@/lib/query";
import { useFormat } from "@/lib/session";
import type { Paged } from "@/lib/types";
import type { AdminActiveGrant, AdminCaseDetail, AdminCaseRow } from "@/lib/types/platform";
import { FilterBar, PersonCell, platformEmpty, PlatformTile, platformKey, table, TableFooter } from "./common";

export const PRIORITY_TONE: Record<string, Tone> = { low: "mute", normal: "live", high: "warn" };
export const CASE_STATUS_TONE: Record<string, Tone> = { open: "info", pending: "warn", closed: "mute" };

export function CaseStatusBadge({ status }: { status: string }) {
  return (
    <Badge tone={CASE_STATUS_TONE[status] ?? "mute"} dot>
      {labelOf(status)}
    </Badge>
  );
}

function NewCaseDialog({ open, onOpenChange, workspaceId }: { open: boolean; onOpenChange: (v: boolean) => void; workspaceId?: string }) {
  const router = useRouter();
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [priority, setPriority] = useState("normal");
  const [userEmail, setUserEmail] = useState("");
  const [ws, setWs] = useState(workspaceId ?? "");
  const create = useApiMutation<AdminCaseDetail, Record<string, unknown>>({
    path: "/admin/support/cases",
    invalidate: [platformKey("cases"), platformKey("overview")],
    success: "Case opened",
    errorToast: false,
    onSuccess: (c) => {
      onOpenChange(false);
      router.push(`/admin/support/${c.id}`);
    },
  });
  const fields = create.error?.fields ?? {};
  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate({ subject: subject.trim(), body: body.trim(), priority, userEmail: userEmail.trim(), workspaceId: ws.trim() || null });
  };
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      dismissOnOutside={false}
      title="Open a support case"
      description="Log a request that reached you by email, chat or phone. Cases and their notes are internal — customers do not see them."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" type="submit" form="new-case" loading={create.isPending} disabled={!subject.trim() || !body.trim()}>
            Open case
          </Button>
        </>
      }
    >
      <form id="new-case" onSubmit={submit} className="flex flex-col gap-4">
        <FormError error={create.error && !Object.keys(fields).length ? create.error.message : null} />
        <Field label="Subject" error={fields.subject}>
          <Input value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={200} autoFocus />
        </Field>
        <Field label="What the customer reported" error={fields.body}>
          <Textarea rows={5} value={body} onChange={(e) => setBody(e.target.value)} maxLength={10000} />
        </Field>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Customer's account email" error={fields.userEmail} hint="Optional. Must be an existing account.">
            <Input type="email" value={userEmail} onChange={(e) => setUserEmail(e.target.value)} />
          </Field>
          <Field label="Priority">
            <NativeSelect value={priority} onChange={(e) => setPriority(e.target.value)} options={SUPPORT_CASE_PRIORITIES.map((p) => ({ value: p, label: labelOf(p) }))} />
          </Field>
        </div>
        <Field label="Workspace id" error={fields.workspaceId} hint="Optional. Copy it from the workspace's admin page.">
          <Input value={ws} onChange={(e) => setWs(e.target.value)} className="font-mono" placeholder="00000000-0000-0000-0000-000000000000" />
        </Field>
      </form>
    </Modal>
  );
}

function ActiveGrants() {
  const f = useFormat();
  const q = useApiQuery<AdminActiveGrant[]>(platformKey("grants"), "/admin/support/grants", { refetchInterval: 60_000 });
  return (
    <Card>
      <CardHeader icon={<ShieldCheck />} title="Workspaces granting support access" description="Owners grant time-limited access from Settings → Support access. Only these workspaces can be opened in the support view." />
      <QueryState query={q} loading={<SkeletonText lines={3} className="p-4" />} isEmpty={(d) => d.length === 0} empty={<EmptyState compact icon={<LifeBuoy />} title="No workspace has granted access right now" />}>
        {(grants) => (
          <div className={table.wrap}>
            <table className={table.table}>
              <thead>
                <tr>
                  <th className={table.th}>Workspace</th>
                  <th className={table.th}>Granted by</th>
                  <th className={table.th}>Reason</th>
                  <th className={table.th}>Ends</th>
                  <th className={table.th} />
                </tr>
              </thead>
              <tbody>
                {grants.map((g) => (
                  <tr key={g.id} className="align-top">
                    <td className={table.td}>
                      <Link href={`/admin/workspaces/${g.workspace.id}`} className="hover:underline">
                        {g.workspace.name}
                      </Link>
                    </td>
                    <td className={cn(table.td, "max-w-56")}>
                      <PersonCell person={g.grantedBy} />
                    </td>
                    <td className={cn(table.td, "max-w-80 text-text-2")}>
                      <span className="line-clamp-2">{g.reason}</span>
                    </td>
                    <td className={cn(table.td, "whitespace-nowrap text-text-2")} title={f.dateTime(g.expiresAt)}>
                      {f.relative(g.expiresAt)}
                    </td>
                    <td className={cn(table.td, "text-right")}>
                      <Button size="sm" icon={<Eye />} href={`/admin/workspaces/${g.workspace.id}/support`}>
                        Support view
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </QueryState>
    </Card>
  );
}

/** /admin/support — the case queue and the workspaces that currently allow support in. */
export function Support() {
  const f = useFormat();
  const params = useSearchParams();
  const workspaceId = params.get("workspaceId") ?? undefined;
  const [status, setStatus] = useState(workspaceId ? "" : "open");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const list = useApiQuery<Paged<AdminCaseRow>>(platformKey("cases"), "/admin/support/cases", {
    query: { status: status || undefined, q, workspaceId, page, pageSize: 50 },
    keepPrevious: true,
  });

  return (
    <Page>
      <PageHeader
        icon={<PlatformTile of="support" />}
        title="Support"
        description="Cases staff are working on, with internal notes."
        actions={
          <Button variant="primary" icon={<Plus />} onClick={() => setCreating(true)}>
            Open case
          </Button>
        }
      />
      <div className="flex flex-col gap-5">
        <div>
          <FilterBar>
            <SearchInput
              value={q}
              onChange={(v) => {
                setQ(v);
                setPage(1);
              }}
              placeholder="Search cases…"
              className="sm:w-72"
            />
            <NativeSelect
              aria-label="Status"
              value={status}
              onChange={(e) => {
                setStatus(e.target.value);
                setPage(1);
              }}
              placeholder="Any status"
              options={SUPPORT_CASE_STATUSES.map((s) => ({ value: s, label: labelOf(s) }))}
              className="w-40"
            />
            {workspaceId && (
              <Button size="sm" variant="ghost" icon={<X />} href="/admin/support">
                Clear workspace filter
              </Button>
            )}
          </FilterBar>
          <QueryState
            query={list}
            loading={<SkeletonText lines={6} />}
            isEmpty={(d) => d.total === 0}
            empty={
              <Card>
                <EmptyState compact {...platformEmpty("support")} title={status === "open" && !q ? "No open cases" : "No cases match"} />
              </Card>
            }
          >
            {(data) => (
              <Card className={cn("overflow-hidden", list.isPlaceholderData && "opacity-60")}>
                <div className={table.wrap}>
                  <table className={table.table}>
                    <thead>
                      <tr>
                        <th className={table.th}>Case</th>
                        <th className={table.th}>Status</th>
                        <th className={table.th}>Priority</th>
                        <th className={table.th}>Customer</th>
                        <th className={table.th}>Assignee</th>
                        <th className={table.th}>Updated</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.items.map((c) => (
                        <tr key={c.id} className="hover:bg-hover">
                          <td className={cn(table.td, "max-w-96")}>
                            <Link href={`/admin/support/${c.id}`} className="block min-w-0 hover:underline">
                              <div className="truncate font-medium">{c.subject}</div>
                              <div className="truncate text-xs text-text-3">
                                {[c.workspace?.name, `${c.notes} note${c.notes === 1 ? "" : "s"}`].filter(Boolean).join(" · ")}
                              </div>
                            </Link>
                          </td>
                          <td className={table.td}>
                            <CaseStatusBadge status={c.status} />
                          </td>
                          <td className={table.td}>
                            <Badge tone={PRIORITY_TONE[c.priority] ?? "mute"} quiet>
                              {labelOf(c.priority)}
                            </Badge>
                          </td>
                          <td className={cn(table.td, "max-w-56")}>
                            <PersonCell person={c.user} />
                          </td>
                          <td className={cn(table.td, "max-w-56")}>
                            <PersonCell person={c.assignee} />
                          </td>
                          <td className={cn(table.td, "whitespace-nowrap text-text-2")}>{f.relative(c.updatedAt)}</td>
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
        </div>
        <ActiveGrants />
      </div>
      {creating && <NewCaseDialog open onOpenChange={setCreating} workspaceId={workspaceId} />}
    </Page>
  );
}

