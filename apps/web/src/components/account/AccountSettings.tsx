"use client";

import { useMemo, useState, type FormEvent } from "react";
import Link from "next/link";
import { KeyRound, LayoutGrid, LogOut, Monitor, MonitorSmartphone, Palette, Smartphone, UserRound, X } from "lucide-react";
import { labelOf } from "@growthdesk/shared";
import { Badge } from "@/components/ui/Badge";
import { Button, IconButton } from "@/components/ui/Button";
import { Card, CardBody, CardFooter, CardHeader } from "@/components/ui/Card";
import { ConfirmDialog } from "@/components/ui/Dialog";
import { ErrorState, QueryState } from "@/components/ui/ErrorState";
import { Field, FormError } from "@/components/ui/Field";
import { EntityTile } from "@/components/ui/icons";
import { Input, NativeSelect } from "@/components/ui/Input";
import { Page, PageHeader } from "@/components/ui/PageHeader";
import { LoadingBlock, SkeletonText } from "@/components/ui/Skeleton";
import { toast } from "@/components/ui/Toast";
import { browserTimeZone, timeZones, zoneAbbreviation } from "@/lib/format";
import { useApiMutation, useApiQuery, useInvalidate } from "@/lib/query";
import { ME_KEY, useFormat, useMe } from "@/lib/session";
import type { Me, SessionRow } from "@/lib/types";
import { ProductEmailsCard } from "./ProductEmailsCard";
import { ThemePicker } from "./ThemePicker";
import { TwoFactorCard } from "./TwoFactorCard";
import { describeUserAgent, isMobileAgent } from "./userAgent";

const SESSIONS_KEY = ["account", "sessions"];

type User = Me["user"];

function ProfileCard({ user }: { user: User }) {
  const zones = useMemo(() => timeZones(), []);
  const initialZone = user.timezone || browserTimeZone();
  const [name, setName] = useState(user.name);
  const [timezone, setTimezone] = useState(initialZone);
  const save = useApiMutation<{ updated: true }, { name: string; timezone: string }>({
    method: "PATCH",
    path: "/auth/me",
    invalidate: [ME_KEY],
    success: "Profile saved",
    errorToast: false,
  });
  const resend = useApiMutation<{ alreadyVerified: boolean }>({
    path: "/auth/resend-verification",
    invalidate: [ME_KEY],
    success: (r) => (r.alreadyVerified ? "Your email is already confirmed" : `Confirmation link sent to ${user.email}`),
  });
  const fields = save.error?.fields ?? {};
  const dirty = name.trim() !== user.name || timezone !== (user.timezone ?? "");

  function submit(e: FormEvent) {
    e.preventDefault();
    save.mutate({ name: name.trim(), timezone });
  }

  return (
    <Card>
      <CardHeader icon={<UserRound />} title="Profile" description="How you appear to teammates in every workspace." />
      <form onSubmit={submit} noValidate>
        <CardBody className="grid gap-4 sm:grid-cols-2">
          <FormError className="sm:col-span-2" error={save.error && !Object.keys(fields).length ? save.error.message : null} />
          <Field label="Name" error={fields.name}>
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} autoComplete="name" required />
          </Field>
          <Field
            label="Email"
            hint={user.emailVerified ? "Confirmed. Your email address can't be changed here." : "Not confirmed yet — check your inbox for the link."}
            labelAction={user.emailVerified ? <Badge tone="ok">Confirmed</Badge> : <Badge tone="warn">Unconfirmed</Badge>}
          >
            <Input value={user.email} readOnly />
          </Field>
          <Field label="Time zone" error={fields.timezone} hint={`Now ${zoneAbbreviation(timezone)}. Workspace screens show times in the workspace's own zone.`}>
            <NativeSelect value={timezone} onChange={(e) => setTimezone(e.target.value)}>
              {!zones.includes(timezone) && <option value={timezone}>{timezone}</option>}
              {zones.map((z) => (
                <option key={z} value={z}>
                  {z.replace(/_/g, " ")}
                </option>
              ))}
            </NativeSelect>
          </Field>
        </CardBody>
        <CardFooter className={user.emailVerified ? undefined : "justify-between"}>
          {!user.emailVerified && (
            <Button variant="ghost" loading={resend.isPending} onClick={() => resend.mutate()}>
              Resend confirmation email
            </Button>
          )}
          <Button type="submit" variant="primary" loading={save.isPending} disabled={!dirty || !name.trim()}>
            Save profile
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}

