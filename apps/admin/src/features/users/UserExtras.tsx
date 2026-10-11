"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { Ellipsis, KeyRound, MailCheck, MailPlus, Megaphone, NotebookPen, Plus, Send, ShieldOff, Tags, Trash2, AtSign, X } from "lucide-react";
import { normalizeUserTag, USER_TAG_PATTERN } from "@growthdesk/shared";
import { Avatar } from "@/components/ui/Avatar";
import { Badge } from "@/components/ui/Badge";
import { Button, IconButton } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Card, CardBody, CardFooter, CardHeader } from "@/components/ui/Card";
import { ConfirmDialog, Modal } from "@/components/ui/Dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/DropdownMenu";
import { EmptyState } from "@/components/ui/EmptyState";
import { QueryState } from "@/components/ui/ErrorState";
import { Field, FormError } from "@/components/ui/Field";
import { Input, Textarea } from "@/components/ui/Input";
import { KeyValueList } from "@/components/ui/KeyValue";
import { SkeletonText } from "@/components/ui/Skeleton";
import type { ApiError } from "@/lib/api";
import { useApiMutation, useApiQuery } from "@/lib/query";
import { useFormat } from "@/lib/session";
import { PLATFORM_RANK, platformKey, usePlatform } from "@/features/common/platform";
import { CONSENT_SOURCE_LABELS, SIGNUP_SOURCE_LABELS, type UserDetailData, type UserNote } from "./profile";

/*
 * The Phase 3 parts of a user's page: sign-up and consent facts, tags,
 * internal notes, and the account actions (verification, password reset,
 * change email, delete & anonymise). The API enforces every rank rule; the
 * menu only hides what the viewer cannot do.
 */

const usersKey = platformKey("users");

// ─── Sign-up & consent ───────────────────────────────────────────────────────

export function ProfileCard({ u }: { u: UserDetailData }) {
  const f = useFormat();
  const p = u.profile;
  const utm = p?.utm ?? {};
  const utmLine = (["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"] as const)
    .filter((k) => utm[k])
    .map((k) => (
      <div key={k} className="truncate" title={utm[k]}>
        <span className="text-text-3">{k.replace("utm_", "")}: </span>
        {utm[k]}
      </div>
    ));
  return (
    <Card>
      <CardHeader icon={<Megaphone />} title="Sign-up & consent" description="How this account arrived, and what it agreed to receive." />
      <CardBody>
        {p ? (
          <KeyValueList
            items={[
              { label: "Signed up with", value: p.signupSource ? SIGNUP_SOURCE_LABELS[p.signupSource] : null },
              { label: "Campaign (UTM)", value: utmLine.length ? <div className="flex flex-col">{utmLine}</div> : null },
              {
                label: "Came from",
                value: p.referrer ? (
                  <span className="break-all" title={p.referrer}>
                    {p.referrer}
                  </span>
                ) : null,
              },
              { label: "First page", value: p.landingPath ? <span className="font-mono text-xs">{p.landingPath}</span> : null },
              {
                label: "Product emails",
                value: p.marketingConsent ? <Badge tone="ok">Opted in</Badge> : <span className="text-text-2">Not opted in</span>,
                hint: p.marketingConsent && p.consentAt ? `Since ${f.dateTime(p.consentAt)}${p.consentSource ? ` via ${CONSENT_SOURCE_LABELS[p.consentSource] ?? p.consentSource}` : ""}` : undefined,
              },
              { label: "Unsubscribed", value: p.unsubscribedAt ? f.dateTime(p.unsubscribedAt) : null },
              {
                label: "Suppressed",
                value: p.suppressedAt ? <Badge tone="bad">Suppressed</Badge> : null,
                hint: p.suppressedAt ? `${f.dateTime(p.suppressedAt)}${p.suppressionReason ? ` · ${p.suppressionReason}` : ""}` : undefined,
              },
            ]}
          />
        ) : (
          <p className="text-sm text-text-3">No sign-up record. This account was created before sign-up details were tracked, so its source and consent are unknown (treated as not opted in).</p>
        )}
      </CardBody>
    </Card>
  );
}

// ─── Tags ────────────────────────────────────────────────────────────────────

