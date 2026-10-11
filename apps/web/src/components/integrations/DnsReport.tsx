"use client";

import { ExternalLink, Globe, RefreshCw } from "lucide-react";
import { Badge, type Tone } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { ErrorState } from "@/components/ui/ErrorState";
import { SkeletonText } from "@/components/ui/Skeleton";
import { useApiQuery } from "@/lib/query";
import { useWorkspace } from "@/lib/session";
import type { DnsState, DomainAuth, DomainRecord } from "@/lib/types/integrations";
import { CopyValue } from "./Copy";

const STATE: Record<DnsState, { tone: Tone; label: string }> = {
  ok: { tone: "ok", label: "Pass" },
  warn: { tone: "warn", label: "Needs attention" },
  fail: { tone: "bad", label: "Fail" },
};

function RecordRow({ record }: { record: DomainRecord }) {
  const s = STATE[record.state];
  return (
    <li className="flex flex-col gap-2 px-4 py-3.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="w-14 shrink-0 text-xs font-semibold tracking-wide text-text-hi uppercase">{record.label}</span>
        <Badge tone={s.tone} dot>
          {s.label}
        </Badge>
        <span className="min-w-0 text-sm font-medium text-text">{record.title}</span>
      </div>
      <p className="text-xs text-text-2">{record.detail}</p>
      {record.found && (
        <div>
          <div className="mb-1 text-2xs font-medium text-text-3 uppercase">Published now</div>
          <code className="block rounded-sm bg-well px-2.5 py-1.5 font-mono text-xs break-all text-text-2">{record.found}</code>
        </div>
      )}
      {record.fix && (
        <div className="flex flex-col gap-2 rounded-md border border-line p-3">
          <div className="text-2xs font-medium text-text-3 uppercase">Add this record</div>
          <div className="grid gap-2 sm:grid-cols-[80px_1fr]">
            <span className="text-xs text-text-3">Type</span>
            <code className="font-mono text-xs text-text">{record.fix.type}</code>
            <span className="text-xs text-text-3 sm:pt-1.5">Host / name</span>
            <CopyValue value={record.fix.host} label="Copy host" copied="Host copied" />
            {record.fix.value !== undefined && (
              <>
                <span className="text-xs text-text-3 sm:pt-1.5">Value</span>
                <CopyValue value={record.fix.value} label="Copy value" copied="Value copied" />
              </>
            )}
          </div>
          {record.fix.note && <p className="text-xs text-text-2">{record.fix.note}</p>}
          {record.fix.href && (
            <a href={record.fix.href} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 self-start text-xs font-medium text-accent-hi hover:text-accent">
              {record.fix.hrefLabel ?? "Open the provider's instructions"}
              <ExternalLink aria-hidden className="size-3" />
            </a>
          )}
        </div>
      )}
    </li>
  );
}

/**
 * SPF, DKIM, DMARC and MX for the mailbox's domain, read live from DNS by the
 * API, each with what is published today and the exact record to add when
 * something is missing.
 */
export function DnsReport({ mailboxId }: { mailboxId: string }) {
  const ws = useWorkspace();
  const dns = useApiQuery<DomainAuth>(ws.key("mailboxes", mailboxId, "dns"), ws.path(`/mailboxes/${mailboxId}/dns`), { staleTime: 5 * 60_000 });
  const d = dns.data;

  return (
    <Card>
      <CardHeader
        icon={<Globe />}
        title="Domain authentication"
        description={d?.domain ? `DNS records for ${d.domain}${d.provider ? ` · sending through ${d.provider}` : ""}` : "SPF, DKIM, DMARC and MX, checked live."}
        actions={
          <Button size="sm" icon={<RefreshCw />} loading={dns.isFetching} onClick={() => void dns.refetch()}>
            Check again
          </Button>
        }
      />
      {dns.isPending ? (
        <CardBody>
          <SkeletonText lines={4} />
        </CardBody>
      ) : dns.isError && !d ? (
        <ErrorState compact error={dns.error} onRetry={() => void dns.refetch()} />
      ) : d ? (
        <>
          <CardBody className="border-b border-line">
            <Callout
              tone={d.state === "ok" ? "ok" : d.state === "warn" ? "warn" : "bad"}
              title={d.total ? `${d.done} of ${d.total} in order` : "Nothing to check"}
            >
              {d.detail}
            </Callout>
          </CardBody>
          {d.records.length > 0 && (
            <ul className="divide-y divide-line">
              {d.records.map((r) => (
                <RecordRow key={r.id} record={r} />
              ))}
            </ul>
          )}
          <p className="px-4 py-3 text-xs text-text-3">DNS changes can take a while to spread. Check again after publishing a record.</p>
        </>
      ) : null}
    </Card>
  );
}
