"use client";

import { useState, type FormEvent } from "react";
import { Ellipsis, LogOut, Mail, MailPlus, RotateCw, Send, Trash2, UserMinus, UserPlus, Users } from "lucide-react";
import { labelOf, type WorkspaceRole } from "@growthdesk/shared";
import { Avatar } from "@/components/ui/Avatar";
import { Badge } from "@/components/ui/Badge";
import { Button, IconButton } from "@/components/ui/Button";
import { Card, CardHeader } from "@/components/ui/Card";
import { ConfirmDialog, Modal } from "@/components/ui/Dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/DropdownMenu";
import { EmptyState } from "@/components/ui/EmptyState";
import { EntityTile } from "@/components/ui/icons";
import { QueryState } from "@/components/ui/ErrorState";
import { Field, FormError } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { PageHeader } from "@/components/ui/PageHeader";
import { RequirePermission } from "@/components/ui/RequirePermission";
import { Select } from "@/components/ui/Select";
import { SkeletonText } from "@/components/ui/Skeleton";
import { cn } from "@/lib/cn";
import { useApiMutation, useApiQuery } from "@/lib/query";
import { ME_KEY, useFormat, useMe, useWorkspace, workspaceDetailKey } from "@/lib/session";
import type { Member, MembersResponse } from "@/lib/types";
import type { ChangeRoleResult, EditableRole, InvitationRow, InviteResult } from "@/lib/types/admin";
import { assignableRoles, outranks, ROLE_DESCRIPTIONS, table } from "./labels";

function InviteModal({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const ws = useWorkspace();
  const roles = assignableRoles(ws.role);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<EditableRole | undefined>(roles.includes("member") ? "member" : roles[roles.length - 1]);
  const invite = useApiMutation<InviteResult, { email: string; role: EditableRole }>({
    path: ws.path("/invitations"),
    invalidate: [ws.key("members"), workspaceDetailKey(ws.id)],
    success: (r) => `Invitation sent to ${r.email}`,
    errorToast: false,
    onSuccess: () => {
      setEmail("");
      onOpenChange(false);
    },
  });
  const fields = invite.error?.fields ?? {};

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!role) return;
    invite.mutate({ email: email.trim(), role });
  }

  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        if (!next) invite.reset();
        onOpenChange(next);
      }}
      title="Invite a teammate"
      description="They get an email with a link that is valid for 7 days."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" type="submit" form="invite-form" icon={<Send />} loading={invite.isPending} disabled={!email.trim() || !role}>
            Send invitation
          </Button>
        </>
      }
    >
      <form id="invite-form" onSubmit={submit} className="flex flex-col gap-4" noValidate>
        <FormError error={invite.error && !Object.keys(fields).length && !invite.error.isPlanLimit ? invite.error.message : null} />
        <Field label="Email" error={fields.email}>
          <Input type="email" autoFocus autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@company.com" />
        </Field>
        <Field label="Role" error={fields.role} hint={role ? `${ROLE_DESCRIPTIONS[role]} (Default permissions; see Roles & permissions.)` : undefined}>
          <Select<EditableRole> value={role} onValueChange={setRole} options={roles.map((r) => ({ value: r, label: labelOf(r) }))} />
        </Field>
      </form>
    </Modal>
  );
}

function RoleCell({ member, editable }: { member: Member; editable: boolean }) {
  const ws = useWorkspace();
  const change = useApiMutation<ChangeRoleResult, WorkspaceRole>({
    method: "PATCH",
    path: ws.path(`/members/${member.id}`),
    body: (role) => ({ role }),
    invalidate: [ws.key("members")],
    success: (r) => `${member.name || member.email} is now ${labelOf(r.role).toLowerCase()}`,
  });
  if (!editable) {
    return (
      <Badge tone={member.role === "owner" ? "info" : "mute"} quiet={member.role !== "owner"}>
        {labelOf(member.role)}
      </Badge>
    );
  }
  return (
    <Select<WorkspaceRole>
      size="sm"
      aria-label={`Role for ${member.name || member.email}`}
      value={member.role}
      disabled={change.isPending}
      onValueChange={(role) => role !== member.role && change.mutate(role)}
      options={assignableRoles(ws.role).map((r) => ({ value: r, label: labelOf(r) }))}
      className="w-32"
    />
  );
}

