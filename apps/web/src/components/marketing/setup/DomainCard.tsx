"use client";

import { useState, type ReactNode } from "react";
import { Check, CircleDashed, Ellipsis, Globe, Pencil, Play, RefreshCw, Trash2, TriangleAlert, X } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button, IconButton } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Card, CardHeader } from "@/components/ui/Card";
import { ConfirmDialog } from "@/components/ui/Dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/DropdownMenu";
import { toast } from "@/components/ui/Toast";
import { CopyValue } from "@/components/integrations/Copy";
import { DomainStatusBadge, useMarketing } from "@/components/marketing/common";
import { useApiMutation } from "@/lib/query";
import { useFormat } from "@/lib/session";
import type { DnsRecordCheck, EspConnection, SendingDomain } from "@/lib/types/marketing";
import { SelectorsModal } from "./DomainModals";

type Row = {
  key: string;
  label: string;
  type: string;
  name: string;
  /** null: the value comes from the email service and we can't know it. */
  value: string | null;
  check?: DnsRecordCheck;
  /** Per-row result when one check covers several records (DKIM selectors). */
  ok?: boolean;
  required: boolean;
};

/** "TXT name = value" (how the API words an expectation) → its parts. */
function parseExpected(expected: string | undefined): { name: string; value: string } | null {
  const m = expected?.match(/^\w+\s+(\S+)\s*=\s*(.+)$/);
  return m?.[1] && m[2] ? { name: m[1], value: m[2] } : null;
}

/** Resend's per-record status as a ✓ / ✗ / not-yet. */
const espOk = (status: string) => (status === "verified" ? true : status === "failed" || status === "temporary_failure" ? false : undefined);

function recordsOf(d: SendingDomain, esp: EspConnection | null): Row[] {
  if (d.esp) {
    // Resend's own records (SPF on its send subdomain, DKIM at resend._domainkey), then our DMARC.
    const rows: Row[] = d.esp.records.map((r, i): Row => ({
      key: `esp-${i}`,
      label: r.record || r.type,
      type: r.priority !== null ? `${r.type} · ${r.priority}` : r.type,
      name: r.name,
      value: r.value,
      ok: espOk(r.status),
      required: ["SPF", "DKIM"].includes(r.record.toUpperCase()),
    }));
    rows.push({ key: "dmarc", label: "DMARC", type: d.records.dmarc.type, name: d.records.dmarc.name, value: d.records.dmarc.value, check: d.checks.dmarc, required: true });
    return rows;
  }
  const ses = esp?.provider === "ses";
  const dkim = d.checks.dkim;
  const rows: Row[] = [
    { key: "ownership", label: "Ownership", type: d.records.ownership.type, name: d.records.ownership.name, value: d.records.ownership.value, check: d.checks.ownership, required: true },
    ...d.dkimSelectors.map((sel): Row => {
      const name = `${sel}._domainkey.${d.domain}`;
      // One check covers every selector; `found` names the ones that resolved ("name → target"), which marks
      // the missing one. Without per-name entries (development skip) it is the overall result.
      const perName = dkim?.found.some((x) => x.includes("._domainkey."));
      const ok = dkim ? (perName ? dkim.found.some((x) => x.startsWith(`${name} `)) : dkim.ok) : undefined;
      return { key: `dkim-${sel}`, label: "DKIM", type: "CNAME", name, value: ses ? `${sel}.dkim.amazonses.com` : null, check: dkim, ok, required: true };
    }),
    { key: "dmarc", label: "DMARC", type: d.records.dmarc.type, name: d.records.dmarc.name, value: d.records.dmarc.value, check: d.checks.dmarc, required: true },
  ];
  // SPF is advice (DKIM carries DMARC alignment); the API words what to publish once the domain has been checked.
  const spf = parseExpected(d.checks.spf?.expected);
  if (spf) rows.push({ key: "spf", label: "SPF", type: "TXT", name: spf.name, value: spf.value, check: d.checks.spf, required: false });
  return rows;
}

