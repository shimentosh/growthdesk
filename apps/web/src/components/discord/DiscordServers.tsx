"use client";

import { useMemo, useState } from "react";
import { FolderPlus, Hash, Megaphone, Plus, RefreshCw, Trash2, Unplug } from "lucide-react";
import { normalizeDiscordChannelName } from "@growthdesk/shared";
import { Badge, type Tone } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Card, CardHeader } from "@/components/ui/Card";
import { Checkbox } from "@/components/ui/Checkbox";
import { ConfirmDialog, Modal } from "@/components/ui/Dialog";
import { Drawer } from "@/components/ui/Drawer";
import { EmptyState } from "@/components/ui/EmptyState";
import { QueryState } from "@/components/ui/ErrorState";
import { Field, FormError } from "@/components/ui/Field";
import { Input, NativeSelect } from "@/components/ui/Input";
import { SkeletonText } from "@/components/ui/Skeleton";
import { toast } from "@/components/ui/Toast";
import { del, messageOf, post } from "@/lib/api";
import { useApiMutation, useApiQuery, useInvalidate } from "@/lib/query";
import { useFormat, useWorkspace } from "@/lib/session";
import { DiscordBotCard } from "./DiscordBot";
import type { DiscordConnection, DiscordDestination, DiscordOverview, DiscordStructure, DiscordStructureChannel } from "@/lib/types/discord";

const CONNECTION_STATUS: Record<DiscordConnection["status"], { label: string; tone: Tone }> = {
  connected: { label: "Connected", tone: "ok" },
  lost: { label: "Bot removed", tone: "bad" },
  disconnected: { label: "Disconnected", tone: "mute" },
};

const DEST_STATUS: Record<DiscordDestination["status"], { label: string; tone: Tone }> = {
  active: { label: "Active", tone: "ok" },
  missing: { label: "Deleted in Discord", tone: "bad" },
  forbidden: { label: "No permission", tone: "warn" },
};