function PasswordCard({ user }: { user: User }) {
  const invalidate = useInvalidate();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  // An account that signs in with Google (or was invited without one) has no password to confirm.
  const setting = !user.hasPassword;
  const change = useApiMutation<{ changed: true }, { currentPassword?: string; newPassword: string }>({
    path: "/auth/change-password",
    invalidate: [SESSIONS_KEY],
    errorToast: false,
    onSuccess: async () => {
      setCurrent("");
      setNext("");
      setConfirm("");
      await invalidate(ME_KEY);
      toast.success(setting ? "Password set" : "Password changed", { description: "Every other session was signed out." });
    },
  });
  const fields = change.error?.fields ?? {};
  const mismatch = confirm.length > 0 && confirm !== next ? "The two passwords don't match." : undefined;

  function submit(e: FormEvent) {
    e.preventDefault();
    if (mismatch) return;
    change.mutate(setting ? { newPassword: next } : { currentPassword: current, newPassword: next });
  }

  return (
    <Card>
      <CardHeader
        icon={<KeyRound />}
        title="Password"
        description={
          setting
            ? user.googleLinked
              ? "You sign in with Google. Add a password to also sign in with your email."
              : "This account has no password yet."
            : user.googleLinked
              ? "You can also sign in with Google."
              : undefined
        }
      />
      <form onSubmit={submit} noValidate>
        <CardBody className="grid gap-4 sm:grid-cols-2">
          <FormError className="sm:col-span-2" error={change.error && !Object.keys(fields).length ? change.error.message : null} />
          {!setting && (
            <Field label="Current password" error={fields.currentPassword} className="sm:col-span-2 sm:max-w-[calc(50%-0.5rem)]">
              <Input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
            </Field>
          )}
          <Field label="New password" error={fields.newPassword} hint="10+ characters, mixing three of: lower-case, upper-case, numbers, symbols.">
            <Input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
          </Field>
          <Field label="Confirm new password" error={mismatch}>
            <Input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          </Field>
        </CardBody>
        <CardFooter className="justify-between">
          <span className="text-xs text-text-3">{setting ? "Setting it signs out your other sessions." : "Changing it signs out your other sessions."}</span>
          <Button type="submit" variant="primary" loading={change.isPending} disabled={(!setting && !current) || !next || !confirm || Boolean(mismatch)}>
            {setting ? "Set password" : "Change password"}
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}

function SessionsCard() {
  const f = useFormat();
  const sessions = useApiQuery<SessionRow[]>(SESSIONS_KEY, "/auth/sessions");
  const [confirmOthers, setConfirmOthers] = useState(false);
  const revoke = useApiMutation<unknown, SessionRow>({
    method: "DELETE",
    path: (s) => `/auth/sessions/${s.id}`,
    invalidate: [SESSIONS_KEY],
    success: (_, s) => `Signed out ${describeUserAgent(s.userAgent)}`,
  });
  const revokeOthers = useApiMutation({
    path: "/auth/sessions/revoke-others",
    invalidate: [SESSIONS_KEY],
    success: "Signed out of every other session",
    errorToast: false,
  });
  const others = sessions.data?.filter((s) => !s.current).length ?? 0;

  return (
    <Card>
      <CardHeader
        icon={<MonitorSmartphone />}
        title="Where you're signed in"
        description="Sign out anywhere you don't recognise, then change your password."
        actions={
          others > 0 ? (
            <Button size="sm" icon={<LogOut />} onClick={() => setConfirmOthers(true)}>
              Sign out other sessions
            </Button>
          ) : undefined
        }
      />
      <QueryState query={sessions} loading={<SkeletonText lines={3} className="p-4" />}>
        {(rows) => (
          <ul className="divide-y divide-line">
            {rows.map((s) => (
              <li key={s.id} className="flex items-center gap-3 px-4 py-3">
                <span aria-hidden className="flex size-8 shrink-0 items-center justify-center rounded-md border border-line bg-s-2 text-text-3 [&_svg]:size-4">
                  {isMobileAgent(s.userAgent) ? <Smartphone /> : <Monitor />}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-sm font-medium text-text" title={s.userAgent}>
                      {describeUserAgent(s.userAgent)}
                    </span>
                    {s.current && <Badge tone="ok">This browser</Badge>}
                  </div>
                  <div className="truncate text-xs text-text-3">
                    {[s.ip || null, `Signed in ${f.date(s.createdAt)}`, `Last active ${f.relative(s.lastSeenAt)}`].filter(Boolean).join(" · ")}
                  </div>
                </div>
                {!s.current && (
                  <IconButton
                    label={`Sign out ${describeUserAgent(s.userAgent)}`}
                    icon={<X />}
                    disabled={revoke.isPending && revoke.variables?.id === s.id}
                    onClick={() => revoke.mutate(s)}
                  />
                )}
              </li>
            ))}
          </ul>
        )}
      </QueryState>
      <ConfirmDialog
        open={confirmOthers}
        onOpenChange={setConfirmOthers}
        title="Sign out every other session?"
        description={`${others} other ${others === 1 ? "session" : "sessions"} will need to sign in again. This browser stays signed in.`}
        confirmLabel="Sign out others"
        onConfirm={() => revokeOthers.mutateAsync()}
      />
    </Card>
  );
}

function WorkspacesCard({ me }: { me: Me }) {
  if (!me.workspaces.length) return null;
  return (
    <Card>
      <CardHeader icon={<LayoutGrid />} title="Your workspaces" />
      <ul className="divide-y divide-line">
        {me.workspaces.map((w) => (
          <li key={w.id}>
            <Link href={`/w/${w.id}`} className="flex items-center justify-between gap-3 px-4 py-2.5 hover:bg-hover">
              <span className="flex min-w-0 items-center gap-2.5">
                <span aria-hidden className="flex size-6 shrink-0 items-center justify-center rounded-sm bg-solid text-2xs font-semibold text-on-solid">
                  {w.name.charAt(0).toUpperCase()}
                </span>
                <span className="truncate text-sm text-text">{w.name}</span>
                {w.id === me.lastWorkspaceId && <span className="shrink-0 text-xs text-text-3">Last opened</span>}
              </span>
              <span className="flex shrink-0 items-center gap-2">
                {w.status === "suspended" && <Badge tone="bad">Suspended</Badge>}
                <Badge quiet>{labelOf(w.role)}</Badge>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  );
}

/** /account — the signed-in person's own profile, password, two-factor, sessions and appearance. */
export function AccountSettings() {
  const me = useMe();
  if (me.isPending) return <LoadingBlock className="min-h-[50vh]" label="Loading your account…" />;
  if (me.isError) {
    return (
      <Page width="narrow">
        <ErrorState error={me.error} onRetry={() => void me.refetch()} />
      </Page>
    );
  }
  const user = me.data.user;
  return (
    <Page width="narrow">
      <PageHeader icon={<EntityTile of="account" />} title="Account" description={`Signed in as ${user.email}. These settings are yours and follow you into every workspace.`} />
      <div className="flex flex-col gap-5">
        {/* Keyed so a refetched profile resets the form to what was saved. */}
        <ProfileCard key={`${user.name}|${user.timezone}`} user={user} />
        <PasswordCard user={user} />
        <TwoFactorCard user={user} />
        <SessionsCard />
        <ProductEmailsCard />
        <Card>
          <CardHeader icon={<Palette />} title="Appearance" description="Just for you, on this browser. Applies right away." />
          <CardBody>
            <ThemePicker />
          </CardBody>
        </Card>
        <WorkspacesCard me={me.data} />
      </div>
    </Page>
  );
}
