"use client";

import { useState, type ReactNode } from "react";
import { Briefcase, Check, PanelsTopLeft, Plug, RefreshCw, Unplug } from "lucide-react";
import { API_SCOPE_INFO, INTEGRATION_APP_INFO, type CommerceSettings, type IntegrationApp } from "@growthdesk/shared";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Card } from "@/components/ui/Card";
import { ConfirmDialog, Modal } from "@/components/ui/Dialog";
import { FormError } from "@/components/ui/Field";
import { IconTile, type Tint } from "@/components/ui/IconTile";
import { SkeletonText } from "@/components/ui/Skeleton";
import { Switch } from "@/components/ui/Switch";
import { del, messageOf } from "@/lib/api";
import { useOrigin } from "@/lib/hooks";
import { useApiMutation, useApiQuery, useInvalidate } from "@/lib/query";
import { useFormat, useWorkspace } from "@/lib/session";
import type { ApiKey, ApiKeyWithSecret, CatalogSource } from "@/lib/types/api-keys";
import { CopyValue } from "./Copy";

const LOOK: Record<IntegrationApp, { icon: ReactNode; tint: Tint }> = {
  clientdesk: { icon: <PanelsTopLeft />, tint: "teal" },
  business_os: { icon: <Briefcase />, tint: "indigo" },
};

/** The key, base URL and workspace ID an app needs, shown once after connecting. */
function ConnectedModal({ app, apiKey, onClose }: { app: IntegrationApp; apiKey: ApiKeyWithSecret | null; onClose: () => void }) {
  const ws = useWorkspace();
  const origin = useOrigin();
  const { label } = INTEGRATION_APP_INFO[app];
  return (
    <Modal
      open={apiKey !== null}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      size="lg"
      dismissOnOutside={false}
      title={`Finish connecting ${label}`}
      description={`Paste these three values into ${label}'s GrowthDesk connection settings.`}
      footer={
        <Button variant="primary" onClick={onClose}>
          I've pasted them
        </Button>
      }
    >
      {apiKey && (
        <div className="flex flex-col gap-4">
          <Callout tone="warn" title="You won't see this key again">
            Copy it into {label} now. If it is lost, disconnect and connect again.
          </Callout>
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium text-text-2">API key</span>
            <CopyValue value={apiKey.secret} label="Copy key" copied="API key copied" />
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium text-text-2">Base URL</span>
            {origin ? <CopyValue value={`${origin}/api/workspaces/${ws.id}`} label="Copy base URL" copied="Base URL copied" /> : <SkeletonText lines={1} />}
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium text-text-2">Workspace ID</span>
            <CopyValue value={ws.id} label="Copy workspace ID" copied="Workspace ID copied" />
          </div>
        </div>
      )}
    </Modal>
  );
}

/**
 * Whether Clientdesk's clients may get marketing email without confirming
 * first. Off ("ask"): their consent is left alone, so a double opt-in list
 * asks them. On: a client whose consent is unknown counts as agreed, on the
 * customer relationship — never one who said no.
 */
function ClientConsentSetting() {
  const ws = useWorkspace();
  const key = ws.key("commerce", "settings");
  const settings = useApiQuery<CommerceSettings>(key, ws.path("/commerce/settings"));
  const save = useApiMutation<CommerceSettings, CommerceSettings>({ method: "PUT", path: ws.path("/commerce/settings"), invalidate: [key], success: "Saved" });
  const on = (save.isPending ? save.variables?.clientConsent : settings.data?.clientConsent) === "existing_customers";
  return (
    <div className="rounded-md border border-line p-3">
      <Switch
        size="sm"
        checked={on}
        disabled={!ws.can("settings.manage") || !settings.data || save.isPending}
        onCheckedChange={(v) => save.mutate({ clientConsent: v ? "existing_customers" : "ask" })}
        label="Clients may get marketing email"
        description={
          on
            ? "Clients count as subscribed because they're your customers (unless they said no). Check that's allowed where you and they are."
            : "Off: clients get marketing only after they agree — e.g. add them to a double opt-in list, which emails them to confirm."
        }
      />
    </div>
  );
}

/**
 * One app on Settings → Integrations. Connecting creates an API key tagged with
 * the app and holding exactly its scopes (INTEGRATION_APP_INFO); the app is
 * connected while such a key is active. Disconnecting revokes those keys.
 */
