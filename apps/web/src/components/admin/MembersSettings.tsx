"use client";

import { useState, type FormEvent } from "react";
import { Ellipsis, LogOut, Mail, MailPlus, Pause, Play, RotateCw, Send, Trash2, UserMinus, UserPlus, Users } from "lucide-react";
import { labelOf, type WorkspaceRole } from "@growthdesk/shared";
import { Avatar } from "@/components/ui/Avatar";
import { Badge, type Tone } from "@/components/ui/Badge";
import { Button, IconButton } from "@/components/ui/Button";
import { Card, CardHeader } from "@/components/ui/Card";
import { COL, ColumnLabel } from "@/components/ui/columns";
import { ConfirmDialog, Modal } from "@/components/ui/Dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/DropdownMenu";
import { EmptyState } from "@/components/ui/EmptyState";
import { EntityTile } from "@/components/ui/icons";
import { QueryState } from "@/components/ui/ErrorState";
import { Field, FormError } from "@/components/ui/Field";
import { Textarea } from "@/components/ui/Input";
import { PageHeader } from "@/components/ui/PageHeader";
import { RequirePermission } from "@/components/ui/RequirePermission";
import { Select } from "@/components/ui/Select";
import { SkeletonText } from "@/components/ui/Skeleton";
import { toast } from "@/components/ui/Toast";
import { cn } from "@/lib/cn";
import { useApiMutation, useApiQuery } from "@/lib/query";
import { ME_KEY, useFormat, useMe, useWorkspace, workspaceDetailKey } from "@/lib/session";
import type { Member, MembersResponse } from "@/lib/types";
import type { BulkInviteResult, ChangeRoleResult, EditableRole, InvitationRow, InviteOutcome } from "@/lib/types/admin";
import { assignableRoles, outranks, ROLE_DESCRIPTIONS, table } from "./labels";
import { RemoveMemberModal } from "./RemoveMemberModal";

