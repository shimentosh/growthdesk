"use client";

import { useState, type FormEvent, type ReactNode } from "react";
import { Bot, ExternalLink, Pencil, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Card, CardBody, CardFooter, CardHeader } from "@/components/ui/Card";
import { ConfirmDialog } from "@/components/ui/Dialog";
import { Field, FormError } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { CopyValue } from "@/components/integrations/Copy";
import { messageOf } from "@/lib/api";
import { useApiMutation } from "@/lib/query";
import { useWorkspace } from "@/lib/session";
import type { DiscordOverview } from "@/lib/types/discord";

const PORTAL = "https://discord.com/developers/applications";

function Step({ n, title, children }: { n: number; title: string; children?: ReactNode }) {
  return (
    <li className="flex gap-3">
      <span aria-hidden className="flex size-6 shrink-0 items-center justify-center rounded-full bg-accent/10 text-xs font-semibold text-accent-hi">
        {n}
      </span>
      <div className="min-w-0 flex-1 pt-0.5">
        <div className="text-sm font-medium text-text-hi">{title}</div>
        {children && <div className="mt-1 flex flex-col gap-2 text-xs text-text-2">{children}</div>}
      </div>
    </li>
  );
}

/** Where to click in Discord's Developer Portal, in order. */
function SetupSteps({ redirectUri }: { redirectUri: string }) {
  return (
    <ol className="flex flex-col gap-4">
      <Step n={1} title="Create a Discord application">
        <span>
          Open the{" "}
          <a href={PORTAL} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 font-medium text-accent-hi hover:underline">
            Discord Developer Portal
            <ExternalLink aria-hidden className="size-3" />
          </a>{" "}
          → <b>New Application</b>, give it a name your team will recognise (it&apos;s the bot&apos;s name in your server) and create it.
        </span>
      </Step>
      <Step n={2} title="Copy the Client ID and Client Secret">
        <span>
          Go to <b>OAuth2</b>. Copy the <b>Client ID</b>, then <b>Reset Secret</b> and copy the <b>Client Secret</b>.
        </span>
      </Step>
      <Step n={3} title="Add this redirect">
        <span>
          Still in <b>OAuth2</b> → <b>Redirects</b> → <b>Add Redirect</b>, paste this and <b>Save Changes</b>:
        </span>
        <CopyValue value={redirectUri} label="Copy redirect" copied="Redirect copied" />
      </Step>
      <Step n={4} title="Copy the Bot Token">
        <span>
          Go to <b>Bot</b> → <b>Reset Token</b> and copy it. Optional: turn <b>Public Bot</b> off so only you can add it to servers.
        </span>
      </Step>
      <Step n={5} title="Paste the three values below and save" />
    </ol>
  );
}

function BotForm({ overview, onDone, onCancel }: { overview: DiscordOverview; onDone: () => void; onCancel?: () => void }) {
  const ws = useWorkspace();
  const own = overview.ownApp;
  const [clientId, setClientId] = useState(own?.clientId ?? "");
  const [clientSecret, setClientSecret] = useState("");
  const [botToken, setBotToken] = useState("");
  const keeps = Boolean(own && own.clientId === clientId.trim());
  const save = useApiMutation<DiscordOverview, void>({
    method: "PUT",
    path: ws.path("/discord/app"),
    body: () => ({
      clientId: clientId.trim(),
      ...(clientSecret.trim() ? { clientSecret: clientSecret.trim() } : {}),
      ...(botToken.trim() ? { botToken: botToken.trim() } : {}),
    }),
    invalidate: [ws.key("discord")],
    success: "Discord bot saved",
    errorToast: false,
    onSuccess: () => onDone(),
  });
  const fields = save.error?.fields ?? {};
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };
  const ready = /^\d{15,21}$/.test(clientId.trim()) && (keeps || (clientSecret.trim() && botToken.trim()));

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <Field label="Client ID" required error={fields.clientId} hint="OAuth2 → Client ID (the same as the Application ID).">
        <Input value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="123456789012345678" inputMode="numeric" className="font-mono" autoComplete="off" />
      </Field>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Client Secret" required={!keeps} error={fields.clientSecret} hint={keeps ? "Saved. Leave empty to keep it." : "Stored encrypted, never shown again."}>
          <Input
            type="password"
            value={clientSecret}
            onChange={(e) => setClientSecret(e.target.value)}
            placeholder={keeps ? "••••••••" : ""}
            autoComplete="new-password"
            spellCheck={false}
            className="font-mono"
          />
        </Field>
        <Field label="Bot Token" required={!keeps} error={fields.botToken} hint={keeps ? "Saved. Leave empty to keep it." : "Stored encrypted, never shown again."}>
          <Input
            type="password"
            value={botToken}
            onChange={(e) => setBotToken(e.target.value)}
            placeholder={keeps ? "••••••••" : ""}
            autoComplete="new-password"
            spellCheck={false}
            className="font-mono"
          />
        </Field>
      </div>
      <FormError error={save.error && !Object.keys(fields).length ? messageOf(save.error) : null} />
      <div className="flex justify-end gap-2">
        {onCancel && (
          <Button onClick={onCancel} disabled={save.isPending}>
            Cancel
          </Button>
        )}
        <Button type="submit" variant="primary" loading={save.isPending} disabled={!ready}>
          Save bot
        </Button>
      </div>
    </form>
  );
}

