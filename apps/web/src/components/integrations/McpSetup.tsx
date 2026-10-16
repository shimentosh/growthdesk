"use client";

import type { ReactNode } from "react";
import { Badge } from "@/components/ui/Badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/Tabs";
import { CopyButton, CopyValue } from "./Copy";

/** What stands in for the token on the settings page, where the real one is no longer readable. */
export const TOKEN_PLACEHOLDER = "<your token>";

/** A copyable block of code that keeps its line breaks (config files, shell commands). */
export function Snippet({ value, label }: { value: string; label: string }) {
  return (
    <div className="flex min-w-0 items-start gap-1 rounded-sm border border-line bg-well py-1 pr-1 pl-2.5">
      <pre className="min-w-0 flex-1 overflow-x-auto py-1 font-mono text-xs whitespace-pre-wrap break-all text-text">{value}</pre>
      <CopyButton value={value} label={`Copy ${label}`} copied={`${label} copied`} />
    </div>
  );
}

/** Ready-to-paste setup for each Claude client (and Cursor), for one MCP URL and token. */
export function mcpSnippets(url: string, token: string) {
  const header = `Authorization: Bearer ${token}`;
  return {
    // OAuth: Claude Code opens the browser to sign in and choose the workspace — no token to copy.
    claudeCodeOAuth: `claude mcp add --transport http growthdesk ${url}`,
    claudeCode: `claude mcp add --transport http growthdesk ${url} --header "${header}"`,
    // Claude Desktop starts local (stdio) servers; mcp-remote bridges to the HTTP endpoint. The header
    // goes through an env var because Desktop splits arguments on spaces on some systems.
    claudeDesktop: JSON.stringify(
      {
        mcpServers: {
          growthdesk: {
            command: "npx",
            args: ["-y", "mcp-remote", url, "--header", "Authorization:${GROWTHDESK_AUTH}"],
            env: { GROWTHDESK_AUTH: `Bearer ${token}` },
          },
        },
      },
      null,
      2,
    ),
    cursor: JSON.stringify({ mcpServers: { growthdesk: { url, headers: { Authorization: `Bearer ${token}` } } } }, null, 2),
  };
}

function Heading({ children, recommended }: { children: ReactNode; recommended?: boolean }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-sm font-medium text-text-hi">{children}</span>
      {recommended && <Badge tone="ok">Recommended</Badge>}
    </div>
  );
}

/** The steps for "Add custom connector" (claude.ai, and Claude Desktop, which shares the account's connectors). */
function ConnectorSteps({ url, app }: { url: string; app: string }) {
  return (
    <>
      <ol className="flex list-decimal flex-col gap-1 pl-5 text-xs text-text-2">
        <li>
          In {app}, open <span className="font-medium text-text">Settings → Connectors</span> and choose <span className="font-medium text-text">Add custom connector</span>.
        </li>
        <li>Name it “Growthdesk” and paste the MCP server URL below. Leave the advanced OAuth fields empty.</li>
        <li>
          Click <span className="font-medium text-text">Add</span>, then <span className="font-medium text-text">Connect</span>. Growthdesk opens: sign in, choose the workspace and
          what Claude may do, and approve.
        </li>
      </ol>
      <CopyValue value={url} label="Copy URL" copied="MCP URL copied" />
    </>
  );
}

/**
 * The connection instructions, one tab per client. Signing in with Growthdesk
 * (OAuth) comes first where the client supports it — the connection then shows
 * under “Connected apps”. The token method follows: with the real token (just
 * created) its snippets are complete; on the settings page they carry a
 * placeholder to replace.
 */
export function McpSetup({ url, token }: { url: string; token: string }) {
  const s = mcpSnippets(url, token);
  const withToken = token !== TOKEN_PLACEHOLDER;
  return (
    <Tabs defaultValue={withToken ? "claude-code" : "claude-ai"}>
      <TabsList aria-label="Client">
        <TabsTrigger value="claude-ai">claude.ai</TabsTrigger>
        <TabsTrigger value="claude-code">Claude Code</TabsTrigger>
        <TabsTrigger value="claude-desktop">Claude Desktop</TabsTrigger>
        <TabsTrigger value="cursor">Cursor</TabsTrigger>
      </TabsList>
      <TabsContent value="claude-ai" className="flex flex-col gap-2">
        <Heading recommended>Connect with your Growthdesk login</Heading>
        <ConnectorSteps url={url} app="claude.ai" />
        <p className="text-xs text-text-3">
          No token to copy. claude.ai reaches Growthdesk from the internet, so this needs the public https address — it can't connect to a copy running on your own computer.
        </p>
      </TabsContent>
      <TabsContent value="claude-code" className="flex flex-col gap-3">
        <div className="flex flex-col gap-2">
          <Heading recommended={!withToken}>Sign in with Growthdesk</Heading>
          <p className="text-xs text-text-2">
            Run this once, then type <code className="font-mono">/mcp</code> in Claude Code and choose growthdesk → Authenticate. Your browser opens to sign in and pick the workspace and
            access level.
          </p>
          <Snippet value={s.claudeCodeOAuth} label="Command" />
        </div>
        <div className="flex flex-col gap-2">
          <Heading>With a token</Heading>
          <p className="text-xs text-text-2">
            {withToken ? "Or skip the browser and use this token:" : "Or create a token above and use it instead of signing in:"} then ask Claude Code something like “what's in my
            Growthdesk workspace?”.
          </p>
          <Snippet value={s.claudeCode} label="Command" />
        </div>
      </TabsContent>
      <TabsContent value="claude-desktop" className="flex flex-col gap-3">
        <div className="flex flex-col gap-2">
          <Heading recommended={!withToken}>Connect with your Growthdesk login</Heading>
          <ConnectorSteps url={url} app="Claude Desktop" />
        </div>
        <div className="flex flex-col gap-2">
          <Heading>With a token</Heading>
          <p className="text-xs text-text-2">
            Open Settings → Developer → Edit Config, add this to <code className="font-mono">claude_desktop_config.json</code> (merge it into an existing{" "}
            <code className="font-mono">mcpServers</code>), and restart Claude. Needs Node.js installed.
          </p>
          <Snippet value={s.claudeDesktop} label="Config" />
        </div>
      </TabsContent>
      <TabsContent value="cursor" className="flex flex-col gap-2">
        <p className="text-xs text-text-2">
          Add this to <code className="font-mono">~/.cursor/mcp.json</code> (or <code className="font-mono">.cursor/mcp.json</code> in a project).
        </p>
        <Snippet value={s.cursor} label="Config" />
      </TabsContent>
    </Tabs>
  );
}