export function TagsCard({ u }: { u: UserDetailData }) {
  const [draft, setDraft] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const save = useApiMutation<{ tags: string[] }, string[]>({
    method: "PUT",
    path: `/admin/users/${u.id}/tags`,
    body: (tags) => ({ tags }),
    invalidate: [usersKey],
    errorToast: false,
    onSuccess: () => setDraft(""),
  });
  const deleted = Boolean(u.anonymisedAt);
  const add = (e: FormEvent) => {
    e.preventDefault();
    const tag = normalizeUserTag(draft);
    if (!tag) return;
    if (!USER_TAG_PATTERN.test(tag)) return setProblem("Use letters, digits and - _ : . (up to 40 characters).");
    if (u.tags.includes(tag)) return setDraft("");
    if (u.tags.length >= 20) return setProblem("At most 20 tags.");
    setProblem(null);
    save.mutate([...u.tags, tag]);
  };
  return (
    <Card>
      <CardHeader icon={<Tags />} title="Tags" description="Internal labels for filtering and, later, audiences." />
      <CardBody className="flex flex-col gap-3">
        {u.tags.length ? (
          <div className="flex flex-wrap gap-1.5">
            {u.tags.map((t) => (
              <span key={t} className="inline-flex h-6 items-center gap-1 rounded-xs bg-mute-chip pr-1 pl-2 text-xs text-text-2">
                {t}
                {!deleted && (
                  <button
                    type="button"
                    aria-label={`Remove ${t}`}
                    disabled={save.isPending}
                    onClick={() => save.mutate(u.tags.filter((x) => x !== t))}
                    className="rounded-xs p-0.5 text-text-3 hover:bg-hover hover:text-text"
                  >
                    <X aria-hidden className="size-3" />
                  </button>
                )}
              </span>
            ))}
          </div>
        ) : (
          <p className="text-sm text-text-3">No tags.</p>
        )}
        {!deleted && (
          <form onSubmit={add} className="flex gap-2">
            <Input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Add a tag, e.g. vip" maxLength={40} aria-label="New tag" />
            <Button type="submit" icon={<Plus />} loading={save.isPending} disabled={!draft.trim()}>
              Add
            </Button>
          </form>
        )}
        <FormError error={problem ?? save.error?.message} />
      </CardBody>
    </Card>
  );
}

// ─── Notes ───────────────────────────────────────────────────────────────────