function MembersTable({ members }: { members: Member[] }) {
  const ws = useWorkspace();
  const me = useMe();
  const f = useFormat();
  const myId = me.data?.user.id;
  const canManage = ws.can("members.manage");
  const [removing, setRemoving] = useState<Member | null>(null);

  const remove = useApiMutation<unknown, Member>({
    method: "DELETE",
    path: (m) => ws.path(`/members/${m.id}`),
    invalidate: (_, m) => (m.userId === myId ? [ME_KEY] : [ws.key("members")]),
    success: (_, m) => (m.userId === myId ? `You left ${ws.name}` : `${m.name || m.email} was removed`),
    errorToast: false,
    onSuccess: (_, m) => {
      // Leaving: this workspace is no longer theirs, so start over at "/".
      if (m.userId === myId) window.location.assign("/");
    },
  });

  const manageable = (m: Member) => canManage && m.role !== "owner" && m.userId !== myId && outranks(ws.role, m.role);
  const leaving = removing?.userId === myId;

  return (
    <>
      <div className={table.wrap}>
        <table className={table.table}>
          <thead>
            <tr>
              <th className={table.th}>Member</th>
              <th className={table.th}>Role</th>
              <th className={table.th}>Last sign-in</th>
              <th className={table.th}>Joined</th>
              <th className={table.th}>
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {members.map((m) => {
              const self = m.userId === myId;
              const canRemove = manageable(m);
              const canLeave = self && m.role !== "owner";
              return (
                <tr key={m.id}>
                  <td className={table.td}>
                    <div className="flex min-w-0 items-center gap-2.5">
                      <Avatar name={m.name} email={m.email} size="sm" />
                      <div className="min-w-0">
                        <div className="truncate font-medium text-text">
                          {m.name || m.email}
                          {self && <span className="ml-1.5 text-xs font-normal text-text-3">(you)</span>}
                        </div>
                        {m.name && <div className="truncate text-xs text-text-3">{m.email}</div>}
                      </div>
                    </div>
                  </td>
                  <td className={table.td}>
                    <RoleCell member={m} editable={manageable(m)} />
                  </td>
                  <td className={cn(table.td, "whitespace-nowrap text-text-2")}>{m.lastLoginAt ? f.relative(m.lastLoginAt) : "Never"}</td>
                  <td className={cn(table.td, "whitespace-nowrap text-text-2")}>{f.date(m.joinedAt)}</td>
                  <td className={cn(table.td, "w-10 text-right")}>
                    {(canRemove || canLeave) && (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <IconButton size="sm" label={`Actions for ${m.name || m.email}`} icon={<Ellipsis />} />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          {canRemove && (
                            <DropdownMenuItem danger icon={<UserMinus />} onSelect={() => setRemoving(m)}>
                              Remove from workspace
                            </DropdownMenuItem>
                          )}
                          {canLeave && (
                            <DropdownMenuItem danger icon={<LogOut />} onSelect={() => setRemoving(m)}>
                              Leave workspace
                            </DropdownMenuItem>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <ConfirmDialog
        open={Boolean(removing)}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={leaving ? `Leave ${ws.name}?` : `Remove ${removing?.name || removing?.email}?`}
        description={
          leaving
            ? "You lose access straight away. Someone with permission to manage members would have to invite you again."
            : "They lose access straight away. Their contacts, deals and conversations stay in the workspace, unassigned, and their open tasks become unassigned."
        }
        confirmLabel={leaving ? "Leave workspace" : "Remove"}
        onConfirm={() => removing && remove.mutateAsync(removing)}
      />
    </>
  );
}

function InvitationsCard({ invitations }: { invitations: InvitationRow[] }) {
  const ws = useWorkspace();
  const f = useFormat();
  const canManage = ws.can("members.manage");
  const [revoking, setRevoking] = useState<InvitationRow | null>(null);
  const resend = useApiMutation<unknown, InvitationRow>({
    path: (i) => ws.path(`/invitations/${i.id}/resend`),
    body: () => undefined,
    invalidate: [ws.key("members")],
    success: (_, i) => `Invitation sent again to ${i.email}`,
  });
  const revoke = useApiMutation<unknown, InvitationRow>({
    method: "DELETE",
    path: (i) => ws.path(`/invitations/${i.id}`),
    invalidate: [ws.key("members")],
    success: (_, i) => `Invitation to ${i.email} withdrawn`,
    errorToast: false,
  });

  if (!invitations.length) return null;

  return (
    <Card>
      <CardHeader icon={<MailPlus />} title="Pending invitations" description="Each counts as a team member against the plan until it is accepted, withdrawn or expires." />
      <div className={table.wrap}>
        <table className={table.table}>
          <thead>
            <tr>
              <th className={table.th}>Email</th>
              <th className={table.th}>Role</th>
              <th className={table.th}>Sent</th>
              <th className={table.th}>Expires</th>
              {canManage && (
                <th className={table.th}>
                  <span className="sr-only">Actions</span>
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {invitations.map((i) => (
              <tr key={i.id}>
                <td className={table.td}>
                  <span className="flex min-w-0 items-center gap-2">
                    <Mail aria-hidden className="size-3.5 shrink-0 text-text-3" />
                    <span className="truncate">{i.email}</span>
                  </span>
                </td>
                <td className={table.td}>
                  <Badge quiet>{labelOf(i.role)}</Badge>
                </td>
                <td className={cn(table.td, "whitespace-nowrap text-text-2")}>{f.relative(i.createdAt)}</td>
                <td className={cn(table.td, "whitespace-nowrap")}>
                  {i.expired ? <Badge tone="bad">Expired</Badge> : <span className="text-text-2">{f.date(i.expiresAt)}</span>}
                </td>
                {canManage && (
                  <td className={cn(table.td, "text-right whitespace-nowrap")}>
                    <span className="inline-flex gap-1">
                      <Button size="sm" variant="ghost" icon={<RotateCw />} loading={resend.isPending && resend.variables?.id === i.id} onClick={() => resend.mutate(i)}>
                        Resend
                      </Button>
                      <IconButton size="sm" variant="danger" label={`Withdraw invitation to ${i.email}`} icon={<Trash2 />} onClick={() => setRevoking(i)} />
                    </span>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ConfirmDialog
        open={Boolean(revoking)}
        onOpenChange={(open) => !open && setRevoking(null)}
        title={`Withdraw the invitation to ${revoking?.email}?`}
        description="The link in their email stops working. You can invite them again later."
        confirmLabel="Withdraw"
        onConfirm={() => revoking && revoke.mutateAsync(revoking)}
      />
    </Card>
  );
}

/** Settings → Members: who is in the workspace, their roles, and pending invitations. */
export function MembersSettings() {
  const ws = useWorkspace();
  const [inviting, setInviting] = useState(false);
  const canInvite = ws.can("members.manage") && assignableRoles(ws.role).length > 0;
  const list = useApiQuery<MembersResponse>(ws.key("members"), ws.path("/members"));

  return (
    <RequirePermission permission="members.read">
      <PageHeader
        icon={<EntityTile of="members" />}
        title="Members"
        description="Everyone who can sign in to this workspace. You can manage people below your own role."
        actions={
          canInvite ? (
            <Button variant="primary" icon={<UserPlus />} onClick={() => setInviting(true)}>
              Invite
            </Button>
          ) : undefined
        }
      />
      <QueryState query={list} loading={<SkeletonText lines={6} />}>
        {(data) => (
          <div className="flex flex-col gap-5">
            <Card>
              <CardHeader icon={<Users />} title={`Members · ${data.members.length}`} />
              {data.members.length ? (
                <MembersTable members={data.members} />
              ) : (
                <EmptyState compact icon={<Users />} title="No members" description="Invite a teammate to get started." />
              )}
            </Card>
            <InvitationsCard invitations={data.invitations} />
          </div>
        )}
      </QueryState>
      {canInvite && <InviteModal open={inviting} onOpenChange={setInviting} />}
    </RequirePermission>
  );
}
