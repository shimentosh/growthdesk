"use client";

import { useState, type FormEvent } from "react";
import { KeyRound, ShieldCheck, ShieldOff } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Card, CardBody, CardFooter, CardHeader } from "@/components/ui/Card";
import { ConfirmDialog } from "@/components/ui/Dialog";
import { QueryState } from "@/components/ui/ErrorState";
import { Field, FormError } from "@/components/ui/Field";
import { EntityTile } from "@/components/ui/icons";
import { NativeSelect, Textarea } from "@/components/ui/Input";
import { KeyValueList } from "@/components/ui/KeyValue";
import { PageHeader } from "@/components/ui/PageHeader";
import { RequirePermission } from "@/components/ui/RequirePermission";
import { SkeletonText } from "@/components/ui/Skeleton";
import { useApiMutation, useApiQuery } from "@/lib/query";
import { useFormat, useWorkspace } from "@/lib/session";
import type { SupportGrant } from "@/lib/types/admin";

/** The API accepts 1–168 hours. */
const DURATIONS = [
  { value: "1", label: "1 hour" },
  { value: "4", label: "4 hours" },
  { value: "24", label: "24 hours" },
  { value: "72", label: "3 days" },
  { value: "168", label: "7 days" },
];

function ActiveGrant({ grant }: { grant: SupportGrant }) {
  const ws = useWorkspace();
  const f = useFormat();
  const [confirm, setConfirm] = useState(false);
  const revoke = useApiMutation({
    method: "DELETE",
    path: ws.path("/support-access"),
    invalidate: [ws.key("support-access"), ws.key("audit")],
    success: "Support access revoked",
    errorToast: false,
  });
  return (
    <Card>
      <CardHeader icon={<ShieldCheck />} title="Access granted" description={`Ends ${f.relative(grant.expiresAt)}, unless you revoke it sooner.`} />
      <CardBody className="flex flex-col gap-4">
        <Callout tone="ok" title="Support access is on">
          Growthdesk support is allowed to look into this workspace until {f.dateTime(grant.expiresAt)}.
        </Callout>
        <KeyValueList
          items={[
            { label: "Granted", value: f.dateTime(grant.createdAt) },
            { label: "Expires", value: f.dateTime(grant.expiresAt) },
            { label: "Reason", value: <span className="whitespace-pre-line">{grant.reason}</span> },
          ]}
        />
      </CardBody>
      <CardFooter>
        <Button variant="danger" icon={<ShieldOff />} onClick={() => setConfirm(true)}>
          Revoke access
        </Button>
      </CardFooter>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title="Revoke support access?"
        description="The grant ends now. You can grant access again at any time."
        confirmLabel="Revoke"
        onConfirm={() => revoke.mutateAsync()}
      />
    </Card>
  );
}

function GrantForm() {
  const ws = useWorkspace();
  const isOwner = ws.role === "owner";
  const [hours, setHours] = useState("24");
  const [reason, setReason] = useState("");
  const grant = useApiMutation<SupportGrant, { hours: number; reason: string }>({
    path: ws.path("/support-access"),
    invalidate: [ws.key("support-access"), ws.key("audit")],
    success: "Support access granted",
    errorToast: false,
  });
  const fields = grant.error?.fields ?? {};

  function submit(e: FormEvent) {
    e.preventDefault();
    grant.mutate({ hours: Number(hours), reason: reason.trim() });
  }

  return (
    <Card>
      <CardHeader icon={<KeyRound />} title="Grant access" description="No access is granted right now." />
      <form onSubmit={submit} noValidate>
        <CardBody className="flex flex-col gap-4">
          {!isOwner && <Callout tone="info">Only the workspace owner can grant support access.</Callout>}
          <FormError error={grant.error && !Object.keys(fields).length ? grant.error.message : null} />
          <Field label="For how long" error={fields.hours}>
            <NativeSelect value={hours} onChange={(e) => setHours(e.target.value)} options={DURATIONS} disabled={!isOwner} className="sm:max-w-48" />
          </Field>
          <Field label="Reason" error={fields.reason} hint="What should support look into? Recorded with the grant.">
            <Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} disabled={!isOwner} placeholder="e.g. Replies from one mailbox stopped showing in the inbox." />
          </Field>
        </CardBody>
        <CardFooter>
          <Button type="submit" variant="primary" icon={<ShieldCheck />} loading={grant.isPending} disabled={!isOwner || !reason.trim()}>
            Grant access
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}

/** Settings → Support access: a time-limited, revocable permission for Growthdesk support. */
export function SupportAccessSettings() {
  const ws = useWorkspace();
  const current = useApiQuery<SupportGrant | null>(ws.key("support-access"), ws.path("/support-access"));
  return (
    <RequirePermission permission="settings.manage">
      <PageHeader
        icon={<EntityTile of="supportAccess" />}
        title="Support access"
        description="Let the Growthdesk support team look into this workspace for a limited time. Granting and revoking are recorded in the audit log."
      />
      <QueryState query={current} loading={<SkeletonText lines={4} />}>
        {(grant) => (grant ? <ActiveGrant grant={grant} /> : <GrantForm />)}
      </QueryState>
    </RequirePermission>
  );
}
