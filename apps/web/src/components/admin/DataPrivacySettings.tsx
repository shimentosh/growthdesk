"use client";

import { useEffect, useMemo, useState } from "react";
import { Download, FileArchive, Trash2, UserRoundCog } from "lucide-react";
import { labelOf } from "@growthdesk/shared";
import { StatusBadge } from "@/components/ui/Badge";
import { Button, buttonClass } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Card, CardBody, CardFooter, CardHeader } from "@/components/ui/Card";
import { ConfirmDialog } from "@/components/ui/Dialog";
import { QueryState } from "@/components/ui/ErrorState";
import { Field } from "@/components/ui/Field";
import { EntityTile } from "@/components/ui/icons";
import { NativeSelect } from "@/components/ui/Input";
import { PageHeader } from "@/components/ui/PageHeader";
import { RequirePermission } from "@/components/ui/RequirePermission";
import { SkeletonText } from "@/components/ui/Skeleton";
import { formatBytes } from "@/lib/format";
import { useApiMutation, useApiQuery } from "@/lib/query";
import { ME_KEY, useFormat, useWorkspace, workspaceDetailKey } from "@/lib/session";
import type { MembersResponse } from "@/lib/types";

/** GET /workspaces/:id/exports — apps/api/src/lifecycle/workspace-export.service.ts `exportDto()` */
type WorkspaceExport = {
  id: string;
  status: "pending" | "processing" | "ready" | "failed" | "expired";
  fileName: string;
  sizeBytes: number;
  counts: Record<string, number>;
  error: string;
  createdAt: string;
  finishedAt: string | null;
  expiresAt: string | null;
};
type ExportsResponse = { items: WorkspaceExport[]; retentionDays: number };

const STATUS_LABEL: Record<WorkspaceExport["status"], string> = {
  pending: "Queued",
  processing: "Preparing",
  ready: "Ready",
  failed: "Failed",
  expired: "Expired",
};

