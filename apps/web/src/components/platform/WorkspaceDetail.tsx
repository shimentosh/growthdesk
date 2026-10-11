"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Ban, Building2, CircleCheck, CreditCard, Eye, LifeBuoy, ScrollText, Users } from "lucide-react";
import { labelOf } from "@growthdesk/shared";
import { Badge, StatusBadge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { ConfirmDialog, Modal } from "@/components/ui/Dialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { QueryState } from "@/components/ui/ErrorState";
import { Field, FormError } from "@/components/ui/Field";
import { Textarea } from "@/components/ui/Input";
import { KeyValueList } from "@/components/ui/KeyValue";
import { Page, PageHeader } from "@/components/ui/PageHeader";
import { SkeletonText } from "@/components/ui/Skeleton";
import { cn } from "@/lib/cn";
import { useApiMutation, useApiQuery } from "@/lib/query";
import { useFormat } from "@/lib/session";
import type { AdminWorkspaceDetail } from "@/lib/types/platform";
import { AuditTable, PersonCell, PlatformTile, platformKey, table, usePlatform } from "./common";
import { PlanUsage } from "./PlanUsage";

function SuspendDialog({ workspace, open, onOpenChange }: { workspace: AdminWorkspaceDetail; open: boolean; onOpenChange: (v: boolean) => void }) {
  const [reason, setReason] = useState("");
  const suspend = useApiMutation<AdminWorkspaceDetail, { reason: string }>({
    path: `/admin/workspaces/${workspace.id}/suspend`,
    invalidate: [platformKey("workspaces"), platformKey("overview")],
    success: "Workspace suspended",
    errorToast: false,
    onSuccess: () => {
      setReason("");
      onOpenChange(false);
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    suspend.mutate({ reason: reason.trim() });
  };
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={`Suspend ${workspace.name}?`}
      description="Members can still sign in and open the workspace profile, billing and support-access settings. Everything else in the workspace is refused, and no email or chat message is sent from it, until it is unsuspended. Nothing is deleted."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="danger" type="submit" form="suspend-ws" loading={suspend.isPending} disabled={!reason.trim()}>
            Suspend workspace
          </Button>
        </>
      }
    >
      <form id="suspend-ws" onSubmit={submit} className="flex flex-col gap-3">
        <FormError error={suspend.error && !suspend.error.fields.reason ? suspend.error.message : null} />
        <Field label="Reason" hint="Shown to the workspace's members in the suspension banner, and recorded in its audit log." error={suspend.error?.fields.reason}>
          <Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} autoFocus />
        </Field>
      </form>
    </Modal>
  );
}