/** Starts Discord's "add the bot" flow: the API signs the request and the browser goes to Discord, then back here. */
export function ConnectDiscordButton({ label = "Connect Discord", variant = "primary" }: { label?: string; variant?: "primary" | "secondary" }) {
  const ws = useWorkspace();
  const [open, setOpen] = useState(false);
  const [manageChannels, setManageChannels] = useState(true);
  const start = useApiMutation<{ url: string }, { manageChannels: boolean }>({
    path: ws.path("/discord/connect"),
    errorToast: false,
    onSuccess: ({ url }) => window.location.assign(url),
  });
  return (
    <>
      <Button variant={variant} icon={<Plus />} onClick={() => setOpen(true)}>
        {label}
      </Button>
      <Modal
        open={open}
        onOpenChange={(o) => {
          if (!o) start.reset();
          setOpen(o);
        }}
        title="Connect a Discord server"
        description="Discord opens and asks which server to add the Growthdesk bot to. You need the Manage Server permission there."
        footer={
          <>
            <Button onClick={() => setOpen(false)} disabled={start.isPending}>
              Cancel
            </Button>
            <Button variant="primary" loading={start.isPending} onClick={() => start.mutate({ manageChannels })}>
              Continue to Discord
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <p className="text-sm text-text-2">The bot asks for View channels, Send messages and Embed links. It never reads messages and never pings anyone.</p>
          <Checkbox
            checked={manageChannels}
            onCheckedChange={setManageChannels}
            label="Also let Growthdesk create and rename channels"
            description="Adds the Manage channels permission, so channels can be made from here. Leave off to pick only existing channels."
          />
          <FormError error={start.error ? messageOf(start.error) : null} />
        </div>
      </Modal>
    </>
  );
}

function ChannelIcon({ kind }: { kind: string }) {
  return kind === "announcement" ? <Megaphone aria-hidden className="size-4 shrink-0 text-text-3" /> : <Hash aria-hidden className="size-4 shrink-0 text-text-3" />;
}

/** Create a text channel (optionally saving it as a destination) or a category. */
function CreateChannelModal({ connection, categories, onClose }: { connection: DiscordConnection; categories: DiscordStructureChannel[]; onClose: () => void }) {
  const ws = useWorkspace();
  const [kind, setKind] = useState<"text" | "category">("text");
  const [name, setName] = useState("");
  const [parentId, setParentId] = useState("");
  const [addAsDestination, setAdd] = useState(true);
  const [group, setGroup] = useState("");
  const create = useApiMutation<unknown, void>({
    path: ws.path(`/discord/connections/${connection.id}/channels`),
    body: () => ({
      kind,
      name: name.trim(),
      parentId: kind === "text" && parentId ? parentId : null,
      addAsDestination: kind === "text" && addAsDestination,
      group: group.trim(),
    }),
    invalidate: [ws.key("discord")],
    success: kind === "text" ? "Channel created" : "Category created",
    errorToast: false,
    onSuccess: () => onClose(),
  });
  const shown = kind === "text" ? normalizeDiscordChannelName(name) : name.trim();
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={`New channel in ${connection.guildName}`}
      footer={
        <>
          <Button onClick={onClose} disabled={create.isPending}>
            Cancel
          </Button>
          <Button variant="primary" loading={create.isPending} disabled={!shown} onClick={() => create.mutate()}>
            Create
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Type">
          <NativeSelect
            value={kind}
            onChange={(e) => setKind(e.target.value as "text" | "category")}
            options={[
              { value: "text", label: "Text channel" },
              { value: "category", label: "Category" },
            ]}
          />
        </Field>
        <Field label="Name" hint={kind === "text" && shown && shown !== name.trim() ? `Discord will call it #${shown}` : undefined} error={create.error?.fields?.name}>
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} placeholder={kind === "text" ? "deals-won" : "Growthdesk"} autoFocus />
        </Field>
        {kind === "text" && (
          <>
            <Field label="Category">
              <NativeSelect
                value={parentId}
                onChange={(e) => setParentId(e.target.value)}
                placeholder="No category"
                options={categories.filter((c) => c.canManage).map((c) => ({ value: c.id, label: c.name }))}
              />
            </Field>
            <Checkbox checked={addAsDestination} onCheckedChange={setAdd} label="Post notifications here" description="Saves it as a destination, ready for rules." />
            {addAsDestination && (
              <Field label="Group" hint="Optional, to organise channels (Sales, Alerts…).">
                <Input value={group} onChange={(e) => setGroup(e.target.value)} maxLength={60} />
              </Field>
            )}
          </>
        )}
        <FormError error={create.error && !create.error.fields?.name ? messageOf(create.error) : null} />
      </div>
    </Modal>
  );
}

