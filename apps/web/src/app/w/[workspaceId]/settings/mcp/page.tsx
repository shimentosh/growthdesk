"use client";

import { useState } from "react";
import { Activity, AppWindow, Ban, Bot, Hourglass, Plug, Plus, ShieldCheck, Unplug } from "lucide-react";
import { MCP_ACCESS_INFO, MCP_CONFIRMATION_MINUTES, type McpAccess } from "@growthdesk/shared";
import { Badge, type Tone } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { COL, ColumnLabel } from "@/components/ui/columns";
import { ConfirmDialog } from "@/components/ui/Dialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { EntityTile } from "@/components/ui/icons";
import { QueryState } from "@/components/ui/ErrorState";
import { PageHeader } from "@/components/ui/PageHeader";
import { SkeletonText } from "@/components/ui/Skeleton";
import { UpgradePrompt } from "@/components/ui/UpgradePrompt";
import { CopyValue } from "@/components/integrations/Copy";
import { McpSetup, TOKEN_PLACEHOLDER } from "@/components/integrations/McpSetup";
import { McpTokenFormModal, McpTokenSecretModal } from "@/components/integrations/McpTokenModals";
import { useApiMutation, useApiQuery } from "@/lib/query";
import { useFormat, useWorkspace } from "@/lib/session";
import type { McpCall, McpPendingAction, McpToken, McpTokenList, McpTokenStatus, McpTokenWithSecret } from "@/lib/types/mcp";

const STATUS: Record<McpTokenStatus, { label: string; tone: Tone }> = {
  active: { label: "Active", tone: "ok" },
  expired: { label: "Expired", tone: "warn" },
  revoked: { label: "Revoked", tone: "mute" },
};

const ACCESS_TONE: Record<McpAccess, Tone> = { read: "mute", build: "info", send: "warn" };

function AccessBadge({ access }: { access: McpAccess }) {
  return <Badge tone={ACCESS_TONE[access]}>{MCP_ACCESS_INFO[access].label}</Badge>;
}

function TokenRow({ row, seesAll }: { row: McpToken; seesAll: boolean }) {
  const ws = useWorkspace();
  const f = useFormat();
  const [confirm, setConfirm] = useState(false);
  const revoke = useApiMutation<{ revoked: boolean }, void>({
    method: "DELETE",
    path: ws.path(`/mcp/tokens/${row.id}`),
    invalidate: [ws.key("mcp")],
    success: "Token revoked",
    errorToast: false,
  });
  const status = STATUS[row.status];

  return (
    <li className="flex flex-col gap-2 px-4 py-3.5">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium break-all text-text-hi">{row.name}</span>
            <AccessBadge access={row.access} />
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
      <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-text-3">
        {seesAll && row.user && <span>{row.mine ? "Yours" : `${row.user.name || row.user.email}'s`}</span>}
        <span>Created {f.date(row.createdAt)}</span>
        <span>{row.lastUsedAt ? `Last used ${f.relative(row.lastUsedAt)}` : "Never used"}</span>
        {row.clientName && <span>Client: {row.clientName}</span>}
        {row.viaOAuth && <span>Connected with Growthdesk login</span>}
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
        description="Claude is disconnected at once, and anything it prepared for confirmation is dropped. This cannot be undone — create a new token to reconnect."
        confirmLabel="Revoke token"
        onConfirm={() => revoke.mutateAsync()}
      />
    </li>
  );
}

/** An app connected with “Add custom connector” / sign-in (OAuth): one row per app, however often it refreshes. */
function AppRow({ row, seesAll }: { row: McpToken; seesAll: boolean }) {
  const ws = useWorkspace();
  const f = useFormat();
  const [confirm, setConfirm] = useState(false);
  const disconnect = useApiMutation<{ revoked: boolean }, void>({
    method: "DELETE",
    path: ws.path(`/mcp/tokens/${row.id}`),
    invalidate: [ws.key("mcp")],
    success: "Disconnected",
    errorToast: false,
  });
  const name = row.clientName || row.name;

  return (
    <li className="flex flex-col gap-2 px-4 py-3.5">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium break-all text-text-hi">{name}</span>
            <AccessBadge access={row.access} />
            {row.status === "expired" ? (
              <Badge tone="warn" dot>
                Signed out
              </Badge>
            ) : (
              <Badge tone="ok" dot>
                Connected
              </Badge>
            )}
          </div>
          <div className="mt-0.5 text-xs text-text-2">Workspace: {ws.name}</div>
        </div>
        <Button size="sm" variant="ghost" icon={<Unplug />} onClick={() => setConfirm(true)}>
          Disconnect
        </Button>
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-text-3">
        {seesAll && row.user && <span>{row.mine ? "Yours" : `${row.user.name || row.user.email}'s`}</span>}
        <span>Connected {f.date(row.createdAt)}</span>
        <span>{row.lastUsedAt ? `Last used ${f.relative(row.lastUsedAt)}` : "Not used yet"}</span>
        {row.status === "expired" ? <span>Reconnect from the app to use it again</span> : row.expiresAt && <span>Stays signed in until {f.date(row.expiresAt)} unless used</span>}
      </div>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={`Disconnect ${name}?`}
        description="It loses access at once, and anything it prepared for confirmation is dropped. To use it again, connect it again from the app."
        confirmLabel="Disconnect"
        onConfirm={() => disconnect.mutateAsync()}
      />
    </li>
  );
}