export function NotesCard({ u }: { u: UserDetailData }) {
  const f = useFormat();
  const [note, setNote] = useState("");
  const key = platformKey("users", u.id, "notes");
  const notes = useApiQuery<UserNote[]>(key, `/admin/users/${u.id}/notes`);
  const add = useApiMutation<UserNote, { body: string }>({
    path: `/admin/users/${u.id}/notes`,
    invalidate: [key],
    errorToast: false,
    onSuccess: () => setNote(""),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (note.trim()) add.mutate({ body: note.trim() });
  };
  return (
    <Card>
      <CardHeader icon={<NotebookPen />} title="Internal notes" description="Visible to platform staff only; never shown to the customer." />
      <QueryState query={notes} loading={<SkeletonText lines={3} className="p-4" />}>
        {(rows) =>
          rows.length ? (
            <ol>
              {rows.map((n) => (
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
          )
        }
      </QueryState>
      {!u.anonymisedAt && (
        <form onSubmit={submit}>
          <CardBody className="border-t border-line">
            <FormError error={add.error?.message} />
            <Field label="Add a note">
              <Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} maxLength={5000} placeholder="Context for the next person: what they asked, what you did, what was agreed." />
            </Field>
          </CardBody>
          <CardFooter>
            <Button type="submit" variant="primary" icon={<Send />} loading={add.isPending} disabled={!note.trim()}>
              Add note
            </Button>
          </CardFooter>
        </form>
      )}
    </Card>
  );
}

// ─── Actions ─────────────────────────────────────────────────────────────────

function ChangeEmailDialog({ u, open, onOpenChange }: { u: UserDetailData; open: boolean; onOpenChange: (v: boolean) => void }) {
  const [email, setEmail] = useState("");
  const save = useApiMutation<UserDetailData, { email: string }>({
    method: "PUT",
    path: `/admin/users/${u.id}/email`,
    invalidate: [usersKey],
    success: "Email address changed",
    errorToast: false,
    onSuccess: () => {
      setEmail("");
      onOpenChange(false);
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate({ email: email.trim() });
  };
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Change email address"
      description={`Currently ${u.email}.`}
      dismissOnOutside={false}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" type="submit" form="change-email" loading={save.isPending} disabled={!email.trim()}>
            Change email
          </Button>
        </>
      }
    >
      <form id="change-email" onSubmit={submit} className="flex flex-col gap-3">
        <FormError error={save.error && !save.error.fields.email ? save.error.message : null} />
        <Field label="New email address" error={save.error?.fields.email}>
          <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus autoComplete="off" />
        </Field>
        <Callout tone="info" title="What happens">
          <ul className="list-disc pl-4">
            <li>The old address is told about the change.</li>
            <li>The new address must be confirmed; a confirmation link is sent to it.</li>
            <li>They are signed out everywhere, and open reset or confirmation links stop working.</li>
            <li>A linked Google sign-in stays linked.</li>
          </ul>
        </Callout>
      </form>
    </Modal>
  );
}

/** A 409 from DELETE /admin/users/:id carries the blocking record's id in `details`. */
function DeleteBlocker({ error }: { error: ApiError }) {
  const billingAccountId = typeof error.details.billingAccountId === "string" ? error.details.billingAccountId : null;
  const workspaceId = typeof error.details.workspaceId === "string" ? error.details.workspaceId : null;
  return (
    <Callout tone="bad" title={error.status === 409 ? "This account can't be deleted yet" : "Not deleted"}>
      <p>{error.message}</p>
      {(billingAccountId || workspaceId) && (
        <p className="mt-1.5">
          {billingAccountId && (
            <Link href={`/billing/${billingAccountId}`} className="font-medium underline">
              Open the billing account
            </Link>
          )}
          {workspaceId && (
            <Link href={`/workspaces/${workspaceId}`} className="font-medium underline">
              Open the workspace
            </Link>
          )}
        </p>
      )}
    </Callout>
  );
}

function DeleteDialog({ u, open, onOpenChange }: { u: UserDetailData; open: boolean; onOpenChange: (v: boolean) => void }) {
  const [typed, setTyped] = useState("");
  const remove = useApiMutation<{ anonymised: boolean; apiKeysRevoked: number; workspacesSuspended: number }>({
    method: "DELETE",
    path: `/admin/users/${u.id}`,
    invalidate: [usersKey],
    errorToast: false,
    success: (r) =>
      `Account deleted${r.apiKeysRevoked ? ` · ${r.apiKeysRevoked} API key${r.apiKeysRevoked === 1 ? "" : "s"} revoked` : ""}${r.workspacesSuspended ? ` · ${r.workspacesSuspended} workspace${r.workspacesSuspended === 1 ? "" : "s"} suspended` : ""}`,
    onSuccess: () => {
      setTyped("");
      onOpenChange(false);
    },
  });
  const change = (v: boolean) => {
    if (remove.isPending) return;
    if (!v) {
      setTyped("");
      remove.reset();
    }
    onOpenChange(v);
  };
  return (
    <Modal
      open={open}
      onOpenChange={change}
      title={`Delete ${u.name || u.email}?`}
      description="Deletes the person's personal data. This cannot be undone."
      dismissOnOutside={false}
      footer={
        <>
          <Button onClick={() => change(false)}>Cancel</Button>
          <Button variant="danger" icon={<Trash2 />} loading={remove.isPending} disabled={typed.trim().toLowerCase() !== u.email.toLowerCase()} onClick={() => remove.mutate()}>
            Delete & anonymise
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 text-sm text-text-2">
        {remove.error && <DeleteBlocker error={remove.error} />}
        <p>The account record stays (billing history and workspace records point at it), but everything that identifies the person is removed:</p>
        <ul className="list-disc space-y-1 pl-5">
          <li>A last email goes to {u.email} saying the account was deleted.</li>
          <li>Email becomes deleted+…@invalid; name, password, Google link and avatar are cleared; the account is disabled.</li>
          <li>Every session, open link and API key they created stops working.</li>
          <li>Their address is removed from the platform email log, waitlist and invitations; notes, tags and consent are erased.</li>
          <li>Workspaces only they use are suspended, so nothing keeps sending in their name.</li>
        </ul>
        <p>Refused while they own a paid subscription that is still live, or a workspace other people use.</p>
        <label className="block text-xs text-text-2">
          Type <span className="font-semibold text-text">{u.email}</span> to confirm
          <Input className="mt-1.5" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
        </label>
      </div>
    </Modal>
  );
}

/** The "⋯" menu beside the page's main actions. Renders nothing when the viewer can do none of it. */
export function UserActionsMenu({ u, self }: { u: UserDetailData; self: boolean }) {
  const { role } = usePlatform();
  const [dialog, setDialog] = useState<"email" | "delete" | "two-factor" | null>(null);
  const resend = useApiMutation({ path: `/admin/users/${u.id}/resend-verification`, success: "Confirmation link sent" });
  const verify = useApiMutation({ path: `/admin/users/${u.id}/verify-email`, invalidate: [usersKey], success: "Email marked as confirmed" });
  const reset = useApiMutation({ path: `/admin/users/${u.id}/password-reset`, success: `Password reset link sent to ${u.email}` });
  const resetTwoFactor = useApiMutation({
    path: `/admin/users/${u.id}/two-factor/reset`,
    invalidate: [usersKey],
    success: "Two-factor turned off and every session ended",
    errorToast: false,
  });

  if (u.anonymisedAt || self) return null;
  const rank = PLATFORM_RANK[role];
  // AdminService.assertMayManage: only an owner acts on staff at or above their own rank.
  const outranked = role !== "owner" && PLATFORM_RANK[u.platformRole] >= rank;
  if (outranked) return null;
  const support = rank >= PLATFORM_RANK.support;
  const admin = rank >= PLATFORM_RANK.admin;
  // Deletion: owner only, and never another owner.
  const canDelete = role === "owner" && u.platformRole !== "owner";
  const items = [support && !u.emailVerified, admin, canDelete].some(Boolean);
  if (!items) return null;

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <IconButton label="More actions" icon={<Ellipsis />} variant="secondary" size="sm" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {support && !u.emailVerified && (
            <DropdownMenuItem icon={<MailPlus />} disabled={resend.isPending} onSelect={() => resend.mutate()}>
              Resend confirmation email
            </DropdownMenuItem>
          )}
          {admin && !u.emailVerified && (
            <DropdownMenuItem icon={<MailCheck />} disabled={verify.isPending} onSelect={() => verify.mutate()}>
              Mark email as confirmed
            </DropdownMenuItem>
          )}
          {admin && (
            <DropdownMenuItem icon={<KeyRound />} disabled={reset.isPending || Boolean(u.disabledAt)} onSelect={() => reset.mutate()}>
              Send password reset
            </DropdownMenuItem>
          )}
          {admin && (
            <DropdownMenuItem icon={<AtSign />} onSelect={() => setDialog("email")}>
              Change email…
            </DropdownMenuItem>
          )}
          {admin && u.twoFactorEnabledAt && (
            <DropdownMenuItem icon={<ShieldOff />} onSelect={() => setDialog("two-factor")}>
              Reset two-factor…
            </DropdownMenuItem>
          )}
          {canDelete && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem danger icon={<Trash2 />} onSelect={() => setDialog("delete")}>
                Delete & anonymise…
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {admin && <ChangeEmailDialog u={u} open={dialog === "email"} onOpenChange={(v) => setDialog(v ? "email" : null)} />}
      {canDelete && <DeleteDialog u={u} open={dialog === "delete"} onOpenChange={(v) => setDialog(v ? "delete" : null)} />}
      {admin && (
        <ConfirmDialog
          open={dialog === "two-factor"}
          onOpenChange={(v) => setDialog(v ? "two-factor" : null)}
          title="Reset two-factor authentication?"
          description={`For someone who lost both their authenticator app and their recovery codes. Confirm it is really ${u.email} asking (for example, a reply from that address) before you go on. Two-factor is turned off, the recovery codes stop working, every session ends, and they are emailed about it. They sign in with their password and set two-factor up again.`}
          confirmLabel="Reset two-factor"
          onConfirm={() => resetTwoFactor.mutateAsync()}
        />
      )}
    </>
  );
}
