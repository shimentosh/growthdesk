"use client";

import { useState } from "react";
import { CircleAlert, Ellipsis, History, KeyRound, Pencil, Plus, Send, Trash2, Webhook } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button, IconButton } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { ConfirmDialog } from "@/components/ui/Dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/DropdownMenu";
import { EmptyState } from "@/components/ui/EmptyState";
import { EntityTile } from "@/components/ui/icons";
import { QueryState } from "@/components/ui/ErrorState";
import { PageHeader } from "@/components/ui/PageHeader";
import { RequirePermission } from "@/components/ui/RequirePermission";
import { SkeletonText } from "@/components/ui/Skeleton";
import { Switch } from "@/components/ui/Switch";
import { toast } from "@/components/ui/Toast";
import { Tooltip } from "@/components/ui/Tooltip";
import { WebhookDeliveriesDrawer } from "@/components/integrations/WebhookDeliveriesDrawer";
import { WebhookFormModal } from "@/components/integrations/WebhookFormModal";
import { WebhookSecretModal } from "@/components/integrations/WebhookSecretModal";
import { useApiMutation, useApiQuery } from "@/lib/query";
import { useFormat, useWorkspace } from "@/lib/session";
import {
  eventLabel,
  WEBHOOK_AUTO_DISABLE_AFTER,
  type WebhookEndpoint,
  type WebhookTestResult,
  type WebhookWithSecret,
} from "@/lib/types/integrations";

function EndpointRow({
  row,
  onEdit,
  onDeliveries,
  onSecret,
}: {
  row: WebhookEndpoint;
  onEdit: () => void;
  onDeliveries: () => void;
  onSecret: (r: WebhookWithSecret) => void;
}) {
  const ws = useWorkspace();
  const f = useFormat();
  const [confirm, setConfirm] = useState<"delete" | "rotate" | null>(null);

  const toggle = useApiMutation<WebhookEndpoint, { enabled: boolean }>({
    method: "PATCH",
    path: ws.path(`/webhooks/${row.id}`),
    invalidate: [ws.key("webhooks")],
    success: (r) => (r.enabled ? "Endpoint switched on" : "Endpoint switched off"),
  });
  const test = useApiMutation<WebhookTestResult, void>({
    path: ws.path(`/webhooks/${row.id}/test`),
    invalidate: [ws.key("webhooks")],
    onSuccess: (r) => {
      if (r.ok) toast.success(`Test delivered${r.responseStatus ? ` — HTTP ${r.responseStatus}` : ""}`);
      else toast.error(r.error || "The endpoint did not accept the test", { description: r.responseStatus ? `HTTP ${r.responseStatus}` : undefined });
    },
  });
  const rotate = useApiMutation<WebhookWithSecret, void>({
    path: ws.path(`/webhooks/${row.id}/rotate-secret`),
    invalidate: [ws.key("webhooks")],
    errorToast: false,
    onSuccess: (r) => onSecret(r),
  });
  const remove = useApiMutation<{ deleted: boolean }, void>({
    method: "DELETE",
    path: ws.path(`/webhooks/${row.id}`),
    invalidate: [ws.key("webhooks")],
    success: "Endpoint deleted",
    errorToast: false,
  });

  const shown = row.events.slice(0, 4);
  const autoDisabled = !row.enabled && row.failureCount >= WEBHOOK_AUTO_DISABLE_AFTER;

  return (
    <li className="flex flex-col gap-2 px-4 py-3.5">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="font-mono text-sm break-all text-text-hi">{row.url}</div>
          {row.description && <div className="mt-0.5 text-xs text-text-2">{row.description}</div>}
        </div>
        <Switch
          checked={row.enabled}
          onCheckedChange={(enabled) => toggle.mutate({ enabled })}
          disabled={toggle.isPending}
          aria-label={row.enabled ? "Switch endpoint off" : "Switch endpoint on"}
        />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <IconButton label="Endpoint actions" icon={<Ellipsis />} />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem icon={<Send />} disabled={!row.enabled || test.isPending} onSelect={() => test.mutate()}>
              {test.isPending ? "Sending test…" : "Send test event"}
            </DropdownMenuItem>
            <DropdownMenuItem icon={<History />} onSelect={onDeliveries}>
              Deliveries
            </DropdownMenuItem>
            <DropdownMenuItem icon={<Pencil />} onSelect={onEdit}>
              Edit
            </DropdownMenuItem>
            <DropdownMenuItem icon={<KeyRound />} onSelect={() => setConfirm("rotate")}>
              Rotate signing secret
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem danger icon={<Trash2 />} onSelect={() => setConfirm("delete")}>
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {shown.map((e) => (
          <Badge key={e} quiet>
            {eventLabel(e)}
          </Badge>
        ))}
        {row.events.length > shown.length && (
          <Tooltip content={row.events.slice(shown.length).map(eventLabel).join(", ")}>
            <span tabIndex={0} className="text-xs text-text-3">
              +{row.events.length - shown.length} more
            </span>
          </Tooltip>
        )}
      </div>

      <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-text-3">
        <span>{row.enabled ? "Active" : "Off"}</span>
        <span>{row.lastDeliveryAt ? `Last delivery ${f.relative(row.lastDeliveryAt)}` : "No deliveries yet"}</span>
        {row.failureCount > 0 && <span className="text-warn-ink">{row.failureCount} failed in a row</span>}
      </div>

      {autoDisabled ? (
        <p className="flex items-start gap-1.5 text-xs text-bad-ink">
          <CircleAlert aria-hidden className="mt-px size-3.5 shrink-0" />
          <span className="min-w-0 break-words">
            Switched off automatically after {row.failureCount} failed deliveries in a row. Fix the receiver, then switch it back on.
            {row.lastError && ` Last error: ${row.lastError}`}
          </span>
        </p>
      ) : (
        row.lastError && (
          <p className="flex items-start gap-1.5 font-mono text-xs break-words text-bad-ink">
            <CircleAlert aria-hidden className="mt-px size-3.5 shrink-0" />
            <span className="min-w-0">{row.lastError}</span>
          </p>
        )
      )}

      <ConfirmDialog
        open={confirm === "rotate"}
        onOpenChange={(o) => setConfirm(o ? "rotate" : null)}
        tone="default"
        title="Rotate the signing secret?"
        description="A new secret replaces the current one immediately. Requests are signed with the new one from now on, so update the receiver straight away."
        confirmLabel="Rotate secret"
        onConfirm={() => rotate.mutateAsync()}
      />
      <ConfirmDialog
        open={confirm === "delete"}
        onOpenChange={(o) => setConfirm(o ? "delete" : null)}
        title="Delete this endpoint?"
        description="It stops receiving events at once, and deliveries still waiting to be retried are dropped."
        onConfirm={() => remove.mutateAsync()}
      />
    </li>
  );
}

