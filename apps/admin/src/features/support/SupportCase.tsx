"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Eye, MessageSquareText, NotebookPen, Send, SlidersHorizontal, UserRound } from "lucide-react";
import { labelOf, SUPPORT_CASE_PRIORITIES, SUPPORT_CASE_STATUSES } from "@growthdesk/shared";
import { Avatar } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Card, CardBody, CardFooter, CardHeader } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { QueryState } from "@/components/ui/ErrorState";
import { Field, FormError } from "@/components/ui/Field";
import { NativeSelect, Textarea } from "@/components/ui/Input";
import { KeyValueList } from "@/components/ui/KeyValue";
import { Page, PageHeader } from "@/components/ui/PageHeader";
import { SkeletonText } from "@/components/ui/Skeleton";
import { useApiMutation, useApiQuery } from "@/lib/query";
import { useFormat } from "@/lib/session";
import type { AdminCaseDetail } from "@/features/common/types";
import { PersonCell, PlatformTile, platformKey } from "@/features/common/platform";
import { CaseStatusBadge } from "./Support";

type Patch = { status?: string; priority?: string; assigneeId?: string | null };

/** /support/:id */
export function SupportCase() {
  const { caseId } = useParams<{ caseId: string }>();
  const f = useFormat();
  const key = platformKey("cases", caseId);
  const q = useApiQuery<AdminCaseDetail>(key, `/admin/support/cases/${caseId}`);
  const [note, setNote] = useState("");
  const update = useApiMutation<AdminCaseDetail, Patch>({
    method: "PATCH",
    path: `/admin/support/cases/${caseId}`,
    invalidate: [platformKey("cases"), platformKey("overview")],
    success: "Case updated",
  });
  const addNote = useApiMutation<AdminCaseDetail, { body: string }>({
    path: `/admin/support/cases/${caseId}/notes`,
    invalidate: [platformKey("cases")],
    errorToast: false,
    onSuccess: () => setNote(""),
  });
  const submitNote = (e: FormEvent) => {
    e.preventDefault();
    if (note.trim()) addNote.mutate({ body: note.trim() });
  };

  return (
    <Page width="capped">
      <QueryState query={q} loading={<SkeletonText lines={10} />}>
        {(c) => (
          <>
            <PageHeader back={{ href: "/support", label: "Support" }} icon={<PlatformTile of="support" />} title={c.subject} meta={<CaseStatusBadge status={c.status} />} description={`Opened ${f.dateTime(c.createdAt)}`} />
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_320px]">
              <div className="flex flex-col gap-4">
                <Card>
                  <CardHeader icon={<MessageSquareText />} title="Request" />
                  <CardBody>
                    <p className="text-sm whitespace-pre-wrap text-text">{c.body}</p>
                  </CardBody>
                </Card>
                <Card>
                  <CardHeader icon={<NotebookPen />} title="Internal notes" description="Visible to platform staff only." />
                  {c.notes.length ? (
                    <ol>
                      {c.notes.map((n) => (
                        <li key={n.id} className="flex gap-3 border-b border-line px-4 py-3 last:border-b-0">
                          <Avatar name={n.author?.name} email={n.author?.email} size="sm" />
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-baseline gap-2 text-xs">
                              <span className="font-medium text-text">{n.author?.name || n.author?.email || "Former staff"}</span>
                              <span className="text-text-3">{f.dateTime(n.createdAt)}</span>
                            </div>
                            <p className="mt-1 text-sm whitespace-pre-wrap text-text">{n.body}</p>
                          </div>
                        </li>
                      ))}
                    </ol>
                  ) : (
                    <EmptyState compact icon={<NotebookPen />} title="No notes yet" />
                  )}
                  <form onSubmit={submitNote}>
                    <CardBody className="border-t border-line">
                      <FormError error={addNote.error?.message} />
                      <Field label="Add a note">
                        <Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} maxLength={10000} placeholder="What you checked, what you found, what happens next." />
                      </Field>
                    </CardBody>
                    <CardFooter>
                      <Button type="submit" variant="primary" icon={<Send />} loading={addNote.isPending} disabled={!note.trim()}>
                        Add note
                      </Button>
                    </CardFooter>
                  </form>
                </Card>
              </div>

              <div className="flex flex-col gap-4">
                <Card>
                  <CardHeader icon={<SlidersHorizontal />} title="Case" />
                  <CardBody className="flex flex-col gap-3">
                    <Field label="Status">
                      <NativeSelect
                        value={c.status}
                        disabled={update.isPending}
                        onChange={(e) => update.mutate({ status: e.target.value })}
                        options={SUPPORT_CASE_STATUSES.map((s) => ({ value: s, label: labelOf(s) }))}
                      />
                    </Field>
                    <Field label="Priority">
                      <NativeSelect
                        value={c.priority}
                        disabled={update.isPending}
                        onChange={(e) => update.mutate({ priority: e.target.value })}
                        options={SUPPORT_CASE_PRIORITIES.map((p) => ({ value: p, label: labelOf(p) }))}
                      />
                    </Field>
                    <Field label="Assignee">
                      <NativeSelect
                        value={c.assignee?.id ?? ""}
                        disabled={update.isPending}
                        onChange={(e) => update.mutate({ assigneeId: e.target.value || null })}
                        placeholder="Unassigned"
                        options={c.staff.map((s) => ({ value: s.id, label: s.name || s.email }))}
                      />
                    </Field>
                    {c.closedAt && <p className="text-xs text-text-3">Closed {f.dateTime(c.closedAt)}</p>}
                  </CardBody>
                </Card>
                <Card>
                  <CardHeader icon={<UserRound />} title="Customer" />
                  <CardBody className="flex flex-col gap-3">
                    <KeyValueList
                      items={[
                        { label: "Account", value: c.user ? <PersonCell person={c.user} /> : null },
                        {
                          label: "Workspace",
                          value: c.workspace ? (
                            <Link href={`/workspaces/${c.workspace.id}`} className="hover:underline">
                              {c.workspace.name}
                            </Link>
                          ) : null,
                        },
                      ]}
                    />
                    {c.workspace &&
                      (c.supportGrant ? (
                        <>
                          <Callout tone="ok">Support access granted until {f.dateTime(c.supportGrant.expiresAt)}.</Callout>
                          <Button size="sm" icon={<Eye />} href={`/workspaces/${c.workspace.id}/support`} className="self-start">
                            Open support view
                          </Button>
                        </>
                      ) : (
                        <p className="text-xs text-text-3">
                          To look into the workspace, ask its owner to grant support access from Settings → Support access.
                        </p>
                      ))}
                  </CardBody>
                </Card>
              </div>
            </div>
          </>
        )}
      </QueryState>
    </Page>
  );
}