/** ✓ / ✗ for one record; a dashed circle before the first check. */
function CheckMark({ row }: { row: Row }) {
  const ok = row.ok ?? row.check?.ok;
  if (ok === undefined)
    return (
      <span title="Not checked yet" className="flex text-text-3">
        <CircleDashed aria-label="Not checked yet" className="size-4" />
      </span>
    );
  if (ok)
    return (
      <span title="Found" className="flex text-ok-ink">
        <Check aria-label="Found" className="size-4" strokeWidth={2.5} />
      </span>
    );
  return row.required ? (
    <span title="Missing" className="flex text-bad-ink">
      <X aria-label="Missing" className="size-4" strokeWidth={2.5} />
    </span>
  ) : (
    <span title="Not found (recommended)" className="flex text-warn-ink">
      <TriangleAlert aria-label="Not found" className="size-4" />
    </span>
  );
}

function RecordRow({ row }: { row: Row }) {
  const ok = row.ok ?? row.check?.ok;
  const found = ok === false ? (row.check?.found ?? []) : [];
  return (
    <li className="grid gap-2 px-4 py-3 sm:grid-cols-[9.5rem_minmax(0,1fr)_minmax(0,1.15fr)] sm:items-start sm:gap-3">
      <div className="flex items-center gap-2 sm:pt-1">
        <CheckMark row={row} />
        <span className="text-sm font-medium text-text-hi">{row.label}</span>
        <Badge quiet>{row.type}</Badge>
        {!row.required && <span className="text-2xs text-text-3">Optional</span>}
      </div>
      <div className="min-w-0">
        <div className="mb-1 text-2xs font-medium text-text-3 uppercase sm:hidden">Host / name</div>
        <CopyValue value={row.name} label="Copy host" copied="Host copied" />
      </div>
      <div className="min-w-0">
        <div className="mb-1 text-2xs font-medium text-text-3 uppercase sm:hidden">Value</div>
        {row.value ? (
          <CopyValue value={row.value} label="Copy value" copied="Value copied" />
        ) : (
          <p className="rounded-sm border border-dashed border-line px-2.5 py-1.5 text-xs text-text-3">The target your email service gives you for this selector.</p>
        )}
        {found.length > 0 && (
          <p className="mt-1.5 text-xs break-all text-text-3">
            Published now: <span className="font-mono text-text-2">{found.join(" · ")}</span>
          </p>
        )}
      </div>
    </li>
  );
}

/**
 * One sending domain: status, the DNS records to publish with a ✓/✗ from the
 * last check, and verify / resume / edit selectors / delete.
 */