/** The server's channels, live from Discord, to choose which ones Growthdesk posts in. */
function ChannelsDrawer({ connection, onClose }: { connection: DiscordConnection; onClose: () => void }) {
  const ws = useWorkspace();
  const invalidate = useInvalidate();
  const canManage = ws.can("integrations.manage");
  const structure = useApiQuery<DiscordStructure>(ws.key("discord", "structure", connection.id), ws.path(`/discord/connections/${connection.id}/structure`));
  const [busy, setBusy] = useState<string | null>(null);
  const [group, setGroup] = useState("");
  const [creating, setCreating] = useState(false);

  const toggle = async (c: DiscordStructureChannel) => {
    setBusy(c.id);
    try {
      if (c.destinationId) await del(ws.path(`/discord/destinations/${c.destinationId}`));
      else
        await post(ws.path("/discord/destinations"), {
          connectionId: connection.id,
          channelId: c.id,
          group: group.trim(),
        });
      await invalidate(ws.key("discord"));
    } catch (e) {
      toast.error(messageOf(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Drawer
      open
      onOpenChange={(o) => !o && onClose()}
      width="lg"
      title={`Channels in ${connection.guildName}`}
      description="Tick the channels Growthdesk may post in. Rules then choose among them."
      actions={
        <Button size="sm" variant="ghost" icon={<RefreshCw />} loading={structure.isFetching} onClick={() => structure.refetch()}>
          Refresh
        </Button>
      }
    >
      <QueryState query={structure} loading={<SkeletonText lines={8} />}>
        {(s) => {
          const byParent = new Map<string | null, DiscordStructureChannel[]>();
          for (const c of s.channels) byParent.set(c.parentId, [...(byParent.get(c.parentId) ?? []), c]);
          const sections = [
            { id: null as string | null, name: "No category" },
            ...s.categories.map((c) => ({
              id: c.id as string | null,
              name: c.name,
            })),
          ].filter((sec) => byParent.get(sec.id)?.length);
          return (
            <div className="flex flex-col gap-4">
              {canManage && (
                <div className="flex flex-wrap items-end gap-3">
                  <Field label="Group for newly ticked channels" hint="Optional (Sales, Alerts…)." className="min-w-48 flex-1">
                    <Input value={group} onChange={(e) => setGroup(e.target.value)} maxLength={60} />
                  </Field>
                  {s.connection.permissions.manageChannels && (
                    <Button icon={<FolderPlus />} onClick={() => setCreating(true)}>
                      New channel
                    </Button>
                  )}
                </div>
              )}
              {s.hiddenCount > 0 && (
                <Callout tone="info">
                  {s.hiddenCount} {s.hiddenCount === 1 ? "channel is" : "channels are"} hidden from the bot. Give its role View channel there to list {s.hiddenCount === 1 ? "it" : "them"}.
                </Callout>
              )}
              {sections.length === 0 && <p className="text-sm text-text-3">The bot can see no text or announcement channels in this server.</p>}
              {sections.map((sec) => (
                <div key={sec.id ?? "none"} className="flex flex-col gap-1">
                  <div className="px-1 text-2xs font-semibold tracking-wide text-text-3 uppercase">{sec.name}</div>
                  <Card>
                    <ul className="divide-y divide-line">
                      {byParent.get(sec.id)!.map((c) => (
                        <li key={c.id} className="flex items-center gap-3 px-3 py-2.5">
                          <Checkbox
                            checked={Boolean(c.destinationId)}
                            onCheckedChange={() => void toggle(c)}
                            disabled={!canManage || busy !== null || (!c.destinationId && !c.canSend)}
                            aria-label={`Post in #${c.name}`}
                          />
                          <ChannelIcon kind={c.kind} />
                          <span className="min-w-0 flex-1 truncate text-sm text-text-hi">{c.name}</span>
                          {!c.canSend && <Badge tone="warn">Bot can&apos;t post</Badge>}
                          {busy === c.id && <span className="text-xs text-text-3">Saving…</span>}
                        </li>
                      ))}
                    </ul>
                  </Card>
                </div>
              ))}
              {creating && <CreateChannelModal connection={s.connection} categories={s.categories} onClose={() => setCreating(false)} />}
            </div>
          );
        }}
      </QueryState>
    </Drawer>
  );
}

function ConnectionCard({ c, destinations, configured }: { c: DiscordConnection; destinations: DiscordDestination[]; configured: boolean }) {
  const ws = useWorkspace();
  const f = useFormat();
  const canManage = ws.can("integrations.manage");
  const [channels, setChannels] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [leaveServer, setLeaveServer] = useState(true);
  const disconnect = useApiMutation<unknown, void>({
    path: ws.path(`/discord/connections/${c.id}/disconnect`),
    body: () => ({ leaveServer }),
    invalidate: [ws.key("discord")],
    success: "Discord server disconnected",
    errorToast: false,
  });
  const status = CONNECTION_STATUS[c.status];
  const missing = [!c.permissions.viewChannels && "View channels", !c.permissions.sendMessages && "Send messages", !c.permissions.embedLinks && "Embed links"].filter(Boolean);
  const mine = destinations.filter((d) => d.connectionId === c.id);

  return (
    <Card className="flex flex-col gap-3 p-4">
      <div className="flex items-start gap-3">
        {c.guildIconUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- Discord's CDN icon, 64px
          <img src={c.guildIconUrl} alt="" className="size-10 shrink-0 rounded-full" />
        ) : (
          <span aria-hidden className="flex size-10 shrink-0 items-center justify-center rounded-full bg-[#5865f2] text-sm font-semibold text-white">
            {c.guildName.charAt(0)}
          </span>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold text-text-hi">{c.guildName}</h3>
            <Badge tone={status.tone} dot>
              {status.label}
            </Badge>
          </div>
          <p className="mt-0.5 text-xs text-text-3">
            Connected {f.date(c.createdAt)} · {mine.length} {mine.length === 1 ? "channel" : "channels"}
            {c.lastCheckedAt && ` · checked ${f.relative(c.lastCheckedAt)}`}
          </p>
        </div>
        {c.status !== "disconnected" && (
          <div className="flex shrink-0 flex-wrap gap-2">
            {c.status === "connected" && (
              <Button size="sm" icon={<Hash />} onClick={() => setChannels(true)}>
                Channels
              </Button>
            )}
            {canManage && (
              <Button size="sm" variant="ghost" icon={<Unplug />} onClick={() => setDisconnecting(true)}>
                Disconnect
              </Button>
            )}
          </div>
        )}
      </div>
      {c.lastError && <Callout tone="bad">{c.lastError}</Callout>}
      {c.status === "lost" && canManage && configured && (
        <div>
          <ConnectDiscordButton label="Connect again" variant="secondary" />
        </div>
      )}
      {c.status === "connected" && missing.length > 0 && <Callout tone="warn">The bot lacks {missing.join(", ")} in this server. Grant them to its role, or nothing can be posted.</Callout>}

      {channels && <ChannelsDrawer connection={c} onClose={() => setChannels(false)} />}
      <ConfirmDialog
        open={disconnecting}
        onOpenChange={setDisconnecting}
        title={`Disconnect ${c.guildName}?`}
        description="Rules stop posting to its channels. Its channels stay listed below until you remove them, so rules keep their settings if you connect again."
        confirmLabel="Disconnect"
        onConfirm={() => disconnect.mutateAsync()}
      >
        <Checkbox checked={leaveServer} onCheckedChange={setLeaveServer} label="Also remove the bot from the server" />
      </ConfirmDialog>
    </Card>
  );
}

function DestinationRow({ d }: { d: DiscordDestination }) {
  const ws = useWorkspace();
  const f = useFormat();
  const canManage = ws.can("integrations.manage");
  const [confirm, setConfirm] = useState(false);
  const [editing, setEditing] = useState(false);
  const [group, setGroup] = useState(d.group);
  const remove = useApiMutation<unknown, void>({
    method: "DELETE",
    path: ws.path(`/discord/destinations/${d.id}`),
    invalidate: [ws.key("discord")],
    success: "Channel removed",
    errorToast: false,
  });
  const save = useApiMutation<unknown, void>({
    method: "PATCH",
    path: ws.path(`/discord/destinations/${d.id}`),
    body: () => ({ group: group.trim() }),
    invalidate: [ws.key("discord")],
    onSuccess: () => setEditing(false),
  });
  const status = DEST_STATUS[d.status];
  return (
    <li className="flex flex-wrap items-center gap-3 px-4 py-3">
      <ChannelIcon kind={d.kind} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-text-hi">#{d.name}</span>
          {d.connectionStatus !== "connected" ? (
            <Badge tone="mute" dot>
              Server {d.connectionStatus === "lost" ? "bot removed" : "disconnected"}
            </Badge>
          ) : (
            d.status !== "active" && (
              <Badge tone={status.tone} dot>
                {status.label}
              </Badge>
            )
          )}
        </div>
        <div className="text-xs text-text-3">
          {d.guildName}
          {d.categoryName && ` › ${d.categoryName}`}
          {d.lastDeliveryAt ? ` · last post ${f.relative(d.lastDeliveryAt)}` : " · nothing posted yet"}
        </div>
      </div>
      {editing ? (
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <Input value={group} onChange={(e) => setGroup(e.target.value)} maxLength={60} placeholder="Group" className="w-36" autoFocus />
          <Button size="sm" type="submit" variant="primary" loading={save.isPending}>
            Save
          </Button>
        </form>
      ) : (
        <button type="button" disabled={!canManage} onClick={() => setEditing(true)} className="text-xs text-text-2 enabled:hover:text-text-hi">
          {d.group ? <Badge quiet>{d.group}</Badge> : canManage ? "Add to group" : null}
        </button>
      )}
      {canManage && (
        <Button size="sm" variant="ghost" icon={<Trash2 />} onClick={() => setConfirm(true)} aria-label={`Remove #${d.name}`}>
          Remove
        </Button>
      )}
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={`Stop posting in #${d.name}?`}
        description="It is removed from Growthdesk's list; the channel stays in Discord. Refused while a rule or the fallback setting still uses it."
        confirmLabel="Remove"
        onConfirm={() => remove.mutateAsync()}
      />
    </li>
  );
}

/** The Servers & channels tab. */
export function DiscordServers({ overview }: { overview: DiscordOverview }) {
  const ws = useWorkspace();
  const canManage = ws.can("integrations.manage");
  const destinations = useApiQuery<DiscordDestination[]>(ws.key("discord", "destinations"), ws.path("/discord/destinations"));
  const active = overview.connections.filter((c) => c.status !== "disconnected");
  const grouped = useMemo(() => {
    const m = new Map<string, DiscordDestination[]>();
    for (const d of destinations.data ?? []) m.set(d.group, [...(m.get(d.group) ?? []), d]);
    return [...m.entries()].sort(([a], [b]) => (a === "" ? 1 : b === "" ? -1 : a.localeCompare(b)));
  }, [destinations.data]);

  const canConnect = canManage && overview.configured;
  return (
    <div className="flex flex-col gap-6">
      <DiscordBotCard overview={overview} />

      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold text-text-hi">Servers</h2>
          {canConnect && active.length > 0 && <ConnectDiscordButton label="Add server" variant="secondary" />}
        </div>
        {active.length === 0 ? (
          <Card>
            <EmptyState
              icon={<Hash />}
              tint="indigo"
              title="No Discord server connected"
              description={
                overview.configured
                  ? "Connect your team's server to post deals won, new leads, replies and other events into its channels."
                  : "Set up your bot above first, then connect your server here."
              }
              action={canConnect ? <ConnectDiscordButton /> : undefined}
            />
          </Card>
        ) : (
          active.map((c) => <ConnectionCard key={c.id} c={c} destinations={destinations.data ?? []} configured={overview.configured} />)
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold text-text-hi">Channels Growthdesk posts in</h2>
        <QueryState
          query={destinations}
          loading={<SkeletonText lines={4} />}
          isEmpty={(d) => d.length === 0}
          empty={<p className="text-sm text-text-3">None yet. Open a server&apos;s Channels and tick the ones to post in.</p>}
        >
          {() => (
            <div className="flex flex-col gap-4">
              {grouped.map(([group, rows]) => (
                <Card key={group || "none"}>
                  {grouped.length > 1 && <CardHeader title={group || "No group"} />}
                  <ul className="divide-y divide-line">
                    {rows.map((d) => (
                      <DestinationRow key={d.id} d={d} />
                    ))}
                  </ul>
                </Card>
              ))}
            </div>
          )}
        </QueryState>
      </section>
    </div>
  );
}