/** /admin/workspaces/:id */
export function WorkspaceDetail() {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const f = useFormat();
  const { canChange } = usePlatform();
  const q = useApiQuery<AdminWorkspaceDetail>(platformKey("workspaces", workspaceId), `/admin/workspaces/${workspaceId}`);
  const [dialog, setDialog] = useState<"suspend" | "unsuspend" | null>(null);
  const unsuspend = useApiMutation({
    path: `/admin/workspaces/${workspaceId}/unsuspend`,
    invalidate: [platformKey("workspaces"), platformKey("overview")],
    success: "Workspace restored",
  });

  return (
    <Page width="capped">
      <QueryState query={q} loading={<SkeletonText lines={10} />}>
        {(w) => (
          <>
            <PageHeader
              back={{ href: "/admin/workspaces", label: "Workspaces" }}
              icon={<PlatformTile of="workspaces" />}
              title={w.name}
              meta={<StatusBadge value={w.status} />}
              description={w.slug}
              actions={
                <>
                  <Button size="sm" icon={<Eye />} href={w.supportGrant ? `/admin/workspaces/${w.id}/support` : undefined} disabled={!w.supportGrant}>
                    Support view
                  </Button>
                  {canChange &&
                    (w.status === "suspended" ? (
                      <Button size="sm" variant="primary" icon={<CircleCheck />} onClick={() => setDialog("unsuspend")}>
                        Unsuspend
                      </Button>
                    ) : (
                      <Button size="sm" variant="danger" icon={<Ban />} onClick={() => setDialog("suspend")}>
                        Suspend
                      </Button>
                    ))}
                </>
              }
            />
            <div className="flex flex-col gap-4">
              {w.status === "suspended" && (
                <Callout tone="bad" title={`Suspended${w.suspendedAt ? ` ${f.relative(w.suspendedAt)}` : ""}`}>
                  {w.suspendedReason || "No reason was recorded."}
                </Callout>
              )}
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_360px]">
                <Card>
                  <CardHeader icon={<Building2 />} title="Workspace" />
                  <CardBody>
                    <KeyValueList
                      columns={2}
                      items={[
                        {
                          label: "Billing account",
                          value: (
                            <Link href={`/admin/billing/${w.billingAccount.id}`} className="hover:underline">
                              {w.billingAccount.name}
                            </Link>
                          ),
                        },
                        { label: "Account owner", value: <PersonCell person={w.billingAccount.owner} /> },
                        { label: "Business type", value: w.businessType ? labelOf(w.businessType) : null },
                        { label: "Time zone", value: w.timezone },
                        { label: "Currency", value: w.currency },
                        { label: "Created", value: f.dateTime(w.createdAt) },
                        { label: "Pending invitations", value: String(w.pendingInvitations) },
                        {
                          label: "Open support cases",
                          value: w.openSupportCases ? <Link href={`/admin/support?workspaceId=${w.id}`} className="hover:underline">{w.openSupportCases}</Link> : "0",
                        },
                        { label: "Workspace id", value: <span className="font-mono text-xs">{w.id}</span> },
                      ]}
                    />
                  </CardBody>
                </Card>
                <Card>
                  <CardHeader icon={<LifeBuoy />} title="Support access" />
                  <CardBody className="flex flex-col gap-3">
                    {w.supportGrant ? (
                      <>
                        <Callout tone="ok" title={`Granted until ${f.dateTime(w.supportGrant.expiresAt)}`}>
                          {w.supportGrant.reason}
                        </Callout>
                        <p className="text-xs text-text-3">
                          Granted by {w.supportGrant.grantedBy?.name || w.supportGrant.grantedBy?.email || "the owner"} {f.relative(w.supportGrant.createdAt)}. Each look is recorded in the workspace&apos;s audit log.
                        </p>
                        <Button size="sm" variant="primary" icon={<Eye />} href={`/admin/workspaces/${w.id}/support`} className="self-start">
                          Open support view
                        </Button>
                      </>
                    ) : (
                      <p className="text-sm text-text-2">
                        No access granted. The workspace owner can allow support to look into the workspace for a limited time from Settings → Support access.
                      </p>
                    )}
                  </CardBody>
                </Card>
              </div>

              <PlanUsage
                plan={w.plan}
                workspaces={w.billingAccount.workspaces}
                actions={
                  <Button size="sm" icon={<CreditCard />} href={`/admin/billing/${w.billingAccount.id}`}>
                    Billing account
                  </Button>
                }
              />

              <Card>
                <CardHeader icon={<Users />} title="Members" />
                {w.members.length ? (
                  <div className={table.wrap}>
                    <table className={table.table}>
                      <thead>
                        <tr>
                          <th className={table.th}>Person</th>
                          <th className={table.th}>Role</th>
                          <th className={table.th}>Last sign-in</th>
                          <th className={table.th}>Joined</th>
                        </tr>
                      </thead>
                      <tbody>
                        {w.members.map((m) => (
                          <tr key={m.userId}>
                            <td className={cn(table.td, "max-w-72")}>
                              <PersonCell person={{ id: m.userId, email: m.email, name: m.name }} />
                            </td>
                            <td className={table.td}>
                              <span className="flex items-center gap-1.5">
                                {labelOf(m.role)}
                                {m.disabled && (
                                  <Badge tone="bad" dot>
                                    Disabled
                                  </Badge>
                                )}
                              </span>
                            </td>
                            <td className={cn(table.td, "text-text-2")}>{m.lastLoginAt ? f.relative(m.lastLoginAt) : "Never"}</td>
                            <td className={cn(table.td, "text-text-2")}>{f.date(m.joinedAt)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <EmptyState compact icon={<Users />} title="No members" />
                )}
              </Card>

              <Card>
                <CardHeader
                  icon={<ScrollText />}
                  title="Recent audit events"
                  actions={
                    <Button size="sm" variant="ghost" icon={<ScrollText />} href={`/admin/audit?workspaceId=${w.id}`}>
                      Full log
                    </Button>
                  }
                />
                {w.recentAudit.length ? <AuditTable rows={w.recentAudit} /> : <EmptyState compact icon={<ScrollText />} title="Nothing recorded yet" />}
              </Card>
            </div>

            <SuspendDialog workspace={w} open={dialog === "suspend"} onOpenChange={(v) => setDialog(v ? "suspend" : null)} />
            <ConfirmDialog
              open={dialog === "unsuspend"}
              onOpenChange={(v) => setDialog(v ? "unsuspend" : null)}
              tone="default"
              title={`Unsuspend ${w.name}?`}
              description="Members can work and send again straight away."
              confirmLabel="Unsuspend"
              onConfirm={() => unsuspend.mutateAsync()}
            />
          </>
        )}
      </QueryState>
    </Page>
  );
}