function PendingRow({ row, seesAll }: { row: McpPendingAction; seesAll: boolean }) {
  const ws = useWorkspace();
  const f = useFormat();
  const cancel = useApiMutation<{ canceled: boolean }, void>({
    method: "DELETE",
    path: ws.path(`/mcp/pending/${row.id}`),
    invalidate: [ws.key("mcp")],
    success: "Canceled — Claude can no longer confirm it",
  });
  return (
    <li className="flex items-start gap-3 px-4 py-3">
      <div className="min-w-0 flex-1">
        <p className="text-sm text-text-hi">{row.summary}</p>
        <div className="mt-0.5 flex flex-wrap gap-x-3 text-xs text-text-3">
          <span className="font-mono">{row.tool}</span>
          <span>via {row.token.name}</span>
          {seesAll && row.user && <span>{row.user.name || row.user.email}</span>}
          <span>Lapses {f.relative(row.expiresAt)}</span>
        </div>
      </div>
      <Button size="sm" variant="ghost" icon={<Ban />} loading={cancel.isPending} onClick={() => cancel.mutate()}>
        Cancel
      </Button>
    </li>
  );
}

function ActivityTable({ rows, seesAll }: { rows: McpCall[]; seesAll: boolean }) {
  const f = useFormat();
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead className="text-xs text-text-3">
          <tr className="border-b border-line">
            <th className="px-4 py-2 font-medium"><ColumnLabel icon={COL.updated}>When</ColumnLabel></th>
            <th className="px-4 py-2 font-medium"><ColumnLabel icon={COL.tool}>Tool</ColumnLabel></th>
            <th className="px-4 py-2 font-medium"><ColumnLabel icon={COL.result}>Result</ColumnLabel></th>
            <th className="px-4 py-2 font-medium"><ColumnLabel icon={COL.key}>Token</ColumnLabel></th>
            {seesAll && <th className="px-4 py-2 font-medium"><ColumnLabel icon={COL.person}>Person</ColumnLabel></th>}
            <th className="px-4 py-2 text-right font-medium"><ColumnLabel icon={COL.duration}>Time</ColumnLabel></th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {rows.map((r) => (
            <tr key={r.id}>
              <td className="px-4 py-2 whitespace-nowrap text-text-2" title={f.dateTime(r.createdAt)}>
                {f.relative(r.createdAt)}
              </td>
              <td className="px-4 py-2 font-mono text-xs text-text-hi">{r.tool}</td>
              <td className="max-w-[320px] px-4 py-2">
                {r.ok ? (
                  <Badge tone="ok" dot>
                    OK
                  </Badge>
                ) : (
                  <span className="flex flex-col gap-0.5">
                    <Badge tone="bad" dot>
                      Refused or failed
                    </Badge>
                    {r.error && <span className="truncate text-xs text-text-3" title={r.error}>{r.error}</span>}
                  </span>
                )}
              </td>
              <td className="px-4 py-2 whitespace-nowrap text-text-2">{r.token.name}</td>
              {seesAll && <td className="px-4 py-2 whitespace-nowrap text-text-2">{r.user?.name || r.user?.email || "—"}</td>}
              <td className="px-4 py-2 text-right text-xs whitespace-nowrap text-text-3 tabular-nums">{r.durationMs} ms</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function McpSettingsPage() {
  const ws = useWorkspace();
  const list = useApiQuery<McpTokenList>(ws.key("mcp", "tokens"), ws.path("/mcp/tokens"));
  const pending = useApiQuery<McpPendingAction[]>(ws.key("mcp", "pending"), ws.path("/mcp/pending"), { refetchInterval: 15_000 });
  const activity = useApiQuery<McpCall[]>(ws.key("mcp", "activity"), ws.path("/mcp/activity"), { refetchInterval: 30_000 });
  const [creating, setCreating] = useState(false);
  const [secret, setSecret] = useState<McpTokenWithSecret | null>(null);
  const allowed = ws.hasFeature("apiAccess");
  const seesAll = list.data?.seesAll ?? false;
  // Apps connected by signing in (OAuth) are listed apart from personal tokens; disconnected ones drop off.
  const apps = list.data?.items.filter((i) => i.viaOAuth && i.status !== "revoked") ?? [];

  const add = allowed ? (
    <Button variant="primary" icon={<Plus />} onClick={() => setCreating(true)}>
      Create token
    </Button>
  ) : undefined;

  return (
    <>
      <PageHeader
        icon={<EntityTile of="mcp" />}
        title="MCP / Claude"
        description="Work in Growthdesk from Claude — Claude Code, Claude Desktop or claude.ai — or any app that speaks MCP (Model Context Protocol). Ask it to find contacts, build lists, draft campaigns or summarise your inbox."
        actions={add}
      />

      {!allowed && (
        <UpgradePrompt
          className="mb-5"
          details={{ feature: "apiAccess", plan: ws.plan.name }}
          message="Connecting Claude needs a plan with API access. Existing tokens stay listed here and can still be revoked."
        />
      )}

      <Card className="mb-5">
        <CardHeader icon={<ShieldCheck />} title="How it works" />
        <CardBody>
          <ul className="flex flex-col gap-2 text-sm text-text">
            <li>
              <span className="font-medium text-text-hi">It acts as you.</span> A token is personal: Claude sees and does only what your role in {ws.name} allows, and the audit
              log marks what it did as “via MCP”.
            </li>
            <li>
              <span className="font-medium text-text-hi">You choose how far it goes.</span> {MCP_ACCESS_INFO.read.label}, {MCP_ACCESS_INFO.build.label}, or{" "}
              {MCP_ACCESS_INFO.send.label} — pick one per token.
            </li>
            <li>
              <span className="font-medium text-text-hi">Important actions wait for you.</span> Sending, launching, pausing and deleting never happen straight away: Claude shows you
              what it is about to do and asks; only your “yes” in the chat carries it out, within {MCP_CONFIRMATION_MINUTES} minutes.
            </li>
          </ul>
        </CardBody>
      </Card>

      <Card className="mb-5">
        <CardHeader
          icon={<Plug />}
          title="Connecting"
          description="Add Growthdesk to Claude with just this address: you sign in to Growthdesk and choose the workspace and access level — no token to copy. Apps that can't sign in use a personal token instead."
        />
        <CardBody className="flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium text-text-2">MCP server URL</span>
            {list.data ? <CopyValue value={list.data.url} label="Copy URL" copied="MCP URL copied" /> : <SkeletonText lines={1} />}
          </div>
          {list.data && <McpSetup url={list.data.url} token={TOKEN_PLACEHOLDER} />}
        </CardBody>
      </Card>

      {(pending.data?.length ?? 0) > 0 && (
        <Card className="mb-5">
          <CardHeader
            icon={<Hourglass />}
            title="Waiting for confirmation"
            description="Important actions Claude has prepared. They run only if confirmed in the chat; cancel one here and it cannot be."
          />
          <ul className="divide-y divide-line">
            {pending.data!.map((p) => (
              <PendingRow key={p.id} row={p} seesAll={seesAll} />
            ))}
          </ul>
        </Card>
      )}

      {apps.length > 0 && (
        <Card className="mb-5">
          <CardHeader
            icon={<AppWindow />}
            title="Connected apps"
            description={
              seesAll ? "Apps people connected by signing in to Growthdesk (claude.ai, Claude Code, Claude Desktop…)." : "Apps you connected by signing in to Growthdesk (claude.ai, Claude Code, Claude Desktop…)."
            }
          />
          <ul className="divide-y divide-line">
            {apps.map((r) => (
              <AppRow key={r.id} row={r} seesAll={seesAll} />
            ))}
          </ul>
        </Card>
      )}

      <h2 className="mb-2 text-sm font-semibold text-text-hi">{seesAll ? "Personal tokens in this workspace" : "Your personal tokens"}</h2>
      <QueryState
        query={list}
        loading={
          <Card className="mb-5 p-4">
            <SkeletonText lines={4} />
          </Card>
        }
        isEmpty={(d) => !d.items.some((i) => !i.viaOAuth)}
        empty={
          <Card className="mb-5">
            <EmptyState
              icon={<Bot />}
              tint="gray"
              title="No personal tokens"
              description={
                allowed
                  ? "Most apps connect by signing in, with just the address above. For apps that can't, create a token and paste the setup it comes with."
                  : "Tokens can be created once the plan includes API access."
              }
              action={add}
            />
          </Card>
        }
      >
        {(d) => (
          <Card className="mb-5">
            <ul className="divide-y divide-line">
              {d.items
                .filter((i) => !i.viaOAuth)
                .map((r) => (
                  <TokenRow key={r.id} row={r} seesAll={d.seesAll} />
                ))}
            </ul>
          </Card>
        )}
      </QueryState>

      <Card>
        <CardHeader icon={<Activity />} title="Recent MCP activity" description={seesAll ? "The last 50 tool calls by anyone in this workspace." : "Your last 50 tool calls."} />
        <QueryState
          query={activity}
          loading={
            <div className="p-4">
              <SkeletonText lines={3} />
            </div>
          }
          isEmpty={(d) => d.length === 0}
          empty={<p className="px-4 py-6 text-center text-sm text-text-3">Nothing yet — calls Claude makes will show up here.</p>}
        >
          {(rows) => <ActivityTable rows={rows} seesAll={seesAll} />}
        </QueryState>
      </Card>

      {creating && <McpTokenFormModal open onOpenChange={setCreating} onCreated={setSecret} />}
      <McpTokenSecretModal token={secret} onClose={() => setSecret(null)} />
    </>
  );
}