function ExportCard() {
  const ws = useWorkspace();
  const f = useFormat();
  // Polls only while an export is being built.
  const [polling, setPolling] = useState(false);
  const list = useApiQuery<ExportsResponse>(ws.key("exports"), ws.path("/exports"), { refetchInterval: polling ? 3000 : false });
  const request = useApiMutation<WorkspaceExport>({
    path: ws.path("/exports"),
    invalidate: [ws.key("exports")],
    success: "Export requested. You'll get a notification and an email when it's ready.",
  });
  const busy = list.data?.items.some((e) => e.status === "pending" || e.status === "processing") ?? false;
  useEffect(() => setPolling(busy), [busy]);

  return (
    <Card>
      <CardHeader
        icon={<FileArchive />}
        title="Export all data"
        description="One compressed JSON file with the workspace's contacts, companies, deals, pipelines, tasks, notes, activity, calls, conversations and message details (not message bodies), templates, sequences, campaigns, lists and workflows. Mailbox and integration credentials are never included."
      />
      <CardBody className="flex flex-col gap-3">
        <QueryState query={list} loading={<SkeletonText lines={3} />}>
          {(data) =>
            data.items.length ? (
              <ul className="flex flex-col divide-y divide-line rounded-md border border-line">
                {data.items.map((e) => (
                  <li key={e.id} className="flex flex-wrap items-center gap-3 px-3 py-2.5 text-sm">
                    <StatusBadge value={e.status === "processing" || e.status === "pending" ? "running" : e.status === "ready" ? "active" : e.status} label={STATUS_LABEL[e.status]} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-text">{e.fileName || `Requested ${f.relative(e.createdAt)}`}</div>
                      <div className="text-xs text-text-3">
                        {e.status === "ready" && e.expiresAt
                          ? `${formatBytes(e.sizeBytes)} · ${(e.counts.contacts ?? 0).toLocaleString()} contacts · available until ${f.dateTime(e.expiresAt)}`
                          : e.status === "failed"
                            ? e.error || "The export failed."
                            : e.status === "expired"
                              ? "The file was deleted. Request a new export."
                              : `Requested ${f.relative(e.createdAt)}`}
                      </div>
                    </div>
                    {e.status === "ready" && (
                      <a href={`/api${ws.path(`/exports/${e.id}/download`)}`} className={buttonClass({ size: "sm" })} download>
                        <Download aria-hidden />
                        Download
                      </a>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-text-2">No exports yet.</p>
            )
          }
        </QueryState>
        <p className="text-xs text-text-3">
          Exports are prepared in the background. The file can be downloaded by anyone with the export permission for {list.data?.retentionDays ?? 7} days, then
          it is deleted.
        </p>
      </CardBody>
      <CardFooter>
        <Button variant="primary" icon={<FileArchive />} loading={request.isPending} disabled={busy} onClick={() => request.mutate()}>
          {busy ? "Preparing export…" : "Request export"}
        </Button>
      </CardFooter>
    </Card>
  );
}

function TransferCard() {
  const ws = useWorkspace();
  const members = useApiQuery<MembersResponse>(ws.key("members"), ws.path("/members"));
  const candidates = useMemo(() => (members.data?.members ?? []).filter((m) => m.role !== "owner"), [members.data]);
  const [membershipId, setMembershipId] = useState("");
  const [confirm, setConfirm] = useState(false);
  const target = candidates.find((m) => m.id === membershipId);
  const transfer = useApiMutation<{ ownerMembershipId: string; billingAccountMoved: boolean }, { membershipId: string }>({
    path: ws.path("/transfer-ownership"),
    invalidate: [workspaceDetailKey(ws.id), ws.key("members"), ME_KEY],
    success: (r) => (r.billingAccountMoved ? "Ownership transferred, with the billing account" : "Ownership transferred"),
    errorToast: false,
  });

  return (
    <Card>
      <CardHeader icon={<UserRoundCog />} title="Transfer ownership" description="Make another member the owner. You stay in the workspace as an admin." />
      <CardBody className="flex flex-col gap-3">
        {candidates.length ? (
          <Field label="New owner" hint="They must have confirmed their email address.">
            <NativeSelect
              value={membershipId}
              onChange={(e) => setMembershipId(e.target.value)}
              placeholder="Choose a member"
              options={candidates.map((m) => ({ value: m.id, label: `${m.name || m.email} (${labelOf(m.role)})` }))}
              className="sm:max-w-80"
            />
          </Field>
        ) : (
          <p className="text-sm text-text-2">Invite the person first: ownership can only go to a member of this workspace.</p>
        )}
        <p className="text-xs text-text-3">
          If this is the only workspace on your billing account, the billing account moves too and billing emails go to the new owner. The subscription and the card on file stay as they are; the new owner can change them in Plan &amp; billing.
        </p>
      </CardBody>
      <CardFooter>
        <Button icon={<UserRoundCog />} disabled={!target} onClick={() => setConfirm(true)}>
          Transfer ownership…
        </Button>
      </CardFooter>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        tone="default"
        title={`Make ${target?.name || target?.email || "this member"} the owner?`}
        description="Only the owner can delete the workspace, manage billing or transfer it again. You become an admin straight away."
        confirmLabel="Transfer ownership"
        onConfirm={() => transfer.mutateAsync({ membershipId })}
      />
    </Card>
  );
}

function DeleteCard() {
  const ws = useWorkspace();
  const [confirm, setConfirm] = useState(false);
  const remove = useApiMutation<{ deleted: boolean; purgeAfter: string }, { confirmName: string }>({
    path: ws.path("/delete"),
    errorToast: false,
    onSuccess: () => {
      // The workspace is gone for everyone now; start again from the workspace picker.
      window.location.assign("/");
    },
  });
  return (
    <Card className="border-bad/40">
      <CardHeader icon={<Trash2 />} title="Delete workspace" description="Removes the workspace for every member." />
      <CardBody className="flex flex-col gap-3">
        <Callout tone="bad" title="What happens">
          Nobody can open the workspace from the moment you confirm. Running campaigns stop and nothing more is sent from it. If it is the last workspace on
          your billing account, the subscription is cancelled (a paid period runs out without renewing). The data is permanently erased after the restore
          window; until then, support can restore it if you change your mind. Export your data first if you need a copy.
        </Callout>
      </CardBody>
      <CardFooter>
        <Button variant="danger" icon={<Trash2 />} onClick={() => setConfirm(true)}>
          Delete workspace…
        </Button>
      </CardFooter>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={`Delete ${ws.name}?`}
        description="Type the workspace name to confirm. Every member loses access at once."
        confirmLabel="Delete workspace"
        confirmText={ws.name}
        onConfirm={() => remove.mutateAsync({ confirmName: ws.name })}
      />
    </Card>
  );
}

/** Settings → Data & privacy: full exports (data.export), and for the owner, transfer and deletion. */
export function DataPrivacySettings() {
  const ws = useWorkspace();
  const isOwner = ws.role === "owner";
  return (
    <RequirePermission permission="data.export">
      <PageHeader icon={<EntityTile of="privacy" />} title="Data & privacy" description="Take a full copy of the workspace's data, hand the workspace to someone else, or delete it." />
      <div className="flex flex-col gap-5">
        <ExportCard />
        {isOwner ? (
          <>
            <TransferCard />
            <DeleteCard />
          </>
        ) : (
          <Callout tone="info">Only the workspace owner can transfer or delete the workspace.</Callout>
        )}
      </div>
    </RequirePermission>
  );
}
