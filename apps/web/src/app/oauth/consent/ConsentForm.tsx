"use client";

import { useState } from "react";
import { ShieldCheck } from "lucide-react";
import { MCP_ACCESS_INFO, MCP_ACCESS_LEVELS, MCP_CONFIRMATION_MINUTES, type McpAccess } from "@growthdesk/shared";
import { AuthCard, AuthFooter } from "@/components/account/AuthFrame";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Field, FormError } from "@/components/ui/Field";
import { Select } from "@/components/ui/Select";
import { cn } from "@/lib/cn";
import { messageOf, post } from "@/lib/api";
import type { McpOAuthConsent, McpOAuthDecision } from "@/lib/types/mcp";

/**
 * Approve or deny an MCP app (claude.ai, Claude Code, Claude Desktop…): pick
 * the workspace and how far it may go. Either answer sends the browser back
 * to the app, from the URL the API returns.
 */
export function ConsentForm({ request, info }: { request: string; info: McpOAuthConsent }) {
  const levels = MCP_ACCESS_LEVELS.slice(0, MCP_ACCESS_LEVELS.indexOf(info.maxAccess) + 1);
  const firstAvailable = info.workspaces.find((w) => w.available)?.id;
  const [workspaceId, setWorkspaceId] = useState<string | undefined>(firstAvailable);
  const [access, setAccess] = useState<McpAccess>(info.defaultAccess);
  const [busy, setBusy] = useState<"approve" | "deny" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const chosen = info.workspaces.find((w) => w.id === workspaceId);

  async function decide(approve: boolean) {
    setBusy(approve ? "approve" : "deny");
    setError(null);
    try {
      const res = await post<McpOAuthDecision>("/mcp/oauth/consent", { request, approve, workspaceId: approve ? workspaceId : null, access: approve ? access : null }, { noAuthRedirect: true });
      window.location.assign(res.redirectTo);
    } catch (err) {
      setError(messageOf(err));
      setBusy(null);
    }
  }

  async function switchAccount() {
    const here = `${window.location.pathname}${window.location.search}`;
    try {
      await post("/auth/logout", undefined, { noAuthRedirect: true });
    } finally {
      window.location.assign(`/login?next=${encodeURIComponent(here)}`);
    }
  }

  const blocked = Boolean(info.problem) || !info.workspaces.some((w) => w.available);

  return (
    <AuthCard
      title={`Connect ${info.client.name} to Growthdesk`}
      description={
        <>
          Signed in as <span className="font-medium text-text-2">{info.user.email}</span>
        </>
      }
    >
      <p className="text-sm text-text">
        <span className="font-medium text-text-hi">{info.client.name}</span> wants to work in Growthdesk as you. It sees and does only what your role allows, and you can
        disconnect it any time in Settings → MCP / Claude. After you answer you'll go back to <span className="font-mono text-xs text-text-hi">{info.client.redirectHost}</span>.
      </p>

      <FormError error={error} />
      {info.problem && <Callout tone="warn">{info.problem}</Callout>}

      {info.workspaces.length === 0 ? (
        <Callout tone="warn">You aren't in any workspace yet. Create one in Growthdesk first, then connect again.</Callout>
      ) : (
        <Field label="Workspace" hint={chosen && !chosen.available ? (chosen.reason ?? undefined) : "The app works in this workspace only."}>
          <Select
            aria-label="Workspace"
            value={workspaceId}
            onValueChange={setWorkspaceId}
            options={info.workspaces.map((w) => ({ value: w.id, label: w.name, text: w.name, disabled: !w.available, description: w.available ? w.role : w.reason }))}
            placeholder="Choose a workspace"
          />
        </Field>
      )}

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-xs font-medium text-text-2">What {info.client.name} may do</legend>
        <div role="radiogroup" aria-label="Access level" className="flex flex-col gap-2">
          {levels.map((level) => (
            <button
              key={level}
              type="button"
              role="radio"
              aria-checked={access === level}
              onClick={() => setAccess(level)}
              className={cn(
                "flex items-start gap-3 rounded-md border px-3 py-2.5 text-left transition-colors",
                access === level ? "border-accent bg-accent/5" : "border-line hover:bg-ctl-hover",
              )}
            >
              <span aria-hidden className={cn("mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border", access === level ? "border-accent" : "border-line-strong")}>
                {access === level && <span className="size-2 rounded-full bg-accent" />}
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-medium text-text-hi">{MCP_ACCESS_INFO[level].label}</span>
                <span className="mt-0.5 block text-xs text-text-2">{MCP_ACCESS_INFO[level].description}</span>
              </span>
            </button>
          ))}
        </div>
        {info.maxAccess !== "send" && <p className="text-xs text-text-3">{info.client.name} asked for no more than {MCP_ACCESS_INFO[info.maxAccess].label}.</p>}
      </fieldset>

      <div className="flex items-start gap-2.5 rounded-md border border-line bg-well px-3 py-2.5 text-xs text-text-2">
        <ShieldCheck className="mt-0.5 size-4 shrink-0 text-text-3" aria-hidden />
        <span>
          Important actions — sending, launching, pausing, deleting — never happen straight away. The app shows you what it is about to do and asks; only your “yes” in the
          chat carries it out, within {MCP_CONFIRMATION_MINUTES} minutes. A Build connection can prepare them but never carry them out.
        </span>
      </div>

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button onClick={() => decide(false)} loading={busy === "deny"} disabled={busy !== null}>
          Deny
        </Button>
        <Button variant="primary" onClick={() => decide(true)} loading={busy === "approve"} disabled={busy !== null || blocked || !chosen?.available}>
          Approve
        </Button>
      </div>

      <AuthFooter>
        Not you?{" "}
        <button type="button" onClick={switchAccount} className="font-medium text-accent-hi hover:underline">
          Sign in as someone else
        </button>
      </AuthFooter>
    </AuthCard>
  );
}
