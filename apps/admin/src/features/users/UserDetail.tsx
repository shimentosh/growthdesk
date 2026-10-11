"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Ban, Building2, CircleCheck, CreditCard, History, LogOut, MonitorSmartphone, ShieldCheck, UserRound } from "lucide-react";
import { labelOf, PLATFORM_ROLES, type PlatformRole } from "@growthdesk/shared";
import { describeUserAgent } from "@/features/common/userAgent";
import { Badge, StatusBadge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { ConfirmDialog, Modal } from "@/components/ui/Dialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { QueryState } from "@/components/ui/ErrorState";
import { Field, FormError } from "@/components/ui/Field";
import { NativeSelect, Textarea } from "@/components/ui/Input";
import { KeyValueList } from "@/components/ui/KeyValue";
import { Page, PageHeader } from "@/components/ui/PageHeader";
import { SkeletonText } from "@/components/ui/Skeleton";
import { cn } from "@/lib/cn";
import { useApiMutation, useApiQuery } from "@/lib/query";
import { useFormat, useMe } from "@/lib/session";
import { NotesCard, ProfileCard, TagsCard, UserActionsMenu } from "./UserExtras";
import type { UserDetailData as AdminUserDetail } from "./profile";
import { AuditTable, PLATFORM_RANK, PLATFORM_ROLE_HELP, PLATFORM_ROLE_LABELS, PlatformRoleBadge, PlatformTile, platformKey, table, usePlatform } from "@/features/common/platform";

function DisableDialog({ user, open, onOpenChange }: { user: AdminUserDetail; open: boolean; onOpenChange: (v: boolean) => void }) {
  const [reason, setReason] = useState("");
  const disable = useApiMutation<AdminUserDetail, { reason: string }>({
    path: `/admin/users/${user.id}/disable`,
    invalidate: [platformKey("users")],
    success: "Account disabled and signed out",
    errorToast: false,
    onSuccess: () => {
      setReason("");
      onOpenChange(false);
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    disable.mutate({ reason: reason.trim() });
  };
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={`Disable ${user.name || user.email}?`}
      description="They are signed out of every device and cannot sign in, reset their password or receive notification email until the account is enabled again. Their workspaces keep working for everyone else."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="danger" type="submit" form="disable-user" loading={disable.isPending} disabled={!reason.trim()}>
            Disable account
          </Button>
        </>
      }
    >
      <form id="disable-user" onSubmit={submit} className="flex flex-col gap-3">
        <FormError error={disable.error && !disable.error.fields.reason ? disable.error.message : null} />
        <Field label="Reason" hint="Recorded in the audit log. The person is told only that the account is suspended." error={disable.error?.fields.reason}>
          <Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} autoFocus />
        </Field>
      </form>
    </Modal>
  );
}

function RoleDialog({ user, open, onOpenChange }: { user: AdminUserDetail; open: boolean; onOpenChange: (v: boolean) => void }) {
  const { role: mine } = usePlatform();
  const options = PLATFORM_ROLES.filter((r) => mine === "owner" || PLATFORM_RANK[r] < PLATFORM_RANK[mine]);
  const [role, setRole] = useState<PlatformRole>(user.platformRole);
  const save = useApiMutation<AdminUserDetail, { role: PlatformRole }>({
    method: "PUT",
    path: `/admin/users/${user.id}/platform-role`,
    invalidate: [platformKey("users")],
    success: "Platform role changed",
    errorToast: false,
    onSuccess: () => onOpenChange(false),
  });
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Change platform role"
      description="Platform roles open this admin area. They are separate from workspace roles, which are unchanged."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" loading={save.isPending} disabled={role === user.platformRole} onClick={() => save.mutate({ role })}>
            Save role
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <FormError error={save.error?.message} />
        <Field label="Platform role" hint={PLATFORM_ROLE_HELP[role]}>
          <NativeSelect value={role} onChange={(e) => setRole(e.target.value as PlatformRole)} options={options.map((r) => ({ value: r, label: PLATFORM_ROLE_LABELS[r] }))} />
        </Field>
        {mine !== "owner" && <p className="text-xs text-text-3">Only a platform owner can make someone an admin or owner.</p>}
      </div>
    </Modal>
  );
}

