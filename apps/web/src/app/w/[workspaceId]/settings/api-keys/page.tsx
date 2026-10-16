"use client";

import { useState } from "react";
import { Ban, KeyRound, Plug, Plus } from "lucide-react";
import { API_SCOPE_INFO, MAX_LEADS_PER_REQUEST } from "@growthdesk/shared";
import { Badge, type Tone } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { ConfirmDialog } from "@/components/ui/Dialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { EntityTile } from "@/components/ui/icons";
import { QueryState } from "@/components/ui/ErrorState";
import { PageHeader } from "@/components/ui/PageHeader";
import { RequirePermission } from "@/components/ui/RequirePermission";
import { SkeletonText } from "@/components/ui/Skeleton";
import { Tooltip } from "@/components/ui/Tooltip";
import { UpgradePrompt } from "@/components/ui/UpgradePrompt";
import { ApiKeyFormModal } from "@/components/integrations/ApiKeyFormModal";
import { ApiKeySecretModal } from "@/components/integrations/ApiKeySecretModal";
import { CopyValue } from "@/components/integrations/Copy";
import { useOrigin } from "@/lib/hooks";
import { useApiMutation, useApiQuery } from "@/lib/query";
import { useFormat, useWorkspace } from "@/lib/session";
import type { ApiKey, ApiKeyStatus, ApiKeyWithSecret } from "@/lib/types/api-keys";

const STATUS: Record<ApiKeyStatus, { label: string; tone: Tone }> = {
  active: { label: "Active", tone: "ok" },
  expired: { label: "Expired", tone: "warn" },
  revoked: { label: "Revoked", tone: "mute" },
};

function KeyRow({ row }: { row: ApiKey }) {
  const ws = useWorkspace();
  const f = useFormat();
  const [confirm, setConfirm] = useState(false);
  const revoke = useApiMutation<{ revoked: boolean }, void>({
    method: "DELETE",
    path: ws.path(`/api-keys/${row.id}`),
    invalidate: [ws.key("api-keys")],
    success: "API key revoked",
    errorToast: false,
  });
  const status = STATUS[row.status];

  return (
    <li className="flex flex-col gap-2 px-4 py-3.5">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium break-all text-text-hi">{row.name}</span>
            <Badge tone={status.tone} dot>
              {status.label}
            </Badge>
          </div>
          <div className="mt-0.5 font-mono text-xs text-text-2">{row.prefix}…</div>
        </div>
        {row.status !== "revoked" && (
          <Button size="sm" variant="ghost" icon={<Ban />} onClick={() => setConfirm(true)}>
            Revoke
          </Button>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {row.scopes.map((s) => (
          <Tooltip key={s} content={API_SCOPE_INFO[s]?.description ?? s}>
            <span tabIndex={0}>
              <Badge quiet>{API_SCOPE_INFO[s]?.label ?? s}</Badge>
            </span>
          </Tooltip>
        ))}
      </div>

      <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-text-3">
        <span>
          Created {f.date(row.createdAt)}
          {row.createdBy && ` by ${row.createdBy.name}`}
        </span>
        <span>{row.lastUsedAt ? `Last used ${f.relative(row.lastUsedAt)}` : "Never used"}</span>
        {row.revokedAt ? (
          <span>Revoked {f.date(row.revokedAt)}</span>
        ) : (
          row.expiresAt && <span>{row.status === "expired" ? `Expired ${f.date(row.expiresAt)}` : `Expires ${f.date(row.expiresAt)}`}</span>
        )}
      </div>

      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={`Revoke “${row.name}”?`}
        description="Requests using this key are refused from now on. This cannot be undone — create a new key if the system still needs access."
        confirmLabel="Revoke key"
        onConfirm={() => revoke.mutateAsync()}
      />
    </li>
  );
}

export default function ApiKeysPage() {
  const ws = useWorkspace();
  const origin = useOrigin();
  const list = useApiQuery<ApiKey[]>(ws.key("api-keys", "list"), ws.path("/api-keys"));
  const [creating, setCreating] = useState(false);
  const [secret, setSecret] = useState<ApiKeyWithSecret | null>(null);
  const allowed = ws.hasFeature("apiAccess");
  const baseUrl = `${origin}/api/workspaces/${ws.id}`;

  const add = allowed ? (
    <Button variant="primary" icon={<Plus />} onClick={() => setCreating(true)}>
      Create API key
    </Button>
  ) : undefined;

  return (
    <RequirePermission permission="apikeys.manage">
      <PageHeader
        icon={<EntityTile of="apiKeys" />}
        title="API keys"
        description="Let Business OS and your own systems send leads and read or write CRM records. A key acts on this workspace only, within the scopes you give it."
        actions={list.data && list.data.length > 0 ? add : undefined}
      />

      {!allowed && (
        <UpgradePrompt
          className="mb-5"
          details={{ feature: "apiAccess", plan: ws.plan.name }}
          message="New keys cannot be created, and existing keys are refused, until the plan includes API access. Existing keys stay listed here and can still be revoked."
        />
      )}

      <Card className="mb-5">
        <CardHeader
          icon={<Plug />}
          title="Connecting"
          description={
            <>
              Send requests to this base URL with <code className="font-mono">Authorization: Bearer &lt;key&gt;</code>. Leads go to{" "}
              <code className="font-mono">POST …/leads</code> (up to {MAX_LEADS_PER_REQUEST} per request; add an <code className="font-mono">Idempotency-Key</code> header to make retries
              safe).
            </>
          }
        />
        <CardBody className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium text-text-2">Base URL</span>
            {origin ? <CopyValue value={baseUrl} label="Copy base URL" copied="Base URL copied" /> : <SkeletonText lines={1} />}
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium text-text-2">Workspace ID</span>
            <CopyValue value={ws.id} label="Copy workspace ID" copied="Workspace ID copied" />
          </div>
        </CardBody>
      </Card>

      <QueryState
        query={list}
        loading={
          <Card className="p-4">
            <SkeletonText lines={4} />
          </Card>
        }
        isEmpty={(d) => d.length === 0}
        empty={
          <Card>
            <EmptyState
              icon={<KeyRound />}
              tint="gray"
              title="No API keys"
              description={allowed ? "Create a key for Business OS or another system to push leads into this workspace." : "Keys can be created once the plan includes API access."}
              action={add}
            />
          </Card>
        }
      >
        {(rows) => (
          <Card>
            <ul className="divide-y divide-line">
              {rows.map((r) => (
                <KeyRow key={r.id} row={r} />
              ))}
            </ul>
          </Card>
        )}
      </QueryState>

      {creating && <ApiKeyFormModal open onOpenChange={setCreating} onCreated={setSecret} />}
      <ApiKeySecretModal apiKey={secret} onClose={() => setSecret(null)} />
    </RequirePermission>
  );
}
