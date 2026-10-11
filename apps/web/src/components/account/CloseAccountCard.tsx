"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { Download, FileJson, UserX } from "lucide-react";
import { Button, buttonClass } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Card, CardBody, CardFooter, CardHeader } from "@/components/ui/Card";
import { Modal } from "@/components/ui/Dialog";
import { QueryState } from "@/components/ui/ErrorState";
import { Field, FormError } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { SkeletonText } from "@/components/ui/Skeleton";
import { useApiMutation, useApiQuery } from "@/lib/query";
import type { Me } from "@/lib/types";

/** GET /account — apps/api/src/lifecycle/account.service.ts `summary()` */
type AccountSummary = {
  terms: { acceptedAt: string | null; version: string | null; currentVersion: string };
  close: {
    allowed: boolean;
    staff: boolean;
    needsPassword: boolean;
    blockers: { workspaceId: string; name: string; reason: "owner" | "billing" }[];
  };
};

function CloseDialog({ user, needsPassword, open, onOpenChange }: { user: Me["user"]; needsPassword: boolean; open: boolean; onOpenChange: (v: boolean) => void }) {
  const [confirmEmail, setConfirmEmail] = useState("");
  const [password, setPassword] = useState("");
  const close = useApiMutation<{ closed: boolean }, { confirmEmail: string; password?: string }>({
    path: "/account/close",
    errorToast: false,
    // The session is gone; the sign-in page is the only place left to go.
    onSuccess: () => window.location.assign("/login"),
  });
  const fields = close.error?.fields ?? {};
  const submit = (e: FormEvent) => {
    e.preventDefault();
    close.mutate({ confirmEmail: confirmEmail.trim().toLowerCase(), ...(needsPassword ? { password } : {}) });
  };
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      dismissOnOutside={false}
      title="Close your account?"
      description="This cannot be undone."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="danger" type="submit" form="close-account" loading={close.isPending} disabled={!confirmEmail.trim() || (needsPassword && !password)}>
            Close account
          </Button>
        </>
      }
    >
      <form id="close-account" onSubmit={submit} className="flex flex-col gap-3" noValidate>
        <FormError error={close.error && !Object.keys(fields).length ? close.error.message : null} />
        <Field label={`Type ${user.email} to confirm`} error={fields.confirmEmail}>
          <Input type="email" autoComplete="off" value={confirmEmail} onChange={(e) => setConfirmEmail(e.target.value)} autoFocus />
        </Field>
        {needsPassword && (
          <Field label="Password" error={fields.password}>
            <Input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
        )}
      </form>
    </Modal>
  );
}

/** Account → Your data: a JSON copy of what the platform holds about the person (GET /account/export). */
export function MyDataCard() {
  return (
    <Card>
      <CardHeader
        icon={<FileJson />}
        title="Your data"
        description="Your profile, sign-up and consent details, workspace memberships, sign-in sessions and recent account activity, as a JSON file. Records inside a workspace are exported from that workspace's Settings → Data & privacy."
      />
      <CardFooter>
        <a href="/api/account/export" download className={buttonClass()}>
          <Download aria-hidden />
          Download my data
        </a>
      </CardFooter>
    </Card>
  );
}

/** Account → Close account: refused while the person owns a workspace (transfer or delete it first). */
export function CloseAccountCard({ user }: { user: Me["user"] }) {
  const summary = useApiQuery<AccountSummary>(["account", "summary"], "/account");
  const [open, setOpen] = useState(false);
  return (
    <Card className="border-bad/40">
      <CardHeader icon={<UserX />} title="Close account" description="Erase your name, email address and sign-in details, and leave every workspace." />
      <CardBody className="flex flex-col gap-3">
        <QueryState query={summary} loading={<SkeletonText lines={2} />}>
          {(s) =>
            s.close.staff ? (
              <Callout tone="info">Platform staff accounts can&apos;t be closed here. Ask a platform owner to change your platform role first.</Callout>
            ) : s.close.blockers.length ? (
              <Callout tone="warn" title="You own workspaces">
                Transfer ownership to another member, or delete the workspace, from its Settings → Data &amp; privacy first:{" "}
                {s.close.blockers.map((b, i) => (
                  <span key={b.workspaceId}>
                    {i > 0 && ", "}
                    {b.reason === "owner" ? (
                      <Link href={`/w/${b.workspaceId}/settings/data`} className="font-medium hover:underline">
                        {b.name}
                      </Link>
                    ) : (
                      `${b.name} (you pay for it; contact support to move the billing account)`
                    )}
                  </span>
                ))}
                .
              </Callout>
            ) : (
              <p className="text-sm text-text-2">
                Records you created in workspaces (contacts, deals, notes) stay with those workspaces, no longer assigned to you. Your sessions end and the API keys
                you created stop working. We send a confirmation to your current address first.
              </p>
            )
          }
        </QueryState>
      </CardBody>
      <CardFooter>
        <Button variant="danger" icon={<UserX />} disabled={!summary.data?.close.allowed} onClick={() => setOpen(true)}>
          Close account…
        </Button>
      </CardFooter>
      {summary.data && <CloseDialog user={user} needsPassword={summary.data.close.needsPassword} open={open} onOpenChange={setOpen} />}
    </Card>
  );
}