export default function WebhooksPage() {
  const ws = useWorkspace();
  const list = useApiQuery<WebhookEndpoint[]>(ws.key("webhooks", "list"), ws.path("/webhooks"));
  const [form, setForm] = useState<{ endpoint: WebhookEndpoint | null } | null>(null);
  const [secret, setSecret] = useState<WebhookWithSecret | null>(null);
  const [deliveries, setDeliveries] = useState<WebhookEndpoint | null>(null);

  const add = (
    <Button variant="primary" icon={<Plus />} onClick={() => setForm({ endpoint: null })}>
      Add endpoint
    </Button>
  );

  return (
    <RequirePermission permission="webhooks.manage">
      <PageHeader
        icon={<EntityTile of="webhooks" />}
        title="Webhooks"
        description="Send events to your own systems as they happen. Every request is a JSON POST signed with the endpoint's secret."
        actions={list.data && list.data.length > 0 ? add : undefined}
      />
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
              icon={<Webhook />}
              tint="purple"
              title="No webhook endpoints"
              description="Add a URL to receive contacts, replies, deal changes and more the moment they happen."
              action={add}
            />
          </Card>
        }
      >
        {(rows) => (
          <Card>
            <ul className="divide-y divide-line">
              {rows.map((r) => (
                <EndpointRow
                  key={r.id}
                  row={r}
                  onEdit={() => setForm({ endpoint: r })}
                  onDeliveries={() => setDeliveries(r)}
                  onSecret={setSecret}
                />
              ))}
            </ul>
          </Card>
        )}
      </QueryState>

      {form && (
        <WebhookFormModal
          key={form.endpoint?.id ?? "new"}
          endpoint={form.endpoint}
          open
          onOpenChange={(o) => {
            if (!o) setForm(null);
          }}
          onCreated={setSecret}
        />
      )}
      <WebhookSecretModal endpoint={secret} onClose={() => setSecret(null)} />
      <WebhookDeliveriesDrawer endpoint={deliveries} onClose={() => setDeliveries(null)} />
    </RequirePermission>
  );
}