/** /users/:id */
export function UserDetail() {
  const { userId } = useParams<{ userId: string }>();
  const f = useFormat();
  const me = useMe();
  const { role: mine, canChange } = usePlatform();
  const key = platformKey("users", userId);
  const q = useApiQuery<AdminUserDetail>(key, `/admin/users/${userId}`);
  const [dialog, setDialog] = useState<"disable" | "role" | "signout" | "enable" | null>(null);

  const enable = useApiMutation({ path: `/admin/users/${userId}/enable`, invalidate: [platformKey("users")], success: "Account enabled" });
  const signOut = useApiMutation<{ sessionsEnded: number }>({
    path: `/admin/users/${userId}/sign-out`,
    invalidate: [platformKey("users")],
    success: (r) => `Signed out of ${r.sessionsEnded} session${r.sessionsEnded === 1 ? "" : "s"}`,
  });

  return (
    <Page width="capped">
      <QueryState query={q} loading={<SkeletonText lines={10} />}>
        {(u) => {
          const self = me.data?.user.id === u.id;
          const outranked = mine !== "owner" && PLATFORM_RANK[u.platformRole] >= PLATFORM_RANK[mine];
          const deleted = Boolean(u.anonymisedAt);
          const mayManage = canChange && !self && !outranked && !deleted;
          return (
            <>
              <PageHeader
                back={{ href: "/users", label: "Users" }}
                icon={<PlatformTile of="users" />}
                title={deleted ? "Deleted account" : u.name || u.email}
                meta={
                  <>
                    <PlatformRoleBadge role={u.platformRole} />
                    {deleted && <Badge tone="mute">Deleted</Badge>}
                    {u.disabledAt && !deleted && (
                      <Badge tone="bad" dot>
                        Disabled
                      </Badge>
                    )}
                  </>
                }
                description={deleted ? undefined : u.name ? u.email : undefined}
                actions={
                  <>
                    {mayManage && (
                      <>
                        <Button size="sm" icon={<ShieldCheck />} onClick={() => setDialog("role")}>
                          Platform role
                        </Button>
                        <Button size="sm" icon={<LogOut />} disabled={!u.sessions.length} onClick={() => setDialog("signout")}>
                          Sign out everywhere
                        </Button>
                        {u.disabledAt ? (
                          <Button size="sm" variant="primary" icon={<CircleCheck />} onClick={() => setDialog("enable")}>
                            Enable account
                          </Button>
                        ) : (
                          <Button size="sm" variant="danger" icon={<Ban />} onClick={() => setDialog("disable")}>
                            Disable account
                          </Button>
                        )}
                      </>
                    )}
                    <UserActionsMenu u={u} self={self} />
                  </>
                }
              />
              <div className="flex flex-col gap-4">
                {canChange && self && <Callout tone="info">This is your own account. Manage your sign-in from Account settings; another admin changes your role.</Callout>}
                {canChange && !self && outranked && <Callout tone="info">Only a platform owner can manage a platform {PLATFORM_ROLE_LABELS[u.platformRole].toLowerCase()}.</Callout>}
                {deleted && (
                  <Callout tone="info" title={`Deleted ${f.relative(u.anonymisedAt!)}`}>
                    The personal data was erased (anonymised) on {f.dateTime(u.anonymisedAt!)}. The record stays so billing and workspace history still make sense.
                  </Callout>
                )}
                {u.disabledAt && !deleted && (
                  <Callout tone="bad" title={`Disabled ${f.relative(u.disabledAt)}`}>
                    {u.disabledReason || "No reason was recorded."}
                  </Callout>
                )}
                <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
                  <div className="flex min-w-0 flex-col gap-4">
                    <Card>
                      <CardHeader icon={<UserRound />} title="Account" />
                      <CardBody>
                        <KeyValueList
                          columns={2}
                          items={[
                            { label: "Email", value: u.email },
                            { label: "Email confirmed", value: u.emailVerified ? "Yes" : "No" },
                            { label: "Sign-in", value: [u.hasPassword && "Password", u.googleLinked && "Google"].filter(Boolean).join(" · ") || "None set" },
                            { label: "Two-factor", value: u.twoFactorEnabledAt ? `On since ${f.date(u.twoFactorEnabledAt)}` : "Off" },
                            { label: "Last sign-in", value: u.lastLoginAt ? f.dateTime(u.lastLoginAt) : "Never" },
                            { label: "Joined", value: f.dateTime(u.createdAt) },
                            { label: "User id", value: <span className="font-mono text-xs">{u.id}</span> },
                          ]}
                        />
                      </CardBody>
                    </Card>

                    <NotesCard u={u} />

                    <Card>
                      <CardHeader
                        icon={<Building2 />}
                        title="Workspaces"
                        description={u.billingAccounts.length ? `Owns ${u.billingAccounts.length} billing account${u.billingAccounts.length === 1 ? "" : "s"}.` : undefined}
                      />
                      {u.memberships.length ? (
                        <div className={table.wrap}>
                          <table className={table.table}>
                            <thead>
                              <tr>
                                <th className={table.th}>Workspace</th>
                                <th className={table.th}>Role</th>
                                <th className={table.th}>Status</th>
                                <th className={table.th}>Joined</th>
                              </tr>
                            </thead>
                            <tbody>
                              {u.memberships.map((m) => (
                                <tr key={m.workspaceId}>
                                  <td className={table.td}>
                                    <Link href={`/workspaces/${m.workspaceId}`} className="hover:underline">
                                      {m.workspaceName}
                                    </Link>
                                  </td>
                                  <td className={table.td}>{labelOf(m.role)}</td>
                                  <td className={table.td}>
                                    <StatusBadge value={m.workspaceStatus} />
                                  </td>
                                  <td className={cn(table.td, "text-text-2")}>{f.date(m.joinedAt)}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      ) : (
                        <EmptyState compact icon={<Building2 />} title="Not a member of any workspace" />
                      )}
                      {u.billingAccounts.length > 0 && (
                        <CardBody className="flex flex-wrap gap-2 border-t border-line">
                          {u.billingAccounts.map((a) => (
                            <Button key={a.id} size="sm" variant="ghost" icon={<CreditCard />} href={`/billing/${a.id}`}>
                              Billing account: {a.name}
                            </Button>
                          ))}
                        </CardBody>
                      )}
                    </Card>

                    <Card>
                      <CardHeader icon={<MonitorSmartphone />} title="Active sessions" description="Browsers currently signed in to this account." />
                      {u.sessions.length ? (
                        <div className={table.wrap}>
                          <table className={table.table}>
                            <thead>
                              <tr>
                                <th className={table.th}>Device</th>
                                <th className={table.th}>IP address</th>
                                <th className={table.th}>Signed in</th>
                                <th className={table.th}>Last active</th>
                              </tr>
                            </thead>
                            <tbody>
                              {u.sessions.map((s) => (
                                <tr key={s.id}>
                                  <td className={table.td}>{describeUserAgent(s.userAgent)}</td>
                                  <td className={cn(table.td, "font-mono text-xs text-text-2")}>{s.ip || "—"}</td>
                                  <td className={cn(table.td, "text-text-2")}>{f.dateTime(s.createdAt)}</td>
                                  <td className={cn(table.td, "text-text-2")}>{f.relative(s.lastSeenAt)}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      ) : (
                        <EmptyState compact icon={<MonitorSmartphone />} title="No active sessions" />
                      )}
                    </Card>

                    <Card>
                      <CardHeader icon={<History />} title="Recent activity" description="Audit events this person performed or that were about them." />
                      {u.recentAudit.length ? <AuditTable rows={u.recentAudit} showWorkspace /> : <EmptyState compact icon={<History />} title="Nothing recorded yet" />}
                    </Card>
                  </div>
                  <div className="flex min-w-0 flex-col gap-4">
                    <ProfileCard u={u} />
                    <TagsCard u={u} />
                  </div>
                </div>
              </div>

              <DisableDialog user={u} open={dialog === "disable"} onOpenChange={(v) => setDialog(v ? "disable" : null)} />
              <RoleDialog key={u.platformRole} user={u} open={dialog === "role"} onOpenChange={(v) => setDialog(v ? "role" : null)} />
              <ConfirmDialog
                open={dialog === "signout"}
                onOpenChange={(v) => setDialog(v ? "signout" : null)}
                title="Sign out everywhere?"
                description={`Ends all ${u.sessions.length} active session${u.sessions.length === 1 ? "" : "s"}. They can sign in again straight away.`}
                confirmLabel="Sign out"
                onConfirm={() => signOut.mutateAsync()}
              />
              <ConfirmDialog
                open={dialog === "enable"}
                onOpenChange={(v) => setDialog(v ? "enable" : null)}
                tone="default"
                title="Enable this account?"
                description="They can sign in again straight away."
                confirmLabel="Enable"
                onConfirm={() => enable.mutateAsync()}
              />
            </>
          );
        }}
      </QueryState>
    </Page>
  );
}