export function DomainCard({ domain: d, esp, canManage }: { domain: SendingDomain; esp: EspConnection | null; canManage: boolean }) {
  const mk = useMarketing();
  const f = useFormat();
  const [editing, setEditing] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const paused = Boolean(d.pausedAt);

  const verify = useApiMutation<SendingDomain, void>({
    path: mk.path(`/domains/${d.id}/verify`),
    invalidate: [mk.key("setup")],
    onSuccess: (r) => {
      if (r.status === "verified") toast.success(`${r.domain} is verified`);
      else toast.warn("Some records are still missing", { description: "DNS changes can take a while to spread. Try again in a few minutes." });
    },
  });
  const resume = useApiMutation<SendingDomain, void>({
    method: "PATCH",
    path: mk.path(`/domains/${d.id}`),
    body: () => ({ paused: false }),
    invalidate: [mk.key("setup")],
    success: `Sending from ${d.domain} resumed`,
  });
  const remove = useApiMutation<{ removed: boolean }, void>({
    method: "DELETE",
    path: mk.path(`/domains/${d.id}`),
    invalidate: [mk.key("setup")],
    success: `${d.domain} removed`,
    errorToast: false,
  });

  const rows = recordsOf(d, esp);
  const when: ReactNode = d.verifiedAt
    ? `Verified ${f.date(d.verifiedAt)}`
    : d.lastCheckedAt
      ? `Last checked ${f.relative(d.lastCheckedAt)}`
      : "Not checked yet. Publish the records below, then verify.";

  return (
    <Card>
      <CardHeader
        icon={<Globe />}
        title={
          <span className="flex flex-wrap items-center gap-2">
            <span className="break-all">{d.domain}</span>
            <DomainStatusBadge status={d.status} paused={paused} />
          </span>
        }
        description={
          <>
            {when}
            {d.verifiedAt && d.lastCheckedAt && ` · checked ${f.relative(d.lastCheckedAt)}`}
          </>
        }
        actions={
          canManage && (
            <>
              <Button size="sm" icon={<RefreshCw />} loading={verify.isPending} onClick={() => verify.mutate()}>
                Verify
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <IconButton size="sm" label="Domain actions" icon={<Ellipsis />} />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {!d.esp && (
                    <>
                      <DropdownMenuItem icon={<Pencil />} onSelect={() => setEditing(true)}>
                        Edit DKIM selectors
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                    </>
                  )}
                  <DropdownMenuItem danger icon={<Trash2 />} onSelect={() => setConfirm(true)}>
                    Delete domain
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </>
          )
        }
      />

      {(paused || d.status === "failed") && (
        <div className="border-b border-line p-4">
          {paused ? (
            <Callout
              tone="warn"
              title="Sending from this domain is paused"
              action={
                canManage && (
                  <Button size="sm" icon={<Play />} loading={resume.isPending} onClick={() => resume.mutate()}>
                    Resume
                  </Button>
                )
              }
            >
              {d.pausedReason || "Campaigns from this domain wait until it is resumed."}
            </Callout>
          ) : (
            <Callout tone="bad" title="This domain stopped passing its checks">
              Campaigns can&apos;t send from it until the records below are back and it verifies again.
            </Callout>
          )}
        </div>
      )}

      <div className="hidden grid-cols-[9.5rem_minmax(0,1fr)_minmax(0,1.15fr)] gap-3 border-b border-line bg-well px-4 py-2 text-2xs font-medium tracking-wide text-text-3 uppercase sm:grid">
        <span>Record</span>
        <span>Host / name</span>
        <span>Value</span>
      </div>
      <ul className="divide-y divide-line">
        {rows.map((r) => (
          <RecordRow key={r.key} row={r} />
        ))}
        {!d.esp && d.dkimSelectors.length === 0 && (
          <li className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
            <span className="flex items-center gap-2">
              <span className="flex text-bad-ink">
                <X aria-label="Missing" className="size-4" strokeWidth={2.5} />
              </span>
              <span className="text-sm font-medium text-text-hi">DKIM</span>
            </span>
            <span className="min-w-0 flex-1 text-xs text-text-3">Add the DKIM selectors your email service gave you, so we know which records to look for.</span>
            {canManage && (
              <Button size="sm" icon={<Pencil />} onClick={() => setEditing(true)}>
                Add selectors
              </Button>
            )}
          </li>
        )}
      </ul>
      <p className="rounded-b-xl border-t border-line px-4 py-2.5 text-xs text-text-3">
        {d.esp
          ? `Resend checks its own records; DMARC is required too. Names are relative to your DNS zone — most DNS panels add the domain themselves. Resend status: ${d.esp.status || "not checked"}.`
          : "Ownership, DKIM and DMARC are required. DNS changes can take a while to spread, so verify again after publishing a record."}
      </p>

      {canManage && <SelectorsModal open={editing} onOpenChange={setEditing} domain={d} />}
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={`Delete ${d.domain}?`}
        description="Campaigns can no longer send from it. You can add it again later; it will need verifying again."
        onConfirm={() => remove.mutateAsync()}
      />
    </Card>
  );
}