export function AppConnection({ app, keys, canManage }: { app: IntegrationApp; keys: ApiKey[] | undefined; canManage: boolean }) {
  const ws = useWorkspace();
  const f = useFormat();
  const invalidate = useInvalidate();
  const info = INTEGRATION_APP_INFO[app];
  const look = LOOK[app];
  const allowed = ws.hasFeature("apiAccess");
  const [confirmConnect, setConfirmConnect] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [secret, setSecret] = useState<ApiKeyWithSecret | null>(null);

  const active = (keys ?? []).filter((k) => k.app === app && k.status === "active");
  const connected = active.length > 0;
  const newest = active[0];
  const lastUsed =
    active
      .map((k) => k.lastUsedAt)
      .filter((v): v is string => Boolean(v))
      .sort()
      .at(-1) ?? null;

  // Products the app keeps in step (Clientdesk's services), when it holds that scope.
  const syncsProducts = info.scopes.includes("products:write") && ws.can("quotes.read");
  const catalog = useApiQuery<CatalogSource[]>(ws.key("catalog", "sync"), syncsProducts && connected ? ws.path("/catalog/sync") : null);
  const products = catalog.data?.find((c) => c.source === app);

  const connect = useApiMutation<ApiKeyWithSecret, void>({
    path: ws.path("/api-keys"),
    body: () => ({ name: info.label, scopes: info.scopes, app }),
    invalidate: [ws.key("api-keys")],
    errorToast: false,
    onSuccess: (key) => {
      setConfirmConnect(false);
      setSecret(key);
    },
  });

  const disconnect = async () => {
    try {
      for (const k of active) await del(ws.path(`/api-keys/${k.id}`));
    } finally {
      await invalidate(ws.key("api-keys"));
    }
  };

  return (
    <Card className="flex flex-col gap-3 p-4">
      <div className="flex items-start gap-3">
        <IconTile icon={look.icon} tint={look.tint} size="md" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold text-text-hi">{info.label}</h3>
            {keys === undefined ? null : connected ? (
              <Badge tone="ok" dot>
                Connected
              </Badge>
            ) : (
              <Badge tone="mute">Not connected</Badge>
            )}
          </div>
          <p className="mt-0.5 text-xs text-text-3">{info.description}</p>
        </div>
      </div>

      {connected && newest && (
        <div className="flex flex-col gap-0.5 text-xs text-text-2">
          <span>
            Connected {f.date(newest.createdAt)}
            {newest.createdBy && ` by ${newest.createdBy.name}`}
          </span>
          <span>{lastUsed ? `Last heard from ${f.relative(lastUsed)}` : `Waiting for ${info.label} to call — paste the key into it to finish.`}</span>
          {products && (
            <span>
              {products.active} {products.active === 1 ? "product" : "products"} synced
              {products.lastSyncedAt && `, last ${f.relative(products.lastSyncedAt)}`}
            </span>
          )}
        </div>
      )}

      {connected && app === "clientdesk" && <ClientConsentSetting />}

      {canManage && keys !== undefined && (
        <div className="mt-auto flex flex-wrap gap-2 pt-1">
          {connected ? (
            <>
              <Button size="sm" icon={<RefreshCw />} onClick={() => setConfirmConnect(true)} disabled={!allowed}>
                New key
              </Button>
              <Button size="sm" variant="ghost" icon={<Unplug />} onClick={() => setConfirmDisconnect(true)}>
                Disconnect
              </Button>
            </>
          ) : (
            <Button size="sm" variant="primary" icon={<Plug />} onClick={() => setConfirmConnect(true)} disabled={!allowed}>
              Connect
            </Button>
          )}
        </div>
      )}

      <Modal
        open={confirmConnect}
        onOpenChange={(o) => {
          if (!o) connect.reset();
          setConfirmConnect(o);
        }}
        title={connected ? `New key for ${info.label}` : `Connect ${info.label}`}
        description={
          connected
            ? `Use this when ${info.label} lost its key. The current key keeps working until you disconnect.`
            : `Creates a key for ${info.label} to reach this workspace. You paste it into ${info.label} on the next step.`
        }
        footer={
          <>
            <Button onClick={() => setConfirmConnect(false)} disabled={connect.isPending}>
              Cancel
            </Button>
            <Button variant="primary" icon={<Plug />} loading={connect.isPending} onClick={() => connect.mutate()}>
              {connected ? "Create key" : "Connect"}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <span className="text-xs font-medium text-text-2">{info.label} will be able to</span>
          <ul className="flex flex-col gap-2">
            {info.scopes.map((s) => (
              <li key={s} className="flex items-start gap-2 text-sm">
                <Check aria-hidden className="mt-0.5 size-4 shrink-0 text-ok" />
                <span>
                  <span className="font-medium text-text-hi">{API_SCOPE_INFO[s].label}</span>
                  <span className="block text-xs text-text-3">{API_SCOPE_INFO[s].description}</span>
                </span>
              </li>
            ))}
          </ul>
          <FormError error={connect.error ? messageOf(connect.error) : null} />
        </div>
      </Modal>

      <ConfirmDialog
        open={confirmDisconnect}
        onOpenChange={setConfirmDisconnect}
        title={`Disconnect ${info.label}?`}
        description={`Its ${active.length === 1 ? "key is" : `${active.length} keys are`} revoked: ${info.label} can no longer send anything here. Leads and products it already sent stay.`}
        confirmLabel="Disconnect"
        onConfirm={disconnect}
      />

      <ConnectedModal app={app} apiKey={secret} onClose={() => setSecret(null)} />
    </Card>
  );
}
