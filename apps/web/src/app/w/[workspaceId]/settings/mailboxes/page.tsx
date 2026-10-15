"use client";

import Link from "next/link";
import { Suspense, useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { CircleAlert, Inbox, Mail } from "lucide-react";
import { Badge, StatusBadge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { ChannelTile, EntityTile } from "@/components/ui/icons";
import { QueryState } from "@/components/ui/ErrorState";
import { Meter } from "@/components/ui/Meter";
import { PageHeader } from "@/components/ui/PageHeader";
import { RequirePermission } from "@/components/ui/RequirePermission";
import { SkeletonText } from "@/components/ui/Skeleton";
import { toast } from "@/components/ui/Toast";
import { ConnectMailboxMenu } from "@/components/integrations/MailboxConnect";
import { MailboxMenu } from "@/components/integrations/MailboxActions";
import { useApiQuery, useInvalidate } from "@/lib/query";
import { useFormat, useWorkspace, workspaceDetailKey } from "@/lib/session";
import { MAILBOX_PROVIDER_LABELS, type Mailbox } from "@/lib/types/integrations";

/**
 * Where Google / Microsoft send the browser back after "Connect": the API's
 * callback redirects here with ?connected=1&mailbox=<id> or ?error=<message>.
 * Says what happened once, then drops the parameters from the address. A
 * failure stays on the page (until dismissed) so its reason can be read.
 */
function OAuthLanding() {
  const ws = useWorkspace();
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const invalidate = useInvalidate();
  const handled = useRef<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    const connected = params.get("connected");
    const error = params.get("error");
    if (!connected && !error) return;
    const sig = params.toString();
    if (handled.current === sig) return;
    handled.current = sig;
    if (connected) {
      setFailure(null);
      toast.success("Mailbox connected", { description: "We'll start reading replies in a moment." });
      // Campaign launch readiness and the onboarding checklist both check for a connected mailbox.
      void invalidate(ws.key("mailboxes"), ws.key("campaigns"), workspaceDetailKey(ws.id));
    } else if (error) {
      setFailure(error.slice(0, 300));
    }
    router.replace(pathname, { scroll: false });
  }, [params, router, pathname, invalidate, ws]);

  if (!failure) return null;
  return (
    <Callout
      tone="bad"
      title="The mailbox was not connected"
      className="mb-4"
      action={
        <Button size="sm" variant="ghost" onClick={() => setFailure(null)}>
          Dismiss
        </Button>
      }
    >
      {failure}
    </Callout>
  );
}

function MailboxRow({ box }: { box: Mailbox }) {
  const ws = useWorkspace();
  const f = useFormat();
  const router = useRouter();
  const href = ws.href(`/settings/mailboxes/${box.id}`);
  const problem = box.status !== "connected" ? box.lastError : box.imapEnabled && box.syncError ? `Reply sync: ${box.syncError}` : "";

  return (
    <li className="flex flex-col gap-3 px-4 py-3.5 sm:flex-row sm:items-center sm:gap-4">
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <ChannelTile channel="email" size="md" className="mt-0.5" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Link href={href} className="truncate text-sm font-medium text-text-hi hover:underline">
              {box.email}
            </Link>
            <StatusBadge value={box.status} />
            <Badge quiet>{MAILBOX_PROVIDER_LABELS[box.provider] ?? box.provider}</Badge>
          </div>
          <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-text-3">
            {box.displayName && <span>{box.displayName}</span>}
            <span>Checked {box.lastCheckedAt ? f.relative(box.lastCheckedAt) : "never"}</span>
            <span>{box.imapEnabled ? `Replies synced ${box.lastSyncedAt ? f.relative(box.lastSyncedAt) : "not yet"}` : "Reply tracking off"}</span>
          </div>
          {problem && (
            <p className="mt-1.5 flex items-start gap-1.5 text-xs text-bad-ink">
              <CircleAlert aria-hidden className="mt-px size-3.5 shrink-0" />
              <span className="min-w-0 break-words">{problem}</span>
            </p>
          )}
        </div>
      </div>
      <div className="flex items-center gap-3 sm:w-64">
        <Meter className="min-w-0 flex-1" label="Sent today" value={box.sentToday} max={box.dailyLimit} />
        <MailboxMenu box={box} onOpenDetail={() => router.push(href)} />
      </div>
    </li>
  );
}

export default function MailboxesPage() {
  const ws = useWorkspace();
  const mailboxes = useApiQuery<Mailbox[]>(ws.key("mailboxes", "list"), ws.path("/mailboxes"));
  const manage = ws.can("integrations.manage");

  return (
    <RequirePermission permission="integrations.read">
      <PageHeader
        icon={<EntityTile of="mailboxes" />}
        title="Mailboxes"
        description="The addresses campaigns send from. Each one is signed in to for real, sends within its daily limit, and reads replies back when IMAP is on."
        actions={manage && mailboxes.data && mailboxes.data.length > 0 ? <ConnectMailboxMenu /> : undefined}
      />
      <Suspense fallback={null}>
        <OAuthLanding />
      </Suspense>
      <QueryState
        query={mailboxes}
        loading={
          <Card className="p-4">
            <SkeletonText lines={4} />
          </Card>
        }
        isEmpty={(d) => d.length === 0}
        empty={
          <Card>
            <EmptyState
              icon={<Mail />}
              tint="blue"
              title="No mailbox connected yet"
              description={
                manage
                  ? "Connect the address you want outreach to come from. Type it in — we recognise the provider, fill in its servers and show how to get the password it needs."
                  : "Nobody has connected a mailbox yet. Ask a workspace admin to connect one."
              }
              action={manage ? <ConnectMailboxMenu /> : undefined}
            />
          </Card>
        }
      >
        {(rows) => (
          <Card>
            <ul className="divide-y divide-line">
              {rows.map((b) => (
                <MailboxRow key={b.id} box={b} />
              ))}
            </ul>
          </Card>
        )}
      </QueryState>
      {mailboxes.data && mailboxes.data.length > 0 && (
        <p className="mt-3 flex items-center gap-1.5 text-xs text-text-3">
          <Inbox aria-hidden className="size-3.5" />
          Open a mailbox to check its DNS records (SPF, DKIM, DMARC) and change its limits.
        </p>
      )}
    </RequirePermission>
  );
}
