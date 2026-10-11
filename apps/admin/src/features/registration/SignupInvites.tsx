"use client";

import { useState, type FormEvent } from "react";
import { MailPlus, Ticket, Trash2 } from "lucide-react";
import { SIGNUP_INVITE_DEFAULT_DAYS, SIGNUP_INVITE_STATUSES, type SignupInviteStatus } from "@growthdesk/shared";
import { Badge, type Tone } from "@/components/ui/Badge";
import { Button, IconButton } from "@/components/ui/Button";
import { Card, CardHeader } from "@/components/ui/Card";
import { ConfirmDialog, Modal } from "@/components/ui/Dialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { QueryState } from "@/components/ui/ErrorState";
import { Field, FormError } from "@/components/ui/Field";
import { Input, NativeSelect } from "@/components/ui/Input";
import { Pagination } from "@/components/ui/Pagination";
import { SkeletonText } from "@/components/ui/Skeleton";
import { cn } from "@/lib/cn";
import { useApiMutation, useApiQuery } from "@/lib/query";
import { useFormat } from "@/lib/session";
import type { Paged } from "@/lib/types";
import { PersonCell, platformKey, table, TableFooter } from "@/features/common/platform";
import { InviteLinkDialog } from "./InviteLinkDialog";
import type { CreatedInvite, SignupInvite } from "./types";

const STATUS: Record<SignupInviteStatus, { label: string; tone: Tone }> = {
  pending: { label: "Waiting", tone: "live" },
  used: { label: "Used", tone: "ok" },
  expired: { label: "Expired", tone: "mute" },
};
const EXPIRY_OPTIONS = [3, 7, 14, 30, 60, 90].map((d) => ({ value: String(d), label: `${d} days` }));
const invitesKey = platformKey("signup-invites");

function NewInviteDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (v: boolean) => void; onCreated: (r: CreatedInvite) => void }) {
  const [email, setEmail] = useState("");
  const [days, setDays] = useState(String(SIGNUP_INVITE_DEFAULT_DAYS));
  const create = useApiMutation<CreatedInvite, { email: string; expiresDays: number }>({
    path: "/admin/signup-invites",
    invalidate: [invitesKey],
    errorToast: false,
    onSuccess: (r) => {
      setEmail("");
      onOpenChange(false);
      onCreated(r);
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate({ email: email.trim(), expiresDays: Number(days) });
  };
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="New sign-up invitation"
      description="Emails a one-time link that lets this address create an account, in any mode except Closed. It skips the domain rules."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" type="submit" form="new-invite" icon={<MailPlus />} loading={create.isPending} disabled={!email.trim()}>
            Send invitation
          </Button>
        </>
      }
    >
      <form id="new-invite" onSubmit={submit} className="flex flex-col gap-3">
        <FormError error={create.error && !create.error.fields.email ? create.error.message : null} />
        <Field label="Email address" error={create.error?.fields.email}>
          <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus autoComplete="off" />
        </Field>
        <Field label="Link works for">
          <NativeSelect value={days} onChange={(e) => setDays(e.target.value)} options={EXPIRY_OPTIONS} className="sm:max-w-40" />
        </Field>
      </form>
    </Modal>
  );
}

/** One-time sign-up invitations: create, list, revoke. */
export function SignupInvites() {
  const f = useFormat();
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<CreatedInvite | null>(null);
  const [revoking, setRevoking] = useState<SignupInvite | null>(null);
  const list = useApiQuery<Paged<SignupInvite>>(invitesKey, "/admin/signup-invites", { query: { status: status || undefined, page, pageSize }, keepPrevious: true });
  const revoke = useApiMutation<{ revoked: boolean }, SignupInvite>({
    method: "DELETE",
    path: (i) => `/admin/signup-invites/${i.id}`,
    invalidate: [invitesKey],
    success: "Invitation revoked",
    errorToast: false,
  });

  return (
    <Card>
      <CardHeader
        icon={<Ticket />}
        title="Sign-up invitations"
        description="Every one-time sign-up link, including those sent from the waitlist."
        actions={
          <div className="flex items-center gap-2">
            <NativeSelect
              aria-label="Status"
              size="sm"
              value={status}
              onChange={(e) => {
                setStatus(e.target.value);
                setPage(1);
              }}
              placeholder="All"
              options={SIGNUP_INVITE_STATUSES.map((s) => ({ value: s, label: STATUS[s].label }))}
              className="w-28"
            />
            <Button size="sm" variant="primary" icon={<MailPlus />} onClick={() => setCreating(true)}>
              New invitation
            </Button>
          </div>
        }
      />
      <QueryState
        query={list}
        loading={<SkeletonText lines={4} className="p-4" />}
        isEmpty={(d) => d.total === 0}
        empty={<EmptyState compact icon={<Ticket />} title={status ? "No invitations with this status" : "No invitations yet"} />}
      >
        {(data) => (
          <div className={cn(list.isPlaceholderData && "opacity-60")}>
            <div className={table.wrap}>
              <table className={table.table}>
                <thead>
                  <tr>
                    <th className={table.th}>Email</th>
                    <th className={table.th}>Status</th>
                    <th className={table.th}>Expires</th>
                    <th className={table.th}>Sent by</th>
                    <th className={table.th}>Sent</th>
                    <th className={table.th}>
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((i) => (
                    <tr key={i.id} className="hover:bg-hover">
                      <td className={cn(table.td, "max-w-64 truncate font-medium")}>{i.email}</td>
                      <td className={table.td}>
                        <Badge tone={STATUS[i.status].tone} dot>
                          {STATUS[i.status].label}
                        </Badge>
                        {i.usedAt && <div className="mt-0.5 text-xs text-text-3">{f.relative(i.usedAt)}</div>}
                      </td>
                      <td className={cn(table.td, "whitespace-nowrap text-text-2")}>{i.status === "used" ? "—" : f.dateTime(i.expiresAt)}</td>
                      <td className={cn(table.td, "max-w-48")}>
                        <PersonCell person={i.createdBy} />
                      </td>
                      <td className={cn(table.td, "whitespace-nowrap text-text-2")}>{f.date(i.createdAt)}</td>
                      <td className={cn(table.td, "text-right")}>
                        {i.status !== "used" && <IconButton label={`Revoke the invitation for ${i.email}`} icon={<Trash2 />} variant="danger" size="sm" onClick={() => setRevoking(i)} />}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <TableFooter>
              <Pagination
                page={data.page}
                pageSize={data.pageSize}
                total={data.total}
                onPageChange={setPage}
                onPageSizeChange={(s) => {
                  setPageSize(s);
                  setPage(1);
                }}
              />
            </TableFooter>
          </div>
        )}
      </QueryState>
      <NewInviteDialog open={creating} onOpenChange={setCreating} onCreated={setCreated} />
      <InviteLinkDialog created={created} onClose={() => setCreated(null)} />
      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(v) => !v && setRevoking(null)}
        title="Revoke this invitation?"
        description={revoking ? `The link sent to ${revoking.email} stops working straight away. You can send a new one later.` : undefined}
        confirmLabel="Revoke"
        onConfirm={() => revoking && revoke.mutateAsync(revoking)}
      />
    </Card>
  );
}