/**
 * The workspace's Discord bot. A workspace brings its own Discord application
 * (bot) — set up once here — and then connects its servers with it. When the
 * installation also offers a shared bot, using your own is optional.
 */
export function DiscordBotCard({ overview }: { overview: DiscordOverview }) {
  const ws = useWorkspace();
  const canManage = ws.can("integrations.manage");
  const own = overview.ownApp;
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const remove = useApiMutation<DiscordOverview, void>({
    method: "DELETE",
    path: ws.path("/discord/app"),
    invalidate: [ws.key("discord")],
    success: "Discord bot removed",
  });

  // Nothing set up yet: the whole guide, open.
  if (!overview.configured && !own) {
    return (
      <Card>
        <CardHeader icon={<Bot />} title="Set up your Discord bot" description="A one-time step, about two minutes. Your bot posts the notifications, under your own name and avatar." />
        <CardBody className="flex flex-col gap-5">
          {canManage ? (
            <>
              <SetupSteps redirectUri={overview.redirectUri} />
              <BotForm overview={overview} onDone={() => undefined} />
            </>
          ) : (
            <p className="text-sm text-text-2">Someone who manages integrations in this workspace sets up the bot once; then servers can be connected.</p>
          )}
        </CardBody>
      </Card>
    );
  }

  if (editing) {
    return (
      <Card>
        <CardHeader icon={<Bot />} title={own ? "Update your Discord bot" : "Use your own Discord bot"} />
        <CardBody className="flex flex-col gap-5">
          <SetupSteps redirectUri={overview.redirectUri} />
          <BotForm overview={overview} onDone={() => setEditing(false)} onCancel={() => setEditing(false)} />
        </CardBody>
      </Card>
    );
  }

  const broken = own && !overview.configured;
  return (
    <Card>
      <CardHeader
        icon={<Bot />}
        title="Your Discord bot"
        description={
          own ? (
            <>
              Your own application, Client ID <code className="font-mono">{own.clientId}</code>.
            </>
          ) : (
            "Growthdesk's shared bot. You can use your own instead, with your own name and avatar."
          )
        }
        actions={
          canManage && (
            <>
              <Button size="sm" icon={<Pencil />} onClick={() => setEditing(true)}>
                {own ? "Update" : "Use my own bot"}
              </Button>
              {own && (
                <Button size="sm" variant="ghost" icon={<Trash2 />} onClick={() => setRemoving(true)}>
                  Remove
                </Button>
              )}
            </>
          )
        }
      />
      {broken && (
        <CardBody>
          <Callout tone="bad">The saved Client Secret or Bot Token can no longer be read. Update the bot to keep posting.</Callout>
        </CardBody>
      )}
      {!broken && (
        <CardFooter className="justify-start">
          <Badge tone="ok" dot>
            Ready
          </Badge>
          <span className="text-xs text-text-3">Connect a server below with it.</span>
        </CardFooter>
      )}
      <ConfirmDialog
        open={removing}
        onOpenChange={setRemoving}
        title="Remove your Discord bot?"
        description={
          overview.platformAvailable
            ? "This workspace goes back to Growthdesk's shared bot. Disconnect your servers first — they were added with your bot."
            : "Nothing can be posted to Discord until a bot is set up again. Disconnect your servers first — they were added with this bot."
        }
        confirmLabel="Remove bot"
        onConfirm={() => remove.mutateAsync()}
      />
    </Card>
  );
}