/** Every address in what was typed or pasted: separated by commas, semicolons, spaces or new lines; repeats dropped. */
function parseEmails(raw: string): string[] {
  const seen = new Set<string>();
  return raw
    .split(/[\s,;]+/)
    .map((e) => e.trim())
    .filter((e) => {
      const key = e.toLowerCase();
      if (!e || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

const OUTCOME: Record<InviteOutcome["status"], { label: string; tone: Tone }> = {
  invited: { label: "Invited", tone: "ok" },
  already_member: { label: "Already a member", tone: "mute" },
  already_invited: { label: "Already invited — resend it from Pending invitations", tone: "mute" },
  no_seat: { label: "No seat left on the plan", tone: "warn" },
  invalid: { label: "Not a valid email address", tone: "bad" },
};

function InviteModal({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const ws = useWorkspace();
  const roles = assignableRoles(ws.role);
  const [emails, setEmails] = useState("");
  const [role, setRole] = useState<EditableRole | undefined>(roles.includes("member") ? "member" : roles[roles.length - 1]);
  const [message, setMessage] = useState("");
  const [results, setResults] = useState<InviteOutcome[] | null>(null);
  const list = parseEmails(emails);
  const invite = useApiMutation<BulkInviteResult, { emails: string[]; role: EditableRole; message: string }>({
    path: ws.path("/invitations"),
    invalidate: [ws.key("members"), workspaceDetailKey(ws.id)],
    errorToast: false,
    onSuccess: (r) => {
      const sent = r.results.filter((x) => x.status === "invited").length;
      if (sent === r.results.length) {
        toast.success(sent === 1 ? `Invitation sent to ${r.results[0]!.email}` : `${sent} invitations sent`);
        close();
        return;
      }
      setResults(r.results);
    },
  });
  const fields = invite.error?.fields ?? {};

  function close() {
    setEmails("");
    setMessage("");
    setResults(null);
    invite.reset();
    onOpenChange(false);
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!role || !list.length) return;
    invite.mutate({ emails: list, role, message: message.trim() });
  }

  const sent = results?.filter((r) => r.status === "invited").length ?? 0;

  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
        else onOpenChange(next);
      }}
      title={results ? "Invitations" : "Invite teammates"}
      description={
        results
          ? `${sent} sent, ${results.length - sent} skipped.`
          : "They get an email with a link that is valid for 7 days."
      }
      footer={
        results ? (
          <>
            <Button
              onClick={() => {
                setResults(null);
                setEmails(results.filter((r) => r.status === "no_seat" || r.status === "invalid").map((r) => r.email).join("\n"));
                invite.reset();
              }}
            >
              Invite more
            </Button>
            <Button variant="primary" onClick={close}>
              Done
            </Button>
          </>
        ) : (
          <>
            <Button onClick={close}>Cancel</Button>
            <Button variant="primary" type="submit" form="invite-form" icon={<Send />} loading={invite.isPending} disabled={!list.length || list.length > 50 || !role}>
              {list.length > 1 ? `Send ${list.length} invitations` : "Send invitation"}
            </Button>
          </>
        )
      }
    >
      {results ? (
        <ul className="divide-y divide-line rounded-md border border-line">
          {results.map((r) => (
            <li key={r.email} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
              <span className="flex min-w-0 items-center gap-2">
                <Mail aria-hidden className="size-3.5 shrink-0 text-text-3" />
                <span className="truncate">{r.email}</span>
              </span>
              <Badge tone={OUTCOME[r.status].tone}>{OUTCOME[r.status].label}</Badge>
            </li>
          ))}
        </ul>
      ) : (
        <form id="invite-form" onSubmit={submit} className="flex flex-col gap-4" noValidate>
          <FormError error={invite.error && !Object.keys(fields).length && !invite.error.isPlanLimit ? invite.error.message : null} />
          <Field
            label="Email addresses"
            error={fields.emails ?? fields.email ?? (list.length > 50 ? "Up to 50 at a time." : undefined)}
            hint={list.length ? `${list.length} ${list.length === 1 ? "address" : "addresses"}` : "One or many, separated by commas, spaces or new lines."}
          >
            <Textarea autoFocus rows={3} value={emails} onChange={(e) => setEmails(e.target.value)} placeholder={"name@company.com, another@company.com"} />
          </Field>
          <Field label="Role" error={fields.role} hint={role ? `${ROLE_DESCRIPTIONS[role]} (Default permissions; see Roles & permissions.)` : undefined}>
            <Select<EditableRole> value={role} onValueChange={setRole} options={roles.map((r) => ({ value: r, label: labelOf(r) }))} />
          </Field>
          <Field label="Personal note" error={fields.message} hint={`Optional. Shown in the email and on the page where they accept. ${message.length}/500`}>
            <Textarea rows={3} value={message} onChange={(e) => setMessage(e.target.value)} maxLength={500} placeholder="Welcome aboard! You'll be looking after our UK leads." />
          </Field>
        </form>
      )}
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
  const [pausing, setPausing] = useState<{ member: Member; deactivated: boolean } | null>(null);
  const setPaused = useApiMutation<ChangeRoleResult, { member: Member; deactivated: boolean }>({
    method: "PATCH",
    path: (v) => ws.path(`/members/${v.member.id}`),
    body: (v) => ({ deactivated: v.deactivated }),
    invalidate: [ws.key("members")],
    success: (_, v) => (v.deactivated ? `${v.member.name || v.member.email}'s access is paused` : `${v.member.name || v.member.email}'s access is restored`),
    errorToast: false,
  });
  const now = Date.now();

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
              <th className={table.th}><ColumnLabel icon={COL.person}>Member</ColumnLabel></th>
              <th className={table.th}><ColumnLabel icon={COL.role}>Role</ColumnLabel></th>
              <th className={table.th}><ColumnLabel icon={COL.updated}>Last sign-in</ColumnLabel></th>
              <th className={table.th}><ColumnLabel icon={COL.created}>Joined</ColumnLabel></th>
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
                        <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5">
                          <span className="truncate font-medium text-text">{m.name || m.email}</span>
                          {self && <span className="text-xs font-normal text-text-3">(you)</span>}
                          {m.deactivatedAt && (
                            <Badge tone="warn" title="Can't open the workspace and gets no new leads. Still counts as a seat.">
                              Paused
                            </Badge>
                          )}
                          {m.outOfOfficeUntil && new Date(m.outOfOfficeUntil).getTime() > now && (
                            <Badge tone="info" title="Lead routing skips them until then.">
                              Away until {f.dateTime(m.outOfOfficeUntil)}
                            </Badge>
                          )}
                        </div>
                        {m.title && <div className="truncate text-xs text-text-2">{m.title}</div>}
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
                          {canRemove && !m.deactivatedAt && (
                            <DropdownMenuItem icon={<Pause />} onSelect={() => setPausing({ member: m, deactivated: true })}>
                              Pause access
                            </DropdownMenuItem>
                          )}
                          {canRemove && m.deactivatedAt && (
                            <DropdownMenuItem icon={<Play />} onSelect={() => setPausing({ member: m, deactivated: false })}>
                              Restore access
                            </DropdownMenuItem>
                          )}
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
        open={Boolean(removing) && leaving}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={`Leave ${ws.name}?`}
        description="You lose access straight away. Someone with permission to manage members would have to invite you again. What you own stays, unassigned."
        confirmLabel="Leave workspace"
        onConfirm={() => removing && remove.mutateAsync(removing)}
      />
      <ConfirmDialog
        open={Boolean(pausing)}
        onOpenChange={(open) => !open && setPausing(null)}
        tone={pausing?.deactivated ? "danger" : "default"}
        title={pausing?.deactivated ? `Pause ${pausing.member.name || pausing.member.email}'s access?` : `Restore ${pausing?.member.name || pausing?.member.email}'s access?`}
        description={
          pausing?.deactivated
            ? "They can't open the workspace and get no new leads; their records stay theirs — use Remove to hand them over. They still count as a seat on your plan. You can restore access at any time."
            : "They can open the workspace again with their role as before, and lead routing includes them again."
        }
        confirmLabel={pausing?.deactivated ? "Pause access" : "Restore access"}
        onConfirm={() => pausing && setPaused.mutateAsync(pausing)}
      />
      {/* Removing someone else hands their work over first (RemoveMemberModal). */}
      <RemoveMemberModal member={removing && !leaving ? removing : null} members={members} onOpenChange={(open) => !open && setRemoving(null)} />
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
              <th className={table.th}><ColumnLabel icon={COL.email}>Email</ColumnLabel></th>
              <th className={table.th}><ColumnLabel icon={COL.role}>Role</ColumnLabel></th>
              <th className={table.th}><ColumnLabel icon={COL.created}>Sent</ColumnLabel></th>
              <th className={table.th}><ColumnLabel icon={COL.due}>Expires</ColumnLabel></th>
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
              <CardHeader
                icon={<Users />}
                title={`Members · ${data.members.length}`}
                description={data.members.some((m) => m.deactivatedAt) ? "Paused members can't open the workspace but still count as seats on your plan." : undefined}
              />
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
