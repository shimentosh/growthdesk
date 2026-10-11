"use client";

import { useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { CircleAlert, CircleCheck, FolderSync, PlugZap, Send, Server, ShieldCheck, Trash2 } from "lucide-react";
import { Badge, StatusBadge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { QueryState } from "@/components/ui/ErrorState";
import { ChannelTile } from "@/components/ui/icons";
import { KeyValueList } from "@/components/ui/KeyValue";
import { Meter } from "@/components/ui/Meter";
import { PageHeader } from "@/components/ui/PageHeader";
import { RequirePermission } from "@/components/ui/RequirePermission";
import { SkeletonText } from "@/components/ui/Skeleton";
import { DnsReport } from "@/components/integrations/DnsReport";
import { DeleteMailboxDialog, useMailboxMutations } from "@/components/integrations/MailboxActions";
import { MailboxSettingsCard } from "@/components/integrations/MailboxSettingsCard";
import { TestSendModal } from "@/components/integrations/TestSendModal";
import { useOAuthStart } from "@/components/integrations/MailboxConnect";
import { useApiQuery } from "@/lib/query";
import { useFormat, useWorkspace } from "@/lib/session";
import { MAILBOX_PROVIDER_LABELS, type Mailbox, type MailboxCheck, type MailboxVerifyResult } from "@/lib/types/integrations";

const SECURITY_LABEL: Record<string, string> = { ssl: "SSL / TLS", starttls: "STARTTLS", none: "unencrypted" };

function CheckLine({ label, check }: { label: string; check: MailboxCheck }) {
  return (
    <div className="flex items-start gap-2 text-sm">
      {check.ok ? <CircleCheck aria-hidden className="mt-0.5 size-4 shrink-0 text-ok-ink" /> : <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-bad-ink" />}
      <div className="min-w-0">
        <span className="font-medium text-text">{label}</span> <span className="text-text-2">{check.ok ? "accepted the sign-in" : "refused"}</span>
        {!check.ok && check.error && <div className="text-xs break-words text-bad-ink">{check.error}</div>}
      </div>
    </div>
  );
}

function MailboxDetail({ box }: { box: Mailbox }) {
  const ws = useWorkspace();
  const f = useFormat();
  const router = useRouter();
  const [checks, setChecks] = useState<MailboxVerifyResult["checks"] | null>(null);
  const [test, setTest] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const { verify, sync, remove } = useMailboxMutations(box, {
    onVerified: (r) => setChecks(r.checks),
    onDeleted: () => router.replace(ws.href("/settings/mailboxes")),
  });
  const oauth = useOAuthStart();
  const manage = ws.can("integrations.manage");
  const canSync = box.imapEnabled && ws.can(["integrations.manage", "inbox.read"]);
  const oauthProvider = box.provider === "gmail" || box.provider === "microsoft" ? box.provider : null;

  return (
    <>
      <PageHeader
        back={{ href: ws.href("/settings/mailboxes"), label: "Mailboxes" }}
        icon={<ChannelTile channel="email" size="lg" />}
        title={<span className="break-all">{box.email}</span>}
        meta={
          <>
            <StatusBadge value={box.status} />
            <Badge quiet>{MAILBOX_PROVIDER_LABELS[box.provider] ?? box.provider}</Badge>
          </>
        }
        description={box.displayName ? `Sends as “${box.displayName}”` : undefined}
        actions={
          <>
            {manage && (
              <Button icon={<ShieldCheck />} loading={verify.isPending} onClick={() => verify.mutate()}>
                Verify
              </Button>
            )}
            {manage && (
              <Button icon={<Send />} onClick={() => setTest(true)}>
                Send test
              </Button>
            )}
            {canSync && (
              <Button icon={<FolderSync />} loading={sync.isPending} onClick={() => sync.mutate()}>
                Sync now
              </Button>
            )}
          </>
        }
      />

      <div className="flex flex-col gap-5">
        {box.status !== "connected" && (
          <Callout
            tone="bad"
            title={box.status === "error" ? "This mailbox cannot sign in" : "This mailbox is disconnected"}
            action={
              manage && oauthProvider ? (
                <Button size="sm" icon={<PlugZap />} loading={oauth.pending !== null} onClick={() => void oauth.start(oauthProvider)}>
                  Reconnect
                </Button>
              ) : undefined
            }
          >
            {box.lastError || "Nothing is sent from it until it is fixed."}
            {box.provider === "smtp" && manage && " If the password changed, set the new one under Sending settings."}
          </Callout>
        )}

        {checks && (
          <Card>
            <CardHeader icon={<ShieldCheck />} title="Last verification" description="What each server answered just now." />
            <CardBody className="flex flex-col gap-2">
              <CheckLine label="SMTP" check={checks.smtp} />
              {checks.imap ? <CheckLine label="IMAP" check={checks.imap} /> : <p className="text-xs text-text-3">IMAP is off for this mailbox, so only SMTP was checked.</p>}
            </CardBody>
          </Card>
        )}

        <Card>
          <CardHeader icon={<Server />} title="Connection" />
          <CardBody className="flex flex-col gap-4">
            <Meter label="Sent today" value={box.sentToday} max={box.dailyLimit} />
            <KeyValueList
              columns={2}
              items={[
                { label: "Sending server", value: <span className="font-mono text-xs">{`${box.smtpHost}:${box.smtpPort}`}</span>, hint: SECURITY_LABEL[box.smtpSecurity] ?? box.smtpSecurity },
                { label: "SMTP username", value: box.smtpUser ? <span className="font-mono text-xs break-all">{box.smtpUser}</span> : null },
                {
                  label: "Reply tracking",
                  value: box.imapEnabled ? <span className="font-mono text-xs">{`${box.imapHost}:${box.imapPort}`}</span> : "Off",
                  hint: box.imapEnabled ? (SECURITY_LABEL[box.imapSecurity] ?? box.imapSecurity) : undefined,
                },
                { label: "IMAP username", value: box.imapEnabled && box.imapUser ? <span className="font-mono text-xs break-all">{box.imapUser}</span> : null },
                { label: "Last verified", value: box.lastCheckedAt ? f.dateTime(box.lastCheckedAt) : "Never" },
                {
                  label: "Replies last synced",
                  value: box.imapEnabled ? (box.lastSyncedAt ? f.dateTime(box.lastSyncedAt) : "Not yet") : null,
                  hint: box.syncError ? <span className="text-bad-ink">{box.syncError}</span> : undefined,
                },
                { label: "Minimum gap", value: `${box.minDelaySeconds} seconds between sends` },
                { label: "Connected", value: f.date(box.createdAt) },
              ]}
            />
          </CardBody>
        </Card>

        <MailboxSettingsCard mailbox={box} canManage={manage} />

        <DnsReport mailboxId={box.id} />

        {manage && (
          <Card>
            <CardHeader
              icon={<Trash2 />}
              title="Remove mailbox"
              description="Wipes the stored credentials. Nothing more is sent from or read from this address."
              actions={
                <Button variant="danger" icon={<Trash2 />} onClick={() => setConfirm(true)}>
                  Remove
                </Button>
              }
            />
          </Card>
        )}
      </div>

      {manage && <TestSendModal mailbox={box} open={test} onOpenChange={setTest} />}
      <DeleteMailboxDialog box={box} open={confirm} onOpenChange={setConfirm} onConfirm={() => remove.mutateAsync()} />
    </>
  );
}

export default function MailboxDetailPage() {
  const ws = useWorkspace();
  const { mailboxId } = useParams<{ mailboxId: string }>();
  const box = useApiQuery<Mailbox>(ws.key("mailboxes", mailboxId), ws.path(`/mailboxes/${mailboxId}`));
  return (
    <RequirePermission permission="integrations.read">
      <QueryState
        query={box}
        loading={
          <Card className="p-4">
            <SkeletonText lines={5} />
          </Card>
        }
      >
        {(b) => <MailboxDetail box={b} />}
      </QueryState>
    </RequirePermission>
  );
}
